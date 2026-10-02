-- Wallet dispatch is a one-use permission, separate from observing a resource.
-- One database serves one configured Handshake chain. Fence by canonical root
-- across sessions: a newer session cannot revoke an older browser's permission.
CREATE TABLE hns_wallet_publication_attempts (
  attempt_id text PRIMARY KEY CHECK (octet_length(attempt_id) BETWEEN 1 AND 256),
  root_import_session_id text NOT NULL REFERENCES hns_root_import_sessions,
  community_id text NOT NULL REFERENCES communities,
  actor_id text NOT NULL REFERENCES users(user_id),
  root_label text NOT NULL CHECK (is_community_route_root_label('hns', root_label)),
  publish_plan_sha256 text NOT NULL CHECK (publish_plan_sha256 ~ '^[0-9a-f]{64}$'),
  resource_sha256 text NOT NULL CHECK (resource_sha256 ~ '^[0-9a-f]{64}$'),
  authority_generation bigint NOT NULL CHECK (authority_generation > 0),
  reservation_key text NOT NULL CHECK (octet_length(reservation_key) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN (
    'reserved','dispatch_authorized','sent','confirmed','cancelled','retry_accepted'
  )),
  dispatch_secret_sha256 text CHECK (dispatch_secret_sha256 ~ '^[0-9a-f]{64}$'),
  txid text CHECK (txid ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatch_authorized_at timestamptz,
  resolved_at timestamptz,
  qualified_finding_id bigint REFERENCES hns_root_import_recovery_findings,
  confirmation_finding_id bigint REFERENCES hns_root_import_recovery_findings,
  UNIQUE (actor_id, root_import_session_id, reservation_key),
  CHECK ((dispatch_authorized_at IS NULL) = (dispatch_secret_sha256 IS NULL)),
  CHECK ((state IN ('reserved','cancelled')) = (dispatch_authorized_at IS NULL)),
  CHECK ((state IN ('confirmed','cancelled','retry_accepted')) = (resolved_at IS NOT NULL)),
  CHECK (state NOT IN ('sent','confirmed') OR txid IS NOT NULL),
  CHECK ((state = 'confirmed') = (confirmation_finding_id IS NOT NULL))
);
CREATE UNIQUE INDEX hns_wallet_publication_unresolved_root
  ON hns_wallet_publication_attempts(root_label)
  WHERE state IN ('reserved','dispatch_authorized','sent');
CREATE INDEX hns_wallet_publication_session
  ON hns_wallet_publication_attempts(root_import_session_id, created_at DESC);
REVOKE ALL ON hns_wallet_publication_attempts FROM PUBLIC;

CREATE FUNCTION hns_wallet_publication_snapshot_v1(item hns_wallet_publication_attempts)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'attempt_id', item.attempt_id, 'root_import_session_id', item.root_import_session_id,
    'root_label', item.root_label, 'publish_plan_sha256', item.publish_plan_sha256,
    'state', item.state, 'txid', item.txid,
    'created_at', to_char(item.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'dispatch_authorized_at', to_char(item.dispatch_authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'resolved_at', to_char(item.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

-- Only retained transaction inclusion can resolve a sent attempt. A matching
-- resource alone, lifecycle activation, or an elapsed deadline cannot do so.
CREATE FUNCTION confirm_hns_wallet_publication_v1(input_finding_id bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  UPDATE hns_wallet_publication_attempts AS attempt
     SET state='confirmed', resolved_at=clock_timestamp(), confirmation_finding_id=finding.recovery_finding_id
    FROM hns_root_import_recovery_findings AS finding
   WHERE finding.recovery_finding_id=input_finding_id
     AND attempt.root_import_session_id=finding.root_import_session_id
     AND attempt.authority_generation=finding.authority_generation
     AND attempt.qualified_finding_id=finding.recovery_finding_id
     AND attempt.state='sent' AND attempt.txid=finding.inclusion_txid
     AND finding.recorded_at>=attempt.dispatch_authorized_at
     AND finding.classification='matching_authority_available'
     AND finding.covenant_resource_sha256=attempt.resource_sha256
     AND finding.plan_encoded_sha256=attempt.resource_sha256
$$;
REVOKE ALL ON FUNCTION confirm_hns_wallet_publication_v1(bigint) FROM PUBLIC;

-- The provisioner calls this only after independent safe inclusion checks.
-- An ordinary incident finding is not sufficient to resolve wallet dispatch.
CREATE FUNCTION observe_hns_wallet_publication_v1(input_finding_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE hns_wallet_publication_attempts AS attempt
     SET qualified_finding_id=finding.recovery_finding_id
    FROM hns_root_import_recovery_findings AS finding
   WHERE finding.recovery_finding_id=input_finding_id
     AND attempt.root_import_session_id=finding.root_import_session_id
     AND attempt.authority_generation=finding.authority_generation
     AND attempt.state IN ('dispatch_authorized','sent')
     AND finding.recorded_at>=attempt.dispatch_authorized_at
     AND finding.classification='matching_authority_available'
     AND finding.covenant_resource_sha256=attempt.resource_sha256
     AND finding.plan_encoded_sha256=attempt.resource_sha256;
  PERFORM confirm_hns_wallet_publication_v1(input_finding_id);
END;
$$;
REVOKE ALL ON FUNCTION observe_hns_wallet_publication_v1(bigint) FROM PUBLIC;

CREATE FUNCTION read_hns_wallet_publication_v1(input_actor text, input_community text, input_session text)
RETURNS TABLE(outcome text, attempt jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  selected hns_wallet_publication_attempts%ROWTYPE;
BEGIN
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id=input_session AND actor_id=input_actor AND community_id=input_community;
  IF NOT FOUND OR NOT has_community_route_authority(input_community,input_actor)
    OR NOT EXISTS (SELECT 1 FROM users WHERE user_id=input_actor AND status='active')
    OR NOT EXISTS (SELECT 1 FROM communities WHERE community_id=input_community AND status='active') THEN
    RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
  END IF;
  SELECT * INTO selected FROM hns_wallet_publication_attempts AS item
   WHERE item.root_label=session.root_label AND item.actor_id=input_actor AND item.community_id=input_community
     AND (item.root_import_session_id=input_session OR item.state IN ('reserved','dispatch_authorized','sent'))
   ORDER BY (item.state IN ('reserved','dispatch_authorized','sent')) DESC,item.created_at DESC,item.attempt_id
   LIMIT 1;
  RETURN QUERY SELECT 'found'::text,CASE WHEN selected.attempt_id IS NULL THEN NULL::jsonb
    ELSE hns_wallet_publication_snapshot_v1(selected) END;
END;
$$;
REVOKE ALL ON FUNCTION read_hns_wallet_publication_v1(text,text,text) FROM PUBLIC;

CREATE FUNCTION command_hns_wallet_publication_v1(
  input_actor text, input_community text, input_session text, input_attempt_id text, input_command jsonb, input_dispatch_secret text DEFAULT NULL
) RETURNS TABLE(outcome text, attempt jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  selected hns_wallet_publication_attempts%ROWTYPE;
  operation text := input_command->>'command';
  decision text;
BEGIN
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id=input_session AND actor_id=input_actor AND community_id=input_community;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  -- Hold current authority through commit, including a concurrent revocation.
  PERFORM 1 FROM communities community
    JOIN community_route_authority_grants grant_row ON grant_row.community_id=community.community_id
    JOIN users actor ON actor.user_id=grant_row.principal_user_id
   WHERE community.community_id=input_community AND community.status='active'
     AND actor.user_id=input_actor AND actor.status='active'
     AND grant_row.authority='manage_routes' AND grant_row.status='active'
   FOR SHARE OF community,grant_row,actor;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-root-import:' || session.root_label,0));
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle WHERE root_import_session_id=input_session FOR UPDATE;
  SELECT * INTO session FROM hns_root_import_sessions WHERE root_import_session_id=input_session FOR UPDATE;
  IF session.actor_id IS DISTINCT FROM input_actor OR session.community_id IS DISTINCT FROM input_community THEN
    RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
  END IF;
  IF operation IN ('reserve','authorize_dispatch') THEN
    IF session.publish_plan_sha256 IS DISTINCT FROM input_command->>'publish_plan_sha256'
      OR session.revision IS DISTINCT FROM (input_command->>'expected_revision')::bigint
      OR lifecycle.plan_encoded_resource_sha256 IS NULL
      OR NOT hns_root_import_publication_window_open_v1(input_session) THEN
      RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN;
    END IF;
  END IF;
  IF operation='reserve' THEN
    SELECT * INTO selected FROM hns_wallet_publication_attempts
     WHERE actor_id=input_actor AND root_import_session_id=input_session
       AND reservation_key=input_command->>'idempotency_key';
    IF FOUND THEN
      IF selected.publish_plan_sha256 IS DISTINCT FROM session.publish_plan_sha256 THEN
        RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN;
      END IF;
      RETURN QUERY SELECT 'replayed'::text,hns_wallet_publication_snapshot_v1(selected); RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM hns_wallet_publication_attempts
       WHERE root_label=session.root_label AND state IN ('reserved','dispatch_authorized','sent')) THEN
      RETURN QUERY SELECT 'publication_unresolved'::text,NULL::jsonb; RETURN;
    END IF;
    INSERT INTO hns_wallet_publication_attempts (
      attempt_id,root_import_session_id,community_id,actor_id,root_label,publish_plan_sha256,
      resource_sha256,authority_generation,reservation_key,state
    ) VALUES (
      input_attempt_id,input_session,input_community,input_actor,session.root_label,session.publish_plan_sha256,
      lifecycle.plan_encoded_resource_sha256,lifecycle.generation,input_command->>'idempotency_key','reserved'
    ) RETURNING * INTO selected;
    RETURN QUERY SELECT 'reserved'::text,hns_wallet_publication_snapshot_v1(selected); RETURN;
  END IF;
  SELECT * INTO selected FROM hns_wallet_publication_attempts
   WHERE attempt_id=input_command->>'attempt_id' AND root_import_session_id=input_session
     AND actor_id=input_actor AND community_id=input_community FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  CASE operation
    WHEN 'authorize_dispatch' THEN
      IF selected.state IN ('dispatch_authorized','sent','confirmed','retry_accepted') THEN
        RETURN QUERY SELECT 'already_authorized'::text,hns_wallet_publication_snapshot_v1(selected); RETURN;
      END IF;
      IF selected.state<>'reserved'
        OR selected.authority_generation<>lifecycle.generation
        OR selected.publish_plan_sha256 IS DISTINCT FROM session.publish_plan_sha256
        OR selected.resource_sha256 IS DISTINCT FROM lifecycle.plan_encoded_resource_sha256 THEN
        RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN;
      END IF;
      IF input_dispatch_secret IS NULL OR input_dispatch_secret !~ '^[0-9a-f]{64}$' THEN
        RETURN QUERY SELECT 'invalid_command'::text,NULL::jsonb; RETURN;
      END IF;
      UPDATE hns_wallet_publication_attempts SET state='dispatch_authorized',dispatch_authorized_at=clock_timestamp(),
        dispatch_secret_sha256=encode(sha256(convert_to(input_dispatch_secret,'UTF8')),'hex')
       WHERE attempt_id=selected.attempt_id RETURNING * INTO selected;
      decision := 'dispatch_authorized';
    WHEN 'cancel' THEN
      IF selected.state NOT IN ('reserved','cancelled') THEN
        RETURN QUERY SELECT 'publication_unresolved'::text,NULL::jsonb; RETURN;
      END IF;
      UPDATE hns_wallet_publication_attempts SET state='cancelled',resolved_at=COALESCE(resolved_at,clock_timestamp())
       WHERE attempt_id=selected.attempt_id RETURNING * INTO selected;
      decision := 'cancelled';
    WHEN 'report_txid' THEN
      -- The same owner on another device cannot retire a paused dispatch by
      -- reporting a manual transaction. Only the winning response holds this.
      IF selected.dispatch_secret_sha256 IS NULL OR selected.dispatch_secret_sha256 IS DISTINCT FROM
        encode(sha256(convert_to(input_command->>'dispatch_secret','UTF8')),'hex') THEN
        RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN;
      END IF;
      IF selected.state NOT IN ('dispatch_authorized','sent','confirmed')
        OR (selected.txid IS NOT NULL AND selected.txid IS DISTINCT FROM input_command->>'txid') THEN
        RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN;
      END IF;
      IF selected.state<>'confirmed' THEN
        UPDATE hns_wallet_publication_attempts SET state='sent',txid=input_command->>'txid'
         WHERE attempt_id=selected.attempt_id RETURNING * INTO selected;
        -- The wallet report may follow an independently qualified inclusion.
        PERFORM confirm_hns_wallet_publication_v1(selected.qualified_finding_id);
        SELECT * INTO selected FROM hns_wallet_publication_attempts WHERE attempt_id=selected.attempt_id;
      END IF;
      decision := 'reported';
    WHEN 'accept_retry' THEN
      IF input_command->'accept_duplicate_or_late_publication' IS DISTINCT FROM 'true'::jsonb
        OR selected.state NOT IN ('dispatch_authorized','sent','retry_accepted') THEN
        RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN;
      END IF;
      UPDATE hns_wallet_publication_attempts SET state='retry_accepted',resolved_at=COALESCE(resolved_at,clock_timestamp())
       WHERE attempt_id=selected.attempt_id RETURNING * INTO selected;
      decision := 'retry_accepted';
    ELSE RETURN QUERY SELECT 'invalid_command'::text,NULL::jsonb; RETURN;
  END CASE;
  RETURN QUERY SELECT decision,hns_wallet_publication_snapshot_v1(selected);
END;
$$;
REVOKE ALL ON FUNCTION command_hns_wallet_publication_v1(text,text,text,text,jsonb,text) FROM PUBLIC;

-- Pin definer lookups to the owning schema before pg_temp. Default privileges
-- must not give existing application logins direct writes to the new ledger.
DO $$
DECLARE routine regprocedure; role_name text;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname IN (
      'confirm_hns_wallet_publication_v1','observe_hns_wallet_publication_v1',
      'read_hns_wallet_publication_v1','command_hns_wallet_publication_v1'
    )
  LOOP EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp',routine,current_schema()); END LOOP;
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE c.oid='hns_wallet_publication_attempts'::regclass AND acl.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON hns_wallet_publication_attempts FROM %I',role_name); END LOOP;
END;
$$;
