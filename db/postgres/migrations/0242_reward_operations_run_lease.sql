-- A run lease bounds how long an unattended rewards run may keep admitting,
-- signing and sending after its runner is lost. It is held in the database and
-- timed by the database, so no scheduled job has to notice the loss first.
--
-- Where reward_operations_run_lease.required is false, which is every database
-- by default, nothing below changes any behaviour. Where it is true, new HTTP
-- admissions and nonce reservations need a live lease, and storing a newly
-- signed transaction needs a live lease and a running brake. Coordinators ask
-- require_reward_run_authority_v1() before each signer call and each send.
-- Recording what was sent and what the chain did is never refused.
CREATE TABLE reward_operations_run_lease (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  required BOOLEAN NOT NULL DEFAULT FALSE,
  run_id TEXT CHECK (run_id IS NULL OR run_id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  fence BIGINT NOT NULL DEFAULT 0 CHECK (fence >= 0),
  acquired_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  absolute_deadline TIMESTAMPTZ,
  CONSTRAINT reward_operations_run_lease_shape CHECK (
    (run_id IS NULL AND acquired_at IS NULL AND expires_at IS NULL AND absolute_deadline IS NULL)
    OR (run_id IS NOT NULL AND acquired_at IS NOT NULL AND expires_at IS NOT NULL
        AND absolute_deadline IS NOT NULL)
  ),
  CONSTRAINT reward_operations_run_lease_deadline CHECK (expires_at <= absolute_deadline)
);
CREATE TABLE reward_operations_run_lease_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('acquired','renewed','released','expiry_paused')),
  run_id TEXT,
  fence BIGINT NOT NULL,
  expires_at TIMESTAMPTZ,
  absolute_deadline TIMESTAMPTZ,
  actor_role TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL
);
INSERT INTO reward_operations_run_lease(singleton) VALUES (TRUE);

-- Remove inherited default grants. Every existing nonce-table writer may read
-- the lease, never modify it; only the functions below write it.
DO $lease_permissions$
DECLARE
  table_name TEXT;
  role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'reward_operations_run_lease','reward_operations_run_lease_events'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    FOR role_name IN
      SELECT DISTINCT pg_get_userbyid(a.grantee)
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
       WHERE c.oid=to_regclass(table_name) AND a.grantee <> 0 AND a.grantee <> c.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name);
    END LOOP;
  END LOOP;
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.oid='reward_signer_nonces'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner
  LOOP
    EXECUTE format(
      'GRANT SELECT ON reward_operations_run_lease, reward_operations_run_lease_events TO %I',
      role_name
    );
  END LOOP;
END;
$lease_permissions$;

-- The row is only ever updated, its fence never goes back, and whether a lease
-- is required is not something any function here can change. A deployment that
-- owns the database sets it deliberately, in a transaction that says so.
CREATE FUNCTION guard_reward_operations_run_lease() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.fence < OLD.fence THEN
    RAISE EXCEPTION 'invalid reward run lease transition' USING ERRCODE='PR003';
  END IF;
  IF NEW.required IS DISTINCT FROM OLD.required
     AND COALESCE(current_setting('pirate.reward_run_lease_requirement_change', TRUE), '')
         <> 'deployment' THEN
    RAISE EXCEPTION 'reward run lease requirement is deployment owned' USING ERRCODE='PR003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_operations_run_lease_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_operations_run_lease
FOR EACH ROW EXECUTE FUNCTION guard_reward_operations_run_lease();
CREATE FUNCTION guard_reward_operations_run_lease_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reward run lease evidence is append-only';
END
$$;
CREATE TRIGGER reward_operations_run_lease_events_change_guard
BEFORE UPDATE OR DELETE ON reward_operations_run_lease_events
FOR EACH ROW EXECUTE FUNCTION guard_reward_operations_run_lease_event();

-- Every function and trigger that consults the lease takes its locks in one
-- order: the operations control row, then the lease row.

