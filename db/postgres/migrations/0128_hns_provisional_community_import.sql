-- Spec 012, wallet-independent provisional HNS records amendment (2026-09-06).
-- Admission is infrastructure capacity, never namespace ownership evidence.

ALTER TABLE hns_community_root_import_preparations
  ADD COLUMN admission_kind TEXT NOT NULL DEFAULT 'name_signature'
    CHECK (admission_kind IN ('name_signature', 'community_provisional'));

CREATE INDEX hns_community_root_import_admission_actor_idx
  ON hns_community_root_import_preparations(actor_id, created_at)
  WHERE admission_kind = 'community_provisional';

-- Expiry alone cannot release a reservation after any executor attempt. Even
-- a failed HTTP response may follow a committed zone creation. Successful
-- teardown or a job that was never attempted are the only cleanup evidence.
CREATE FUNCTION hns_community_root_import_reservation_held_v1(input_session_id TEXT)
RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN session.status = 'activated' THEN FALSE
      WHEN teardown.state = 'completed' THEN FALSE
      WHEN COALESCE(session.expires_at, preparation.expires_at) > clock_timestamp() THEN TRUE
      WHEN job.provision_job_id IS NULL OR job.attempt_count = 0 THEN FALSE
      ELSE TRUE
    END
    FROM hns_community_root_import_preparations AS preparation
    LEFT JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = preparation.root_import_session_id
    LEFT JOIN hns_authority_provision_jobs AS job
      ON job.provision_job_id = preparation.provision_job_id
    LEFT JOIN hns_root_import_teardown_jobs AS teardown
      ON teardown.root_import_session_id = preparation.root_import_session_id
    WHERE preparation.root_import_session_id = input_session_id
  ), FALSE)
$$;

-- Call before taking root or community locks. The insert trigger calls it
-- again under the same transaction lock, making the limits database-owned.
CREATE FUNCTION admit_hns_community_root_import_v1(
  input_actor_id TEXT, input_community_id TEXT, input_root_label TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  database_now TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-community-provisional-admission-v1', 0));
  database_now := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1 FROM communities AS community
    WHERE community.community_id = input_community_id AND community.status = 'active'
      AND community.route_authority_version = 'optional_route_v2'
      AND community.canonical_route_binding_id IS NULL
      AND has_community_route_authority(input_community_id, input_actor_id)
  ) THEN RETURN FALSE; END IF;
  IF (SELECT count(*) FROM hns_community_root_import_preparations
      WHERE actor_id = input_actor_id AND admission_kind = 'community_provisional'
        AND created_at > database_now - interval '24 hours') >= 3
  THEN RETURN FALSE; END IF;
  IF EXISTS (
    SELECT 1 FROM hns_community_root_import_preparations AS preparation
    WHERE (community_id = input_community_id OR root_label = input_root_label)
      AND hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)
  ) THEN RETURN FALSE; END IF;
  IF (SELECT count(*) FROM hns_community_root_import_preparations AS preparation
      WHERE hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)) >= 32
  THEN RETURN FALSE; END IF;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION guard_hns_community_root_import_admission_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.admission_kind = 'community_provisional' THEN
    IF NOT admit_hns_community_root_import_v1(NEW.actor_id, NEW.community_id, NEW.root_label)
    THEN RAISE EXCEPTION 'HNS provisional admission refused'; END IF;
    -- The immutable ledger uses database time even for direct SQL callers.
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_community_root_import_preparations_admission_guard
BEFORE INSERT ON hns_community_root_import_preparations
FOR EACH ROW EXECUTE FUNCTION guard_hns_community_root_import_admission_v1();

DO $pin$
DECLARE
  installed_schema TEXT := current_schema();
  signature TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'hns_community_root_import_reservation_held_v1(text)',
    'admit_hns_community_root_import_v1(text,text,text)',
    'guard_hns_community_root_import_admission_v1()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %I, pg_temp', signature, installed_schema);
  END LOOP;
END;
$pin$;
REVOKE ALL ON FUNCTION guard_hns_community_root_import_admission_v1() FROM PUBLIC;

