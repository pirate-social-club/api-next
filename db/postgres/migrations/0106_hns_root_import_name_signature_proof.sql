-- A name signature authorizes authority provisioning without pretending to be
-- durable route-ownership evidence. The retained TXT is still observed on the
-- parent chain before readiness and activation.

ALTER TABLE hns_root_import_sessions
  ADD COLUMN provision_authorization_kind TEXT,
  ADD COLUMN provision_authorization_sha256 TEXT;

UPDATE hns_root_import_sessions
   SET provision_authorization_kind = 'namespace_ownership',
       provision_authorization_sha256 = ownership_result_sha256
 WHERE ownership_result_sha256 IS NOT NULL;

ALTER TABLE hns_root_import_sessions
  ADD CONSTRAINT hns_root_import_sessions_provision_authorization_check CHECK (
    (
      provision_authorization_kind IS NULL
      AND provision_authorization_sha256 IS NULL
    )
    OR (
      provision_authorization_kind IN ('namespace_ownership', 'hns_name_signature')
      AND provision_authorization_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE hns_root_import_sessions
  DROP CONSTRAINT hns_root_import_sessions_state_shape;

ALTER TABLE hns_root_import_sessions
  ADD CONSTRAINT hns_root_import_sessions_state_shape CHECK (
    (
      status = 'awaiting_ownership'
      AND publish_plan_bytes IS NULL
      AND publish_plan_sha256 IS NULL
      AND readiness_result_bytes IS NULL
      AND readiness_result_sha256 IS NULL
      AND ownership_result_sha256 IS NULL
      AND provision_authorization_kind IS NULL
      AND provision_authorization_sha256 IS NULL
      AND provision_idempotency_key IS NULL
      AND provision_poll_request_sha256 IS NULL
      AND observation_job_id IS NULL
      AND observation_idempotency_key IS NULL
      AND observation_request_sha256 IS NULL
      AND activated_community_id IS NULL
    )
    OR (
      status IN ('provisioning', 'awaiting_owner_update')
      AND (
        (
          provision_authorization_kind = 'namespace_ownership'
          AND provision_authorization_sha256 = ownership_result_sha256
        )
        OR (
          provision_authorization_kind = 'hns_name_signature'
          AND ownership_result_sha256 IS NULL
        )
      )
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND (
        (status = 'provisioning' AND publish_plan_bytes IS NULL AND publish_plan_sha256 IS NULL)
        OR (
          status = 'awaiting_owner_update'
          AND publish_plan_bytes IS NOT NULL
          AND publish_plan_sha256 IS NOT NULL
        )
      )
      AND readiness_result_bytes IS NULL
      AND readiness_result_sha256 IS NULL
      AND observation_job_id IS NULL
      AND observation_idempotency_key IS NULL
      AND observation_request_sha256 IS NULL
      AND activated_community_id IS NULL
    )
    OR (
      status IN ('observing', 'ready', 'activated')
      AND provision_authorization_kind IS NOT NULL
      AND provision_authorization_sha256 IS NOT NULL
      AND ownership_result_sha256 IS NOT NULL
      AND publish_plan_bytes IS NOT NULL
      AND publish_plan_sha256 IS NOT NULL
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND observation_job_id IS NOT NULL
      AND observation_idempotency_key IS NOT NULL
      AND observation_request_sha256 IS NOT NULL
      AND (
        (status = 'observing' AND readiness_result_bytes IS NULL
          AND readiness_result_sha256 IS NULL AND activated_community_id IS NULL)
        OR (status = 'ready' AND readiness_result_bytes IS NOT NULL
          AND readiness_result_sha256 IS NOT NULL AND activated_community_id IS NULL)
        OR (status = 'activated' AND readiness_result_bytes IS NOT NULL
          AND readiness_result_sha256 IS NOT NULL AND activated_community_id IS NOT NULL)
      )
    )
    OR (status IN ('failed', 'expired') AND activated_community_id IS NULL)
  );

CREATE TABLE hns_root_import_name_proof_observations (
  proof_result_sha256 TEXT PRIMARY KEY,
  root_import_session_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  root_label TEXT NOT NULL,
  message_sha256 TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL,
  result_bytes BYTEA NOT NULL,
  safe BOOLEAN NOT NULL,
  verified BOOLEAN NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_root_import_name_proof_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_sessions(root_import_session_id),
  CONSTRAINT hns_root_import_name_proof_actor_fk
    FOREIGN KEY (actor_id) REFERENCES users(user_id),
  CONSTRAINT hns_root_import_name_proof_shape CHECK (
    proof_result_sha256 ~ '^[0-9a-f]{64}$'
    AND message_sha256 ~ '^[0-9a-f]{64}$'
    AND signature_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(result_bytes), 'hex') = proof_result_sha256
    AND octet_length(result_bytes) BETWEEN 1 AND 1024
    AND safe IS TRUE
    AND verified IS TRUE
    AND is_community_route_root_label('hns', root_label) IS TRUE
  )
);

CREATE TRIGGER hns_root_import_name_proof_observations_retain
BEFORE UPDATE OR DELETE ON hns_root_import_name_proof_observations
FOR EACH ROW EXECUTE FUNCTION reject_hns_authority_provision_job_delete();

CREATE FUNCTION guard_hns_root_import_provision_authorization_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provision_authorization_kind IS NOT NULL
    AND (
      NEW.provision_authorization_kind IS DISTINCT FROM OLD.provision_authorization_kind
      OR NEW.provision_authorization_sha256
           IS DISTINCT FROM OLD.provision_authorization_sha256
    )
  THEN
    RAISE EXCEPTION 'HNS root-import provisioning authority changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_root_import_sessions_provision_authorization_guard
BEFORE UPDATE ON hns_root_import_sessions
FOR EACH ROW EXECUTE FUNCTION guard_hns_root_import_provision_authorization_change();

CREATE FUNCTION begin_hns_root_import_provision_v2(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_idempotency_key TEXT,
  input_poll_request_sha256 TEXT,
  input_authorization_kind TEXT,
  input_authorization_sha256 TEXT,
  input_name_proof_result_bytes BYTEA,
  input_name_proof_message_sha256 TEXT,
  input_name_proof_signature_sha256 TEXT,
  input_provision_job_id TEXT,
  input_provision_request_bytes BYTEA,
  input_provision_request_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  proof hns_root_import_name_proof_observations%ROWTYPE;
  proof_document JSONB;
  job hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.status = 'provisioning' THEN
    SELECT * INTO job
      FROM hns_authority_provision_jobs
     WHERE provision_job_id = session.provision_job_id
     FOR SHARE;
    SELECT * INTO proof
      FROM hns_root_import_name_proof_observations
     WHERE hns_root_import_name_proof_observations.root_import_session_id =
           session.root_import_session_id
     FOR SHARE;
    IF session.provision_idempotency_key = input_idempotency_key
      AND session.provision_poll_request_sha256 = input_poll_request_sha256
      AND session.provision_authorization_kind = input_authorization_kind
      AND session.provision_authorization_sha256 = input_authorization_sha256
      AND session.provision_job_id = input_provision_job_id
      AND job.request_bytes = input_provision_request_bytes
      AND job.request_sha256 = input_provision_request_sha256
      AND (
        (
          input_authorization_kind = 'namespace_ownership'
          AND input_name_proof_result_bytes IS NULL
          AND input_name_proof_message_sha256 IS NULL
          AND input_name_proof_signature_sha256 IS NULL
        )
        OR (
          input_authorization_kind = 'hns_name_signature'
          AND proof.proof_result_sha256 = input_authorization_sha256
          AND proof.message_sha256 = input_name_proof_message_sha256
          AND proof.signature_sha256 = input_name_proof_signature_sha256
          AND proof.result_bytes = input_name_proof_result_bytes
        )
      )
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF session.status <> 'awaiting_ownership'
    OR session.revision <> input_expected_revision
    OR session.expires_at <= database_now
    OR session.provision_job_id IS DISTINCT FROM input_provision_job_id
    OR input_poll_request_sha256 !~ '^[0-9a-f]{64}$'
    OR input_authorization_kind NOT IN ('namespace_ownership', 'hns_name_signature')
    OR input_authorization_sha256 !~ '^[0-9a-f]{64}$'
    OR input_provision_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_provision_request_bytes), 'hex')
       <> input_provision_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_authorization_kind = 'namespace_ownership' THEN
    IF input_name_proof_result_bytes IS NOT NULL
      OR input_name_proof_message_sha256 IS NOT NULL
      OR input_name_proof_signature_sha256 IS NOT NULL
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    SELECT * INTO ownership_result
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = session.ceremony_intent_id
       AND namespace_session_id = session.namespace_session_id
     FOR SHARE;
    IF NOT FOUND
      OR ownership_result.outcome_status <> 'satisfied'
      OR ownership_result.result_hash <> input_authorization_sha256
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
  ELSE
    IF input_name_proof_result_bytes IS NULL
      OR octet_length(input_name_proof_result_bytes) NOT BETWEEN 1 AND 1024
      OR encode(sha256(input_name_proof_result_bytes), 'hex')
           <> input_authorization_sha256
      OR input_name_proof_message_sha256 !~ '^[0-9a-f]{64}$'
      OR input_name_proof_signature_sha256 !~ '^[0-9a-f]{64}$'
      OR NOT EXISTS (
        SELECT 1 FROM namespace_ownership_sessions AS ownership_session
         WHERE ownership_session.namespace_session_id = session.namespace_session_id
           AND ownership_session.actor_id = session.actor_id
           AND ownership_session.status = 'pending'
           AND ownership_session.expires_at > database_now
      )
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    BEGIN
      proof_document := convert_from(input_name_proof_result_bytes, 'UTF8')::JSONB;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END;
    IF jsonb_typeof(proof_document) <> 'object' THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(proof_document)) <> 6
      OR proof_document ->> 'version' <> 'pirate-hns-root-import-name-proof-result-v1'
      OR proof_document ->> 'root_label' <> session.root_label
      OR proof_document ->> 'message_sha256' <> input_name_proof_message_sha256
      OR proof_document ->> 'signature_sha256' <> input_name_proof_signature_sha256
      OR proof_document -> 'safe' <> 'true'::JSONB
      OR proof_document -> 'verified' <> 'true'::JSONB
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
  END IF;

  -- Root reservation starts only after either durable namespace ownership or
  -- an exact safe name-signature result has been verified.
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-root-import:' || session.root_label, 0));
  UPDATE hns_authority_provision_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'provisioning'
     AND stale_session.expires_at <= database_now
     AND stale_job.root_import_session_id = stale_session.root_import_session_id
     AND (
       stale_job.state = 'queued'
       OR (stale_job.state = 'leased' AND stale_job.lease_expires_at <= database_now)
     );
  UPDATE hns_root_import_observation_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'observing'
     AND stale_session.expires_at <= database_now
     AND stale_job.root_import_session_id = stale_session.root_import_session_id
     AND (
       stale_job.state = 'queued'
       OR (stale_job.state = 'leased' AND stale_job.lease_expires_at <= database_now)
     );
  UPDATE hns_root_import_sessions AS stale_session
     SET status = 'expired', revision = stale_session.revision + 1,
         updated_at = database_now
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.expires_at <= database_now
     AND (
       stale_session.status IN ('awaiting_owner_update', 'ready')
       OR (
         stale_session.status = 'provisioning'
         AND EXISTS (
           SELECT 1 FROM hns_authority_provision_jobs AS stale_job
            WHERE stale_job.root_import_session_id = stale_session.root_import_session_id
              AND stale_job.state = 'failed'
              AND stale_job.failure_code = 'session_expired'
         )
       )
       OR (
         stale_session.status = 'observing'
         AND EXISTS (
           SELECT 1 FROM hns_root_import_observation_jobs AS stale_job
            WHERE stale_job.root_import_session_id = stale_session.root_import_session_id
              AND stale_job.state = 'failed'
              AND stale_job.failure_code = 'session_expired'
         )
       )
     );
  IF EXISTS (
       SELECT 1
         FROM hns_root_import_sessions AS other
        WHERE other.root_label = session.root_label
          AND other.root_import_session_id <> session.root_import_session_id
          AND other.status IN (
            'provisioning', 'awaiting_owner_update', 'observing', 'ready', 'activated'
          )
     )
    OR EXISTS (
       SELECT 1 FROM hns_dns_zone_activation_current
        WHERE canonical_root = session.root_label
     )
    OR EXISTS (
       SELECT 1 FROM community_canonical_route_bindings
        WHERE family = 'hns' AND root_label = session.root_label
          AND route_lifecycle_status = 'active'
     )
    OR EXISTS (
       SELECT 1 FROM community_handle_sale_namespace_activation_current
        WHERE family = 'hns' AND canonical_root = session.root_label
     )
    OR EXISTS (
       SELECT 1
         FROM operator_managed_root_registry_current AS current_registry
        WHERE operator_managed_registry_has_active_root(
          current_registry.registry_reference,
          current_registry.registry_version,
          current_registry.registry_digest,
          session.root_label
        )
     )
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_authorization_kind = 'hns_name_signature' THEN
    INSERT INTO hns_root_import_name_proof_observations (
      proof_result_sha256, root_import_session_id, actor_id, root_label,
      message_sha256, signature_sha256, result_bytes, safe, verified, verified_at
    ) VALUES (
      input_authorization_sha256, session.root_import_session_id, session.actor_id,
      session.root_label, input_name_proof_message_sha256,
      input_name_proof_signature_sha256, input_name_proof_result_bytes,
      TRUE, TRUE, database_now
    );
  END IF;
  INSERT INTO hns_authority_provision_jobs (
    provision_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state
  ) VALUES (
    input_provision_job_id, session.root_import_session_id, 'provision_root_v1',
    input_provision_request_bytes, input_provision_request_sha256, 'queued'
  );
  UPDATE hns_root_import_sessions
     SET status = 'provisioning', revision = session.revision + 1,
         provision_idempotency_key = input_idempotency_key,
         provision_poll_request_sha256 = input_poll_request_sha256,
         provision_authorization_kind = input_authorization_kind,
         provision_authorization_sha256 = input_authorization_sha256,
         ownership_result_sha256 = CASE input_authorization_kind
           WHEN 'namespace_ownership' THEN input_authorization_sha256
           ELSE NULL
         END,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'provisioning'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE OR REPLACE FUNCTION begin_hns_root_import_observation_v1(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_idempotency_key TEXT,
  input_request_sha256 TEXT,
  input_ownership_result_sha256 TEXT,
  input_observation_job_id TEXT,
  input_observation_request_bytes BYTEA,
  input_observation_request_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  proof hns_root_import_name_proof_observations%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.observation_idempotency_key IS NOT NULL THEN
    IF session.observation_idempotency_key = input_idempotency_key
      AND session.observation_request_sha256 = input_request_sha256
      AND session.ownership_result_sha256 = input_ownership_result_sha256
      AND session.observation_job_id = input_observation_job_id
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF session.status <> 'awaiting_owner_update'
    OR session.revision <> input_expected_revision
    OR session.expires_at <= database_now
    OR (
      session.ownership_result_sha256 IS NOT NULL
      AND session.ownership_result_sha256 <> input_ownership_result_sha256
    )
    OR session.provision_authorization_kind IS NULL
    OR session.provision_authorization_sha256 IS NULL
    OR input_request_sha256 !~ '^[0-9a-f]{64}$'
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_observation_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_observation_request_bytes), 'hex')
       <> input_observation_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  SELECT * INTO ownership_result
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = session.ceremony_intent_id
     AND namespace_session_id = session.namespace_session_id
   FOR SHARE;
  SELECT * INTO provision
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = session.provision_job_id
   FOR SHARE;
  SELECT * INTO proof
    FROM hns_root_import_name_proof_observations
   WHERE hns_root_import_name_proof_observations.root_import_session_id =
         session.root_import_session_id
   FOR SHARE;
  IF ownership_result.ceremony_intent_id IS NULL
    OR provision.provision_job_id IS NULL
    OR ownership_result.outcome_status <> 'satisfied'
    OR ownership_result.result_hash <> input_ownership_result_sha256
    OR provision.state <> 'completed'
    OR provision.publish_plan_sha256 <> session.publish_plan_sha256
    OR (
      session.provision_authorization_kind = 'namespace_ownership'
      AND session.provision_authorization_sha256 <> input_ownership_result_sha256
    )
    OR (
      session.provision_authorization_kind = 'hns_name_signature'
      AND proof.proof_result_sha256 IS DISTINCT FROM session.provision_authorization_sha256
    )
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  INSERT INTO hns_root_import_observation_jobs (
    observation_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state
  ) VALUES (
    input_observation_job_id, session.root_import_session_id, 'observe_root_v1',
    input_observation_request_bytes, input_observation_request_sha256, 'queued'
  );
  UPDATE hns_root_import_sessions
     SET status = 'observing', revision = session.revision + 1,
         ownership_result_sha256 = input_ownership_result_sha256,
         observation_job_id = input_observation_job_id,
         observation_idempotency_key = input_idempotency_key,
         observation_request_sha256 = input_request_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'observing'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE OR REPLACE FUNCTION finalize_hns_root_import_ownership_v1(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_ownership_status TEXT,
  input_ownership_result_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  target_status TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_ownership_status NOT IN ('rejected', 'expired')
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid HNS root-import ownership finalization';
  END IF;
  target_status := CASE input_ownership_status WHEN 'expired' THEN 'expired' ELSE 'failed' END;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.status IN ('failed', 'expired') THEN
    IF session.status = target_status
      AND session.ownership_result_sha256 = input_ownership_result_sha256
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  SELECT * INTO ownership_result
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = session.ceremony_intent_id
     AND namespace_session_id = session.namespace_session_id
   FOR SHARE;
  IF session.status NOT IN ('awaiting_ownership', 'awaiting_owner_update')
    OR session.revision <> input_expected_revision
    OR session.ownership_result_sha256 IS NOT NULL
    OR ownership_result.result_hash <> input_ownership_result_sha256
    OR ownership_result.outcome_status <> target_status
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  UPDATE hns_root_import_sessions
     SET status = target_status, revision = session.revision + 1,
         ownership_result_sha256 = input_ownership_result_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT target_status, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE OR REPLACE FUNCTION claim_hns_authority_provision_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
)
RETURNS TABLE (
  provision_job_id TEXT,
  root_import_session_id TEXT,
  operation_kind TEXT,
  request_bytes BYTEA,
  request_sha256 TEXT,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  candidate hns_authority_provision_jobs%ROWTYPE;
  expired_session_record hns_root_import_sessions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN
    RAISE EXCEPTION 'invalid HNS authority provision claim';
  END IF;

  SELECT job.* INTO candidate
    FROM hns_authority_provision_jobs AS job
    JOIN hns_root_import_sessions AS expired_session
      ON expired_session.root_import_session_id = job.root_import_session_id
   WHERE (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND expired_session.status = 'provisioning'
     AND expired_session.expires_at <= database_now
   ORDER BY job.created_at, job.provision_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO expired_session_record
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id
     FOR UPDATE;
    UPDATE hns_authority_provision_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'session_expired', completed_at = database_now,
           updated_at = database_now
     WHERE job.provision_job_id = candidate.provision_job_id;
    UPDATE hns_root_import_sessions AS expired_session
       SET status = 'expired', revision = expired_session_record.revision + 1,
           updated_at = database_now
     WHERE expired_session.root_import_session_id = expired_session_record.root_import_session_id;
  END IF;

  SELECT job.* INTO candidate
    FROM hns_authority_provision_jobs AS job
    JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = job.root_import_session_id
    LEFT JOIN community_creation_ceremony_results AS ownership_result
      ON ownership_result.ceremony_intent_id = session.ceremony_intent_id
     AND ownership_result.namespace_session_id = session.namespace_session_id
    LEFT JOIN hns_root_import_name_proof_observations AS proof
      ON proof.root_import_session_id = session.root_import_session_id
   WHERE job.attempt_count < 5
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND session.status = 'provisioning'
     AND session.expires_at > database_now
     AND (
       (
         session.provision_authorization_kind = 'namespace_ownership'
         AND session.provision_authorization_sha256 = ownership_result.result_hash
         AND session.ownership_result_sha256 = ownership_result.result_hash
         AND ownership_result.outcome_status = 'satisfied'
       )
       OR (
         session.provision_authorization_kind = 'hns_name_signature'
         AND session.provision_authorization_sha256 = proof.proof_result_sha256
         AND session.ownership_result_sha256 IS NULL
         AND proof.safe IS TRUE
         AND proof.verified IS TRUE
       )
     )
   ORDER BY job.created_at, job.provision_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE hns_authority_provision_jobs AS job
     SET state = 'leased',
         attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + (input_lease_seconds * interval '1 second'),
         failure_code = NULL,
         updated_at = database_now
   WHERE job.provision_job_id = candidate.provision_job_id
  RETURNING job.provision_job_id, job.root_import_session_id,
            job.operation_kind, job.request_bytes, job.request_sha256,
            job.lease_fence, job.lease_expires_at
       INTO provision_job_id, root_import_session_id, operation_kind,
            request_bytes, request_sha256, lease_fence, lease_expires_at;
  RETURN NEXT;
END;
$$;

-- A terminal ownership result can now arrive after the authority zone was
-- provisioned. Make that terminal session immediately eligible for teardown;
-- the previous implementation only considered non-terminal sessions whose
-- session lease had expired, which would retain these zones indefinitely.
CREATE OR REPLACE FUNCTION claim_hns_root_import_observation_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
)
RETURNS TABLE (
  observation_job_id TEXT,
  root_import_session_id TEXT,
  operation_kind TEXT,
  request_bytes BYTEA,
  request_sha256 TEXT,
  publish_plan_bytes BYTEA,
  publish_plan_sha256 TEXT,
  provision_result_bytes BYTEA,
  provision_result_sha256 TEXT,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  candidate hns_root_import_observation_jobs%ROWTYPE;
  teardown hns_root_import_teardown_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN
    RAISE EXCEPTION 'invalid HNS root observation claim';
  END IF;

  SELECT job.* INTO teardown
    FROM hns_root_import_teardown_jobs AS job
    JOIN hns_root_import_sessions AS cleanup_session
      ON cleanup_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count < 20
     AND (
       job.state = 'waiting'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND (
       cleanup_session.status IN ('failed', 'expired')
       OR (
         cleanup_session.status IN ('awaiting_owner_update', 'observing', 'ready')
         AND cleanup_session.expires_at <= database_now
       )
     )
   ORDER BY job.created_at, job.teardown_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = teardown.root_import_session_id
     FOR UPDATE;
    SELECT * INTO provision
      FROM hns_authority_provision_jobs
     WHERE provision_job_id = session.provision_job_id;
    IF provision.state <> 'completed' THEN
      RAISE EXCEPTION 'HNS root teardown provision authority is unavailable';
    END IF;
    UPDATE hns_root_import_teardown_jobs AS job
       SET state = 'leased', attempt_count = teardown.attempt_count + 1,
           lease_fence = teardown.lease_fence + 1, leased_by = input_executor_id,
           lease_expires_at = database_now + input_lease_seconds * interval '1 second',
           failure_code = NULL, updated_at = database_now
     WHERE job.teardown_job_id = teardown.teardown_job_id;
    RETURN QUERY SELECT
      teardown.teardown_job_id, teardown.root_import_session_id,
      'teardown_root_v1'::TEXT, provision.request_bytes, provision.request_sha256,
      provision.publish_plan_bytes, provision.publish_plan_sha256,
      provision.result_bytes, provision.result_sha256,
      teardown.lease_fence + 1,
      database_now + input_lease_seconds * interval '1 second';
    RETURN;
  END IF;

  SELECT job.* INTO teardown
    FROM hns_root_import_teardown_jobs AS job
    JOIN hns_root_import_sessions AS cleanup_session
      ON cleanup_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count >= 20
     AND (
       job.state = 'waiting'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND (
       cleanup_session.status IN ('failed', 'expired')
       OR (
         cleanup_session.status IN ('awaiting_owner_update', 'observing', 'ready')
         AND cleanup_session.expires_at <= database_now
       )
     )
   ORDER BY job.created_at, job.teardown_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = teardown.root_import_session_id
     FOR UPDATE;
    UPDATE hns_root_import_teardown_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'zone_teardown_attempts_exhausted', completed_at = database_now,
           updated_at = database_now
     WHERE job.teardown_job_id = teardown.teardown_job_id;
    IF session.status NOT IN ('failed', 'expired') THEN
      UPDATE hns_root_import_sessions AS exhausted_session
         SET status = 'expired', revision = session.revision + 1,
             updated_at = database_now
       WHERE exhausted_session.root_import_session_id = session.root_import_session_id;
    END IF;
  END IF;

  SELECT job.* INTO candidate
    FROM hns_root_import_observation_jobs AS job
    JOIN hns_root_import_sessions AS selected_session
      ON selected_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count >= 20
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND selected_session.status = 'observing'
     AND selected_session.expires_at > database_now
   ORDER BY job.created_at, job.observation_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id
     FOR UPDATE;
    UPDATE hns_root_import_observation_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'observation_attempts_exhausted', completed_at = database_now,
           updated_at = database_now
     WHERE job.observation_job_id = candidate.observation_job_id;
    UPDATE hns_root_import_sessions AS exhausted_session
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE exhausted_session.root_import_session_id = session.root_import_session_id;
  END IF;

  SELECT job.* INTO candidate
    FROM hns_root_import_observation_jobs AS job
    JOIN hns_root_import_sessions AS selected_session
      ON selected_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count < 20
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND selected_session.status = 'observing'
     AND selected_session.expires_at > database_now
   ORDER BY job.created_at, job.observation_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id;
  SELECT * INTO provision
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = session.provision_job_id;
  IF provision.state <> 'completed' THEN
    RAISE EXCEPTION 'HNS root observation provision authority is unavailable';
  END IF;
  UPDATE hns_root_import_observation_jobs AS job
     SET state = 'leased', attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + input_lease_seconds * interval '1 second',
         failure_code = NULL, updated_at = database_now
   WHERE job.observation_job_id = candidate.observation_job_id;
  RETURN QUERY SELECT
    candidate.observation_job_id, candidate.root_import_session_id,
    candidate.operation_kind, candidate.request_bytes, candidate.request_sha256,
    provision.publish_plan_bytes, provision.publish_plan_sha256,
    provision.result_bytes, provision.result_sha256,
    candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;

CREATE OR REPLACE FUNCTION finalize_hns_root_import_observation_job_v1(
  input_observation_job_id TEXT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_request_sha256 TEXT,
  input_outcome TEXT,
  input_result_bytes BYTEA,
  input_result_sha256 TEXT,
  input_failure_code TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  job hns_root_import_observation_jobs%ROWTYPE;
  teardown hns_root_import_teardown_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_outcome NOT IN ('ready', 'retry', 'failed') THEN
    RAISE EXCEPTION 'invalid HNS root observation finalization';
  END IF;
  SELECT * INTO teardown
    FROM hns_root_import_teardown_jobs
   WHERE teardown_job_id = input_observation_job_id
   FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = teardown.root_import_session_id
     FOR UPDATE;
    SELECT * INTO provision
      FROM hns_authority_provision_jobs
     WHERE provision_job_id = session.provision_job_id
     FOR SHARE;
    IF teardown.state IN ('completed', 'failed', 'cancelled') THEN
      IF teardown.state = 'completed'
        AND input_outcome = 'failed'
        AND input_request_sha256 = provision.request_sha256
        AND input_result_bytes IS NULL
        AND input_result_sha256 IS NULL
        AND input_failure_code = 'session_expired'
      THEN
        RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
      ELSE
        RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      END IF;
      RETURN;
    END IF;
    IF teardown.state <> 'leased'
      OR teardown.leased_by <> input_executor_id
      OR teardown.lease_fence <> input_lease_fence
      OR teardown.lease_expires_at <= database_now
      OR provision.request_sha256 <> input_request_sha256
      OR NOT (
        session.status IN ('failed', 'expired')
        OR (
          session.status IN ('awaiting_owner_update', 'observing', 'ready')
          AND session.expires_at <= database_now
        )
      )
      OR input_outcome = 'ready'
      OR input_result_bytes IS NOT NULL
      OR input_result_sha256 IS NOT NULL
      OR input_failure_code IS NULL
      OR btrim(input_failure_code) <> input_failure_code
      OR octet_length(input_failure_code) NOT BETWEEN 1 AND 128
      OR input_failure_code ~ '[[:cntrl:]]'
    THEN
      RETURN QUERY SELECT 'lost'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    IF input_outcome = 'retry' AND teardown.attempt_count < 20 THEN
      UPDATE hns_root_import_teardown_jobs
         SET state = 'waiting', leased_by = NULL, lease_expires_at = NULL,
             failure_code = input_failure_code, updated_at = database_now
       WHERE teardown_job_id = input_observation_job_id;
      RETURN QUERY SELECT 'retry'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    IF input_outcome = 'failed' AND input_failure_code = 'session_expired' THEN
      UPDATE hns_root_import_teardown_jobs
         SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
             failure_code = NULL, completed_at = database_now, updated_at = database_now
       WHERE teardown_job_id = input_observation_job_id;
      UPDATE hns_root_import_observation_jobs AS observation
         SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
             failure_code = 'session_expired', completed_at = database_now,
             updated_at = database_now
       WHERE observation.root_import_session_id = session.root_import_session_id
         AND observation.state IN ('queued', 'leased');
      IF session.status NOT IN ('failed', 'expired') THEN
        UPDATE hns_root_import_sessions
           SET status = 'expired', revision = session.revision + 1,
               updated_at = database_now
         WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
        RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id,
                            session.revision + 1;
      ELSE
        RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision;
      END IF;
      RETURN;
    END IF;
    UPDATE hns_root_import_teardown_jobs
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = CASE
             WHEN teardown.attempt_count >= 20 THEN 'zone_teardown_attempts_exhausted'
             ELSE input_failure_code
           END,
           completed_at = database_now, updated_at = database_now
     WHERE teardown_job_id = input_observation_job_id;
    IF session.status NOT IN ('failed', 'expired') THEN
      UPDATE hns_root_import_sessions
         SET status = 'expired', revision = session.revision + 1,
             updated_at = database_now
       WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
      RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id,
                          session.revision + 1;
    ELSE
      RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  SELECT * INTO job
    FROM hns_root_import_observation_jobs
   WHERE observation_job_id = input_observation_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE hns_root_import_sessions.root_import_session_id = job.root_import_session_id
   FOR UPDATE;
  IF job.state IN ('completed', 'failed') THEN
    IF job.state = 'completed'
      AND input_outcome = 'ready'
      AND job.request_sha256 = input_request_sha256
      AND job.result_bytes = input_result_bytes
      AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased'
    OR job.leased_by <> input_executor_id
    OR job.lease_fence <> input_lease_fence
    OR job.lease_expires_at <= database_now
    OR job.request_sha256 <> input_request_sha256
    OR session.status <> 'observing'
    OR session.expires_at <= database_now
  THEN
    RETURN QUERY SELECT 'lost'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  IF input_outcome = 'ready' THEN
    IF input_result_bytes IS NULL
      OR input_result_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_result_bytes), 'hex') <> input_result_sha256
      OR input_failure_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid ready HNS root observation result';
    END IF;
    UPDATE hns_root_import_observation_jobs
       SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
           result_bytes = input_result_bytes, result_sha256 = input_result_sha256,
           failure_code = NULL, completed_at = database_now, updated_at = database_now
     WHERE observation_job_id = input_observation_job_id;
    UPDATE hns_root_import_sessions
       SET status = 'ready', revision = session.revision + 1,
           readiness_result_bytes = input_result_bytes,
           readiness_result_sha256 = input_result_sha256,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY SELECT 'ready'::TEXT, session.root_import_session_id, session.revision + 1;
    RETURN;
  END IF;
  IF input_result_bytes IS NOT NULL OR input_result_sha256 IS NOT NULL
    OR input_failure_code IS NULL
    OR btrim(input_failure_code) <> input_failure_code
    OR octet_length(input_failure_code) NOT BETWEEN 1 AND 128
    OR input_failure_code ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'invalid failed HNS root observation result';
  END IF;
  IF input_outcome = 'failed' OR job.attempt_count >= 20 THEN
    UPDATE hns_root_import_observation_jobs
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = CASE
             WHEN job.attempt_count >= 20 THEN 'observation_attempts_exhausted'
             ELSE input_failure_code
           END,
           completed_at = database_now, updated_at = database_now
     WHERE observation_job_id = input_observation_job_id;
    UPDATE hns_root_import_sessions
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision + 1;
  ELSE
    UPDATE hns_root_import_observation_jobs
       SET state = 'queued', leased_by = NULL, lease_expires_at = NULL,
           failure_code = input_failure_code, updated_at = database_now
     WHERE observation_job_id = input_observation_job_id;
    RETURN QUERY SELECT 'retry'::TEXT, session.root_import_session_id, session.revision;
  END IF;
END;
$$;

ALTER FUNCTION claim_hns_authority_provision_job_v1(TEXT, INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER)
  SECURITY DEFINER;
ALTER FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) SECURITY DEFINER;

DO $$
DECLARE
  installed_schema TEXT := current_schema();
  function_signature TEXT;
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'HNS name-proof migration requires a current schema';
  END IF;
  FOREACH function_signature IN ARRAY ARRAY[
    'guard_hns_root_import_provision_authorization_change()',
    'begin_hns_root_import_provision_v2(text,text,text,bigint,text,text,text,text,bytea,text,text,text,bytea,text)',
    'begin_hns_root_import_observation_v1(text,text,text,bigint,text,text,text,text,bytea,text)',
    'finalize_hns_root_import_ownership_v1(text,text,text,bigint,text,text)',
    'claim_hns_authority_provision_job_v1(text,integer)',
    'claim_hns_root_import_observation_job_v1(text,integer)',
    'finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text)'
  ]
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path TO %I, pg_temp',
      installed_schema,
      function_signature,
      installed_schema
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