-- Acquired while paused; resuming stays a separate operator act. A lease is
-- live only while the database clock is before both its expiry and its
-- absolute deadline, and neither can be set past the other.
CREATE FUNCTION acquire_reward_run_lease_v1(
  requested_run_id TEXT, ttl_seconds INTEGER, max_seconds INTEGER
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  control_record reward_operations_control%ROWTYPE;
  lease_record reward_operations_run_lease%ROWTYPE;
  observed_at TIMESTAMPTZ;
  deadline TIMESTAMPTZ;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR UPDATE;
  SELECT * INTO lease_record FROM reward_operations_run_lease WHERE singleton FOR UPDATE;
  observed_at := clock_timestamp();
  IF requested_run_id IS NULL OR requested_run_id !~ '^[a-z0-9][a-z0-9-]{0,99}$'
     OR ttl_seconds IS NULL OR ttl_seconds NOT BETWEEN 30 AND 600
     OR max_seconds IS NULL OR max_seconds NOT BETWEEN ttl_seconds AND 7200 THEN
    RAISE EXCEPTION 'invalid reward run lease request' USING ERRCODE='PR003';
  END IF;
  IF control_record.paused IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'reward run lease is acquired only while operations are paused'
      USING ERRCODE='PR003';
  END IF;
  IF lease_record.run_id IS NOT NULL AND observed_at < lease_record.expires_at
     AND observed_at < lease_record.absolute_deadline THEN
    RAISE EXCEPTION 'reward run lease is held' USING ERRCODE='PR003';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reward_operations_run_lease_events WHERE run_id = requested_run_id
  ) THEN
    RAISE EXCEPTION 'reward run identifier was already used' USING ERRCODE='PR003';
  END IF;
  deadline := observed_at + make_interval(secs => max_seconds);
  UPDATE reward_operations_run_lease
     SET run_id = requested_run_id, fence = lease_record.fence + 1,
         acquired_at = observed_at,
         expires_at = LEAST(observed_at + make_interval(secs => ttl_seconds), deadline),
         absolute_deadline = deadline
   WHERE singleton
  RETURNING * INTO lease_record;
  INSERT INTO reward_operations_run_lease_events(
    event_kind, run_id, fence, expires_at, absolute_deadline, actor_role, recorded_at
  ) VALUES (
    'acquired', lease_record.run_id, lease_record.fence, lease_record.expires_at,
    lease_record.absolute_deadline, session_user, observed_at
  );
  RETURN lease_record.fence;
END
$$;