ALTER TABLE hns_root_import_sessions DROP CONSTRAINT hns_root_import_sessions_provision_authorization_check;
ALTER TABLE hns_root_import_sessions
  ADD CONSTRAINT hns_root_import_sessions_provision_authorization_check CHECK (
    (
      provision_authorization_kind IS NULL
      AND provision_authorization_sha256 IS NULL
    )
    OR (
      provision_authorization_kind IN ('namespace_ownership', 'hns_name_signature', 'community_provisional')
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
          provision_authorization_kind IN ('hns_name_signature', 'community_provisional')
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


CREATE OR REPLACE FUNCTION begin_hns_root_import_provision_v2(
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
     AND (
       (origin_kind = 'creation_intent' AND creation_intent_id = input_creation_intent_id)
       OR (origin_kind = 'community_attachment' AND community_id = input_creation_intent_id)
     )
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
          input_authorization_kind IN ('namespace_ownership', 'community_provisional')
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
    OR input_authorization_kind NOT IN ('namespace_ownership', 'hns_name_signature', 'community_provisional')
    OR input_authorization_sha256 !~ '^[0-9a-f]{64}$'
    OR input_provision_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_provision_request_bytes), 'hex')
       <> input_provision_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_authorization_kind = 'community_provisional' THEN
    IF session.origin_kind <> 'community_attachment'
      OR input_name_proof_result_bytes IS NOT NULL
      OR input_name_proof_message_sha256 IS NOT NULL
      OR input_name_proof_signature_sha256 IS NOT NULL
      OR NOT has_community_route_authority(session.community_id, session.actor_id)
      OR NOT EXISTS (
        SELECT 1 FROM hns_community_root_import_preparations AS preparation
        WHERE preparation.root_import_session_id = session.root_import_session_id
          AND preparation.attachment_intent_id = session.attachment_intent_id
          AND preparation.actor_id = session.actor_id
          AND preparation.community_id = session.community_id
          AND preparation.root_label = session.root_label
          AND preparation.provision_job_id = input_provision_job_id
          AND preparation.admission_kind = 'community_provisional'
          AND preparation.start_request_sha256 = input_authorization_sha256
          AND preparation.expires_at > database_now
      )
    THEN
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
  ELSIF input_authorization_kind = 'namespace_ownership' THEN
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
      OR NOT (
        (session.origin_kind = 'creation_intent' AND EXISTS (
          SELECT 1 FROM namespace_ownership_sessions AS ownership_session
           WHERE ownership_session.namespace_session_id = session.namespace_session_id
             AND ownership_session.actor_id = session.actor_id
             AND ownership_session.creation_intent_id = session.creation_intent_id
             AND ownership_session.status = 'pending'
             AND ownership_session.expires_at > database_now
        ))
        OR (session.origin_kind = 'community_attachment' AND EXISTS (
          SELECT 1 FROM community_route_attachment_namespace_sessions AS ownership_session
           WHERE ownership_session.namespace_session_id = session.namespace_session_id
             AND ownership_session.actor_id = session.actor_id
             AND ownership_session.community_id = session.community_id
             AND ownership_session.attachment_intent_id = session.attachment_intent_id
             AND ownership_session.status = 'pending'
             AND ownership_session.expires_at > database_now
        ))
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
  IF EXISTS (
    SELECT 1 FROM hns_community_root_import_preparations AS preparation
    WHERE preparation.root_label = session.root_label
      AND preparation.root_import_session_id <> session.root_import_session_id
      AND hns_community_root_import_reservation_held_v1(preparation.root_import_session_id)
  ) THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

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
       OR (
         session.provision_authorization_kind = 'community_provisional'
         AND session.ownership_result_sha256 IS NULL
         AND EXISTS (
           SELECT 1 FROM hns_community_root_import_preparations AS preparation
           WHERE preparation.root_import_session_id = session.root_import_session_id
             AND preparation.admission_kind = 'community_provisional'
             AND preparation.start_request_sha256 = session.provision_authorization_sha256
             AND preparation.actor_id = session.actor_id
             AND preparation.community_id = session.community_id
             AND preparation.provision_job_id = job.provision_job_id
         )
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


ALTER FUNCTION claim_hns_authority_provision_job_v1(TEXT, INTEGER) SECURITY DEFINER;
DO $pin_transitions$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION begin_hns_root_import_provision_v2(text,text,text,bigint,text,text,text,text,bytea,text,text,text,bytea,text) SET search_path TO %I, pg_temp', installed_schema);
  EXECUTE format('ALTER FUNCTION claim_hns_authority_provision_job_v1(text,integer) SET search_path TO %I, pg_temp', installed_schema);
END;
$pin_transitions$;

-- The existing teardown queue also owns partial provisional attempts. It is
-- inserted at the first lease, so losing the provision result cannot lose cleanup.
CREATE OR REPLACE FUNCTION enqueue_hns_root_import_teardown_job_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state = 'completed' AND OLD.state <> 'completed') OR (
    NEW.state = 'leased' AND EXISTS (
      SELECT 1 FROM hns_root_import_sessions AS session
      WHERE session.root_import_session_id = NEW.root_import_session_id
        AND session.provision_authorization_kind = 'community_provisional'
    )
  ) THEN
    INSERT INTO hns_root_import_teardown_jobs(teardown_job_id,root_import_session_id)
    VALUES ('teardown_' || encode(sha256(convert_to(NEW.root_import_session_id,'UTF8')),'hex'),NEW.root_import_session_id)
    ON CONFLICT (root_import_session_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
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
     AND EXISTS (
       SELECT 1 FROM hns_authority_provision_jobs AS retained_job
       WHERE retained_job.provision_job_id = cleanup_session.provision_job_id
         AND (retained_job.state = 'completed' OR (
           retained_job.state = 'failed'
           AND cleanup_session.provision_authorization_kind = 'community_provisional'
           AND retained_job.updated_at <= database_now - interval '2 minutes'
         ))
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
    IF provision.state <> 'completed' AND NOT (
      provision.state = 'failed' AND session.provision_authorization_kind = 'community_provisional'
    ) THEN
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
      CASE WHEN session.provision_authorization_kind = 'community_provisional'
        THEN 'teardown_provisional_root_v1' ELSE 'teardown_root_v1' END,
      provision.request_bytes, provision.request_sha256,
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
     AND EXISTS (
       SELECT 1 FROM hns_authority_provision_jobs AS retained_job
       WHERE retained_job.provision_job_id = cleanup_session.provision_job_id
         AND (retained_job.state = 'completed' OR (
           retained_job.state = 'failed'
           AND cleanup_session.provision_authorization_kind = 'community_provisional'
           AND retained_job.updated_at <= database_now - interval '2 minutes'
         ))
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


ALTER FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) SECURITY DEFINER;
DO $pin_cleanup$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION enqueue_hns_root_import_teardown_job_v1() SET search_path TO %I, pg_temp', installed_schema);
  EXECUTE format('ALTER FUNCTION claim_hns_root_import_observation_job_v1(text,integer) SET search_path TO %I, pg_temp', installed_schema);
END;
$pin_cleanup$;

-- Hold this transaction open for the bounded PowerDNS mutation. A second
-- executor, cleanup finalizer, or activation cannot advance the locked session
-- while a predecessor is between its provider read and provider write.
CREATE FUNCTION lock_hns_root_zone_mutation_v1(
  input_root_label TEXT, input_challenge_txt_value TEXT, input_teardown BOOLEAN,
  input_job_id TEXT, input_executor_id TEXT, input_lease_fence BIGINT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  retained_session hns_root_import_sessions%ROWTYPE;
  selected_session_id TEXT;
BEGIN
  SELECT root_import_session_id INTO selected_session_id
    FROM hns_root_import_sessions
    WHERE root_label=input_root_label AND challenge_txt_value=input_challenge_txt_value;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF input_teardown THEN
    PERFORM 1 FROM hns_root_import_teardown_jobs
      WHERE root_import_session_id=selected_session_id AND state='leased'
        AND teardown_job_id=input_job_id AND leased_by=input_executor_id AND lease_fence=input_lease_fence
        AND lease_expires_at>clock_timestamp() FOR UPDATE;
  ELSE
    PERFORM 1 FROM hns_authority_provision_jobs
      WHERE root_import_session_id=selected_session_id AND state='leased'
        AND provision_job_id=input_job_id AND leased_by=input_executor_id AND lease_fence=input_lease_fence
        AND lease_expires_at>clock_timestamp() FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT * INTO retained_session FROM hns_root_import_sessions
    WHERE root_import_session_id=selected_session_id FOR UPDATE;
  IF input_teardown THEN
    RETURN retained_session.provision_authorization_kind='community_provisional'
      AND (retained_session.status IN ('failed','expired') OR (
        retained_session.status IN ('awaiting_owner_update','observing','ready')
        AND retained_session.expires_at<=clock_timestamp()
      ));
  END IF;
  RETURN retained_session.status='provisioning'
    AND retained_session.expires_at>clock_timestamp();
END;
$$;
DO $pin_mutation$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION lock_hns_root_zone_mutation_v1(text,text,boolean,text,text,bigint) SET search_path TO %I, pg_temp', installed_schema);
END;
$pin_mutation$;
REVOKE ALL ON FUNCTION lock_hns_root_zone_mutation_v1(TEXT,TEXT,BOOLEAN,TEXT,TEXT,BIGINT) FROM PUBLIC;
-- The release grants this function only to the provisioner executor role.
