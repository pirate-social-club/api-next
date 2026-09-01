-- Production authority for parent-chain root ownership and the external
-- executor's least-privilege queue boundary.

INSERT INTO hns_control_observer_configurations (
  provider_configuration_reference,
  provider_configuration_version,
  provider_configuration_digest,
  configuration_bytes
) VALUES (
  'hns-owner-production',
  'hns-owner-config-v1',
  '536c663d21e8dad2894788fb7d9a447235484f437b71426b185d2895aaa46489',
  convert_to($configuration${"version":"pirate-hns-control-observer-configuration-v1","provider_id":"hns.owner.v1","provider_configuration_reference":"hns-owner-production","provider_configuration_version":"hns-owner-config-v1","environment":"production","ownership_sources":["hns_parent_chain_txt"],"chain":{"driver_reference":"hsd-json-rpc:production-primary","network":"main","genesis_block_hash":"5b6ef2d3c1f3cdcadfd9a030ba1811efdd17740f14e166489760741d075992e0","minimum_verification_progress_millionths":999000,"maximum_tip_age_seconds":3600,"maximum_future_tip_seconds":7200,"expected_block_interval_seconds":600,"minimum_safe_remaining_blocks":144,"expiry_safety_blocks":144,"response_max_bytes":1048576},"authoritative_dns":null,"evidence_lease_seconds":2592000,"observer_deadline_ms":12000,"observer_reservation_lease_seconds":15,"snapshot_store_reference":"postgres:hns-control-observer-v1"}$configuration$, 'UTF8')
);

CREATE TABLE hns_root_import_teardown_jobs (
  teardown_job_id TEXT PRIMARY KEY,
  root_import_session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'waiting',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_fence BIGINT NOT NULL DEFAULT 0,
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT hns_root_import_teardown_jobs_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_sessions(root_import_session_id),
  CONSTRAINT hns_root_import_teardown_jobs_identity_check CHECK (
    btrim(teardown_job_id) = teardown_job_id
    AND octet_length(teardown_job_id) BETWEEN 1 AND 256
    AND teardown_job_id !~ '[[:cntrl:]]'
    AND attempt_count BETWEEN 0 AND 20
    AND lease_fence BETWEEN 0 AND 9007199254740991
    AND (
      leased_by IS NULL
      OR (
        btrim(leased_by) = leased_by
        AND octet_length(leased_by) BETWEEN 1 AND 256
        AND leased_by !~ '[[:cntrl:]]'
      )
    )
    AND (
      failure_code IS NULL
      OR (
        btrim(failure_code) = failure_code
        AND octet_length(failure_code) BETWEEN 1 AND 128
        AND failure_code !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT hns_root_import_teardown_jobs_state_check CHECK (
    state IN ('waiting', 'leased', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT hns_root_import_teardown_jobs_state_shape CHECK (
    (state = 'waiting' AND leased_by IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL)
    OR (state = 'leased' AND leased_by IS NOT NULL AND lease_expires_at IS NOT NULL
      AND failure_code IS NULL AND completed_at IS NULL)
    OR (state IN ('completed', 'cancelled') AND leased_by IS NULL
      AND lease_expires_at IS NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (state = 'failed' AND leased_by IS NULL AND lease_expires_at IS NULL
      AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT hns_root_import_teardown_jobs_time_check CHECK (
    updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE INDEX hns_root_import_teardown_jobs_claim_idx
  ON hns_root_import_teardown_jobs(state, created_at, teardown_job_id);

CREATE FUNCTION enqueue_hns_root_import_teardown_job_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO api_next, pg_catalog
AS $$
BEGIN
  IF NEW.state = 'completed' AND OLD.state <> 'completed' THEN
    INSERT INTO hns_root_import_teardown_jobs (
      teardown_job_id, root_import_session_id
    ) VALUES (
      'teardown_' || encode(sha256(convert_to(NEW.root_import_session_id, 'UTF8')), 'hex'),
      NEW.root_import_session_id
    ) ON CONFLICT (root_import_session_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_authority_provision_jobs_enqueue_teardown
AFTER UPDATE OF state ON hns_authority_provision_jobs
FOR EACH ROW EXECUTE FUNCTION enqueue_hns_root_import_teardown_job_v1();

INSERT INTO hns_root_import_teardown_jobs (teardown_job_id, root_import_session_id)
SELECT
  'teardown_' || encode(sha256(convert_to(job.root_import_session_id, 'UTF8')), 'hex'),
  job.root_import_session_id
FROM hns_authority_provision_jobs AS job
WHERE job.state = 'completed'
ON CONFLICT (root_import_session_id) DO NOTHING;

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
    JOIN hns_root_import_sessions AS expired_session
      ON expired_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count < 20
     AND (
       job.state = 'waiting'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND expired_session.status IN ('awaiting_owner_update', 'observing', 'ready')
     AND expired_session.expires_at <= database_now
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
    JOIN hns_root_import_sessions AS expired_session
      ON expired_session.root_import_session_id = job.root_import_session_id
   WHERE job.attempt_count >= 20
     AND (
       job.state = 'waiting'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND expired_session.status IN ('awaiting_owner_update', 'observing', 'ready')
     AND expired_session.expires_at <= database_now
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
    UPDATE hns_root_import_sessions AS exhausted_session
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE exhausted_session.root_import_session_id = session.root_import_session_id;
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
      OR session.status NOT IN ('awaiting_owner_update', 'observing', 'ready')
      OR session.expires_at > database_now
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
      UPDATE hns_root_import_sessions
         SET status = 'expired', revision = session.revision + 1,
             updated_at = database_now
       WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
      RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision + 1;
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
    UPDATE hns_root_import_sessions
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision + 1;
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
  SECURITY DEFINER SET search_path TO api_next, pg_catalog;
ALTER FUNCTION finalize_hns_authority_provision_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, BYTEA, TEXT, TEXT
) SECURITY DEFINER SET search_path TO api_next, pg_catalog;
ALTER FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER)
  SECURITY DEFINER SET search_path TO api_next, pg_catalog;
ALTER FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) SECURITY DEFINER SET search_path TO api_next, pg_catalog;

REVOKE ALL ON FUNCTION claim_hns_authority_provision_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_authority_provision_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_hns_root_import_teardown_job_v1() FROM PUBLIC;
