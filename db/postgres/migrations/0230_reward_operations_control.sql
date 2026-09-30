-- Rewards admission is independent of Worker uploads. New environments start paused.
CREATE TABLE reward_operations_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reason TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 256),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reward_operations_control_events (
  revision BIGINT PRIMARY KEY CHECK (revision >= 0),
  paused BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 256),
  operator_role TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL
);
INSERT INTO reward_operations_control(singleton,paused,revision,reason)
VALUES (TRUE,TRUE,0,'environment_initially_paused');
INSERT INTO reward_operations_control_events
SELECT revision,paused,reason,'migration_owner',changed_at FROM reward_operations_control;

-- Remove inherited default grants, including runtime DELETE and TRUNCATE.
-- Every existing nonce-table writer may observe the control, never modify it.
DO $control_permissions$
DECLARE
  table_name TEXT;
  role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['reward_operations_control','reward_operations_control_events'] LOOP
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
    EXECUTE format('GRANT SELECT ON reward_operations_control, reward_operations_control_events TO %I',role_name);
  END LOOP;
END;
$control_permissions$;

CREATE FUNCTION guard_reward_operations_control() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.paused AND NEW.revision=0
     AND NEW.reason='environment_initially_paused' THEN RETURN NEW; END IF;
  IF TG_OP <> 'UPDATE' OR NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.revision <> OLD.revision+1 OR NEW.changed_at <= OLD.changed_at
     OR NEW.paused = OLD.paused THEN
    RAISE EXCEPTION 'invalid reward operations control transition' USING ERRCODE='PR002';
  END IF;
  INSERT INTO reward_operations_control_events(revision,paused,reason,operator_role,changed_at)
  VALUES(NEW.revision,NEW.paused,NEW.reason,session_user,NEW.changed_at);
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_operations_control_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_operations_control
FOR EACH ROW EXECUTE FUNCTION guard_reward_operations_control();
CREATE FUNCTION guard_reward_operations_control_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reward operations control evidence is append-only';
END
$$;
CREATE TRIGGER reward_operations_control_events_change_guard
BEFORE UPDATE OR DELETE ON reward_operations_control_events
FOR EACH ROW EXECUTE FUNCTION guard_reward_operations_control_event();

-- Only the migration owner can execute until a separately reviewed operator grant.
-- No runtime has direct UPDATE on the row or EXECUTE on this operator function.
CREATE FUNCTION set_reward_operations_paused_v1(
  expected_revision BIGINT, requested_paused BOOLEAN, operator_reason TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  control_record reward_operations_control%ROWTYPE;
BEGIN
  SELECT * INTO control_record FROM reward_operations_control WHERE singleton FOR UPDATE;
  IF NOT FOUND OR expected_revision IS NULL OR control_record.revision <> expected_revision
     OR requested_paused IS NULL OR operator_reason IS NULL
     OR octet_length(btrim(operator_reason)) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'reward operations control conflict' USING ERRCODE='PR002';
  END IF;
  IF control_record.paused = requested_paused THEN RETURN control_record.revision; END IF;
  UPDATE reward_operations_control
     SET paused=requested_paused, revision=revision+1, reason=btrim(operator_reason),
         changed_at=clock_timestamp()
   WHERE singleton;
  RETURN control_record.revision+1;
END
$$;
REVOKE ALL ON FUNCTION set_reward_operations_paused_v1(BIGINT,BOOLEAN,TEXT) FROM PUBLIC;
DO $operator_function_permissions$
DECLARE role_name TEXT;
BEGIN
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.oid='set_reward_operations_paused_v1(bigint,boolean,text)'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION set_reward_operations_paused_v1(BIGINT,BOOLEAN,TEXT) FROM %I',role_name);
  END LOOP;
END;
$operator_function_permissions$;


-- The trigger owner's rights take FOR SHARE without granting runtime UPDATE.
CREATE OR REPLACE FUNCTION guard_reward_signer_nonce() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  operations_paused BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward signer nonce fences cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.chain_id <> OLD.chain_id OR NEW.signer_address <> OLD.signer_address
    OR NEW.next_nonce < OLD.next_nonce OR NEW.fence_version <> OLD.fence_version + 1
    OR NEW.observed_block_number < OLD.observed_block_number
    OR NEW.observed_at < OLD.observed_at OR NEW.updated_at <= OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'invalid reward signer nonce fence update';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.next_nonce > OLD.next_nonce THEN
    SELECT paused INTO operations_paused FROM reward_operations_control WHERE singleton FOR SHARE;
    IF NOT FOUND OR operations_paused IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION guard_reward_signer_nonce() FROM PUBLIC;
DROP TRIGGER reward_signer_nonces_change_guard ON reward_signer_nonces;
CREATE TRIGGER reward_signer_nonces_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_signer_nonces
FOR EACH ROW EXECUTE FUNCTION guard_reward_signer_nonce();

-- Pin trusted schema before pg_temp; functions are owned by the migration principal.
DO $control_search_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION guard_reward_signer_nonce() SET search_path TO %I, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION guard_reward_operations_control() SET search_path TO %I, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION set_reward_operations_paused_v1(BIGINT,BOOLEAN,TEXT) SET search_path TO %I, pg_temp',current_schema());
END;
$control_search_paths$;
