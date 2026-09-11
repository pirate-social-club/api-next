-- Withdraw the readiness ownership transfer that 0141 made.
--
-- 0141 stopped the older readiness path claiming any operation with a
-- lifecycle row, on the reasoning that the lifecycle runner owns such an
-- operation. The reasoning was wrong in substance: the lifecycle runner
-- implements `observe_current` and `observe_safe` and nothing else, while the
-- legacy observation job is the readiness leg — the live DNS and gateway
-- checks that produce the readiness result and move a session to `ready`.
-- Ownership was transferred to a runner that cannot do the work, so for every
-- community operation, which always has a lifecycle row, readiness observation
-- was performed by nobody.
--
-- Found by `apps/http-worker/src/hns-community-publication.pg.test.ts`, which
-- drives the real handlers through publication and expects the readiness
-- executor to reach `ready`; it reached `idle`, because the claim it depends on
-- had been excluded. Three checkpoints ran between introducing this and
-- catching it, because everything exercised here observed the chain and
-- nothing exercised readiness.
--
-- The claim is restored to its 0128 form. The reciprocal fence stays: the
-- lifecycle runner still waits out an in-flight legacy lease before claiming
-- its own work on the same operation, which costs nothing and remains true.
-- Execution ownership is therefore unresolved rather than established, and
-- becomes a real question again only when the lifecycle can produce readiness
-- evidence itself.

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
REVOKE ALL ON FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) FROM PUBLIC;
DO $pin_readiness_claim$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_observation_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_readiness_claim$;