-- Never revives an expired run and never touches the brake. A superseded fence
-- is refused, so a stale or duplicated runner cannot extend a run it lost.
CREATE FUNCTION renew_reward_run_lease_v1(
  holder_run_id TEXT, holder_fence BIGINT, ttl_seconds INTEGER
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lease_record reward_operations_run_lease%ROWTYPE;
  observed_at TIMESTAMPTZ;
BEGIN
  PERFORM 1 FROM reward_operations_control WHERE singleton FOR UPDATE;
  SELECT * INTO lease_record FROM reward_operations_run_lease WHERE singleton FOR UPDATE;
  observed_at := clock_timestamp();
  IF ttl_seconds IS NULL OR ttl_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid reward run lease request' USING ERRCODE='PR003';
  END IF;
  IF lease_record.run_id IS NULL OR holder_run_id IS NULL OR holder_fence IS NULL
     OR lease_record.run_id <> holder_run_id OR lease_record.fence <> holder_fence
     OR observed_at >= lease_record.expires_at
     OR observed_at >= lease_record.absolute_deadline THEN
    RAISE EXCEPTION 'reward run lease renewal refused' USING ERRCODE='PR003';
  END IF;
  UPDATE reward_operations_run_lease
     SET fence = lease_record.fence + 1,
         expires_at = LEAST(
           observed_at + make_interval(secs => ttl_seconds), lease_record.absolute_deadline
         )
   WHERE singleton
  RETURNING * INTO lease_record;
  INSERT INTO reward_operations_run_lease_events(
    event_kind, run_id, fence, expires_at, absolute_deadline, actor_role, recorded_at
  ) VALUES (
    'renewed', lease_record.run_id, lease_record.fence, lease_record.expires_at,
    lease_record.absolute_deadline, session_user, observed_at
  );
  RETURN lease_record.fence;
END
$$;

-- Only ever shortens, so it succeeds after expiry, after the absolute deadline
-- and when repeated.
CREATE FUNCTION release_reward_run_lease_v1(
  holder_run_id TEXT, holder_fence BIGINT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lease_record reward_operations_run_lease%ROWTYPE;
  observed_at TIMESTAMPTZ;
BEGIN
  PERFORM 1 FROM reward_operations_control WHERE singleton FOR UPDATE;
  SELECT * INTO lease_record FROM reward_operations_run_lease WHERE singleton FOR UPDATE;
  observed_at := clock_timestamp();
  IF lease_record.run_id IS NULL OR holder_run_id IS NULL OR holder_fence IS NULL
     OR lease_record.run_id <> holder_run_id OR lease_record.fence <> holder_fence THEN
    RAISE EXCEPTION 'reward run lease release refused' USING ERRCODE='PR003';
  END IF;
  UPDATE reward_operations_run_lease
     SET expires_at = LEAST(lease_record.expires_at, observed_at, lease_record.absolute_deadline)
   WHERE singleton
  RETURNING * INTO lease_record;
  INSERT INTO reward_operations_run_lease_events(
    event_kind, run_id, fence, expires_at, absolute_deadline, actor_role, recorded_at
  ) VALUES (
    'released', lease_record.run_id, lease_record.fence, lease_record.expires_at,
    lease_record.absolute_deadline, session_user, observed_at
  );
END
$$;

-- The one thing automation may do: pause. It takes no argument and has no path
-- that resumes. It only makes the brake row agree with what the guards already
-- enforce, so that an operator finds it paused and must resume deliberately.
CREATE FUNCTION pause_reward_operations_on_lease_expiry_v1()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  control_record reward_operations_control%ROWTYPE;
  lease_record reward_operations_run_lease%ROWTYPE;
  observed_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR UPDATE;
  SELECT * INTO lease_record FROM reward_operations_run_lease WHERE singleton FOR UPDATE;
  observed_at := clock_timestamp();
  IF lease_record.required IS DISTINCT FROM TRUE OR control_record.paused IS DISTINCT FROM FALSE
     OR (lease_record.run_id IS NOT NULL AND observed_at < lease_record.expires_at
         AND observed_at < lease_record.absolute_deadline) THEN
    RETURN FALSE;
  END IF;
  UPDATE reward_operations_control
     SET paused = TRUE, revision = revision + 1, reason = 'reward_run_lease_expired',
         changed_at = clock_timestamp()
   WHERE singleton;
  INSERT INTO reward_operations_run_lease_events(
    event_kind, run_id, fence, expires_at, absolute_deadline, actor_role, recorded_at
  ) VALUES (
    'expiry_paused', lease_record.run_id, lease_record.fence, lease_record.expires_at,
    lease_record.absolute_deadline, session_user, observed_at
  );
  RETURN TRUE;
END
$$;

-- Asked by coordinators immediately before each signer call and each send.
-- Where a lease is required, new authority needs a live lease and a running
-- brake: a lease is acquired while paused, and must not by itself let earlier
-- effects sign or send before the operator has resumed. Where it is not
-- required this returns without reading the brake, as today.
--
-- The brake and the lease are read under shared locks, taken in the one order,
-- and the clock is read after both are held. Without that the two rows could be
-- read from different moments and authority granted for a combination that was
-- never committed. The caller completes this transaction before it signs or
-- sends: the answer authorizes the next action, it does not hold anything still.
CREATE FUNCTION require_reward_run_authority_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lease_record reward_operations_run_lease%ROWTYPE;
  operations_paused BOOLEAN;
  observed_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO lease_record FROM reward_operations_run_lease WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  IF lease_record.required IS DISTINCT FROM TRUE THEN RETURN; END IF;
  SELECT paused INTO operations_paused FROM reward_operations_control
   WHERE singleton FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  SELECT * INTO lease_record FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  observed_at := clock_timestamp();
  IF operations_paused IS DISTINCT FROM FALSE OR lease_record.run_id IS NULL
     OR observed_at >= lease_record.expires_at
     OR observed_at >= lease_record.absolute_deadline THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
END
$$;

-- Beside the brake's own guards on HTTP admission and nonce reservation, which
-- already require a running brake: where a lease is required it must be live.
CREATE FUNCTION guard_reward_run_lease_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lease_required BOOLEAN;
  lease_live BOOLEAN;
BEGIN
  SELECT required INTO lease_required FROM reward_operations_run_lease WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  IF lease_required IS DISTINCT FROM TRUE THEN RETURN NEW; END IF;
  PERFORM 1 FROM reward_operations_control WHERE singleton FOR SHARE;
  SELECT run_id IS NOT NULL AND clock_timestamp() < expires_at
         AND clock_timestamp() < absolute_deadline
    INTO lease_live FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  IF lease_live IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_run_lease_admission_guard BEFORE INSERT ON song_reward_offers
FOR EACH ROW EXECUTE FUNCTION guard_reward_run_lease_admission();
CREATE TRIGGER reward_run_lease_admission_guard BEFORE INSERT ON song_reward_offer_legs
FOR EACH ROW EXECUTE FUNCTION guard_reward_run_lease_admission();
CREATE TRIGGER reward_run_lease_admission_guard BEFORE INSERT ON song_reward_leg_funding_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_run_lease_admission();
CREATE TRIGGER reward_run_lease_nonce_insert_guard BEFORE INSERT ON reward_signer_nonces
FOR EACH ROW EXECUTE FUNCTION guard_reward_run_lease_admission();
CREATE TRIGGER reward_run_lease_nonce_advance_guard BEFORE UPDATE ON reward_signer_nonces
FOR EACH ROW WHEN (NEW.next_nonce > OLD.next_nonce)
EXECUTE FUNCTION guard_reward_run_lease_admission();

-- A backstop for the coordinators' check before signing: a newly signed
-- transaction cannot be stored as prepared without authority, and since a send
-- follows the store, it is then never sent. Every later transition is left
-- alone on purpose. Those rows record what was sent and what the chain did, and
-- refusing them after money has started to move would lose the record without
-- stopping anything.
CREATE FUNCTION guard_reward_run_lease_signature() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lease_required BOOLEAN;
  operations_paused BOOLEAN;
  lease_live BOOLEAN;
BEGIN
  SELECT required INTO lease_required FROM reward_operations_run_lease WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  IF lease_required IS DISTINCT FROM TRUE THEN RETURN NEW; END IF;
  SELECT paused INTO operations_paused FROM reward_operations_control
   WHERE singleton FOR SHARE;
  SELECT run_id IS NOT NULL AND clock_timestamp() < expires_at
         AND clock_timestamp() < absolute_deadline
    INTO lease_live FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  IF operations_paused IS DISTINCT FROM FALSE OR lease_live IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_run_lease_signature_guard BEFORE UPDATE ON reward_chain_effects
FOR EACH ROW WHEN (OLD.state = 'nonce_reserved' AND NEW.state = 'prepared')
EXECUTE FUNCTION guard_reward_run_lease_signature();

-- Only the migration owner can acquire, renew or release until a separately
-- reviewed operator grant. Runtime writer roles may pause on expiry and ask for
-- authority, and nothing else. Pin trusted schema before pg_temp.
DO $lease_function_permissions$
DECLARE
  signature TEXT;
  role_name TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'acquire_reward_run_lease_v1(text,integer,integer)',
    'renew_reward_run_lease_v1(text,bigint,integer)',
    'release_reward_run_lease_v1(text,bigint)',
    'pause_reward_operations_on_lease_expiry_v1()',
    'require_reward_run_authority_v1()',
    'guard_reward_run_lease_admission()',
    'guard_reward_run_lease_signature()',
    'guard_reward_operations_run_lease()',
    'guard_reward_operations_run_lease_event()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', signature);
    FOR role_name IN
      SELECT DISTINCT pg_get_userbyid(a.grantee)
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.oid = signature::regprocedure AND a.grantee <> 0 AND a.grantee <> p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', signature, role_name);
    END LOOP;
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO %I, pg_temp', signature, current_schema()
    );
  END LOOP;
  -- Only roles that can reserve a nonce, the runtime writers, may pause on
  -- expiry or ask for authority. A role that can merely read the nonce table
  -- gets neither.
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.oid='reward_signer_nonces'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner
       AND a.privilege_type IN ('INSERT','UPDATE')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION pause_reward_operations_on_lease_expiry_v1() TO %I', role_name
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION require_reward_run_authority_v1() TO %I', role_name
    );
  END LOOP;
END;
$lease_function_permissions$;
