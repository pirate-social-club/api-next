-- HNS cutover execution proof.
--
-- Ratified specification: spec 012, "HNS single-owner readiness cutover"
-- acceptance (`claims_verified` must establish that the launched service
-- started, is the staged artifact, and can claim and complete controlled
-- readiness work through the single-owner path).
--
-- A compatible schema alone does not prove the service started or claimed
-- work. This migration adds:
--   * a single-row service identity record written only after the running
--     service has completed the controlled readiness probe, and
--   * the probe itself: a synthetic operation whose readiness job is leased
--     and completed by the running executor through the single-owner
--     lifecycle claim/finalize path.
-- The deployment sequence seeds the probe, starts the compatible bundle, and
-- verifies the recorded bundle digest, service version, executor identity and
-- probe outcome against the staged artifact.

CREATE TABLE hns_lifecycle_service_identity (
    service_name text PRIMARY KEY,
    service_version text NOT NULL,
    bundle_sha256 text NOT NULL,
    executor_id text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    heartbeat_at timestamp with time zone NOT NULL,
    probe_outcome text NOT NULL,
    probe_reason text,
    CONSTRAINT hns_lifecycle_service_identity_name_check CHECK (
      service_name = 'pirate-hns-authority-provisioner'
    ),
    CONSTRAINT hns_lifecycle_service_identity_version_check CHECK (
      service_version ~ '^[A-Za-z0-9._:@/-]{1,128}$'
    ),
    CONSTRAINT hns_lifecycle_service_identity_bundle_check CHECK (
      bundle_sha256 ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT hns_lifecycle_service_identity_executor_check CHECK (
      btrim(executor_id) = executor_id
      AND octet_length(executor_id) BETWEEN 1 AND 256
      AND executor_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT hns_lifecycle_service_identity_time_check CHECK (
      heartbeat_at >= started_at
    ),
    CONSTRAINT hns_lifecycle_service_identity_outcome_check CHECK (
      probe_outcome IN ('ready', 'replayed', 'failed', 'probe_absent', 'lease_conflict')
    ),
    CONSTRAINT hns_lifecycle_service_identity_reason_shape CHECK (
      probe_reason IS NULL
      OR (
        btrim(probe_reason) = probe_reason
        AND octet_length(probe_reason) BETWEEN 1 AND 128
        AND probe_reason !~ '[[:cntrl:]]'
      )
    )
);

REVOKE ALL ON TABLE hns_lifecycle_service_identity FROM PUBLIC;

-- Seeds or refreshes the controlled probe operation. The synthetic lifecycle
-- row carries no session, provider or serving authority; the readiness job is
-- a normal single-owner lifecycle job.
CREATE FUNCTION seed_hns_lifecycle_readiness_cutover_probe_v1() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  probe_session CONSTANT TEXT := 'cutover-readiness-probe';
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  INSERT INTO hns_root_import_lifecycle (
    root_import_session_id, root_label, phase, revision, generation,
    plan_exposed_at, publication_deadline_at, first_current_observation_at,
    finality_deadline_at, policy_name, policy_digest, plan_encoded_resource_sha256
  ) VALUES (
    probe_session, 'cutover-probe', 'checking_authority', 1, 1,
    database_now - interval '1 hour', database_now + interval '13 days',
    database_now - interval '2 hours', database_now + interval '22 hours',
    'hns_root_import_lifecycle_v1', 'cutover-probe', repeat('a', 64)
  )
  ON CONFLICT (root_import_session_id) DO NOTHING;

  DELETE FROM hns_root_import_lifecycle_jobs
   WHERE root_import_session_id = probe_session
     AND job_kind = 'observe_readiness'
     AND state IN ('queued', 'leased');

  INSERT INTO hns_root_import_lifecycle_jobs (
    root_import_session_id, job_kind, due_at, generation
  ) VALUES (probe_session, 'observe_readiness', database_now, 1);

  RETURN 'seeded';
END;
$$;
REVOKE ALL ON FUNCTION seed_hns_lifecycle_readiness_cutover_probe_v1() FROM PUBLIC;

-- Runs the controlled readiness probe as the named executor. It records the
-- service identity only when the real single-owner finalizer completed the
-- readiness job for this executor; every other outcome is recorded by name
-- and left for the deployment sequence to refuse.
CREATE FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(input_executor_id text, input_service_version text, input_bundle_sha256 text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  probe_session CONSTANT TEXT := 'cutover-readiness-probe';
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  probe_outcome TEXT;
  probe_reason TEXT;
  finalized RECORD;
BEGIN
  IF btrim(input_executor_id) IS DISTINCT FROM input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_service_version !~ '^[A-Za-z0-9._:@/-]{1,128}$'
    OR input_bundle_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid HNS cutover readiness probe request';
  END IF;

  SELECT * INTO job FROM hns_root_import_lifecycle_jobs
    WHERE root_import_session_id = probe_session
      AND job_kind = 'observe_readiness'
    ORDER BY lifecycle_job_id DESC LIMIT 1 FOR UPDATE;
  IF job.lifecycle_job_id IS NULL THEN
    probe_outcome := 'probe_absent';
    probe_reason := 'probe job missing';
  ELSIF job.state = 'completed' THEN
    probe_outcome := 'replayed';
    probe_reason := NULL;
  ELSIF job.state = 'queued'
    OR (job.state = 'leased' AND job.lease_expires_at <= database_now) THEN
    UPDATE hns_root_import_lifecycle_jobs
       SET state = 'leased', attempt_count = LEAST(job.attempt_count + 1, 100),
           lease_fence = job.lease_fence + 1, leased_by = input_executor_id,
           lease_expires_at = database_now + interval '30 seconds',
           failure_code = NULL, updated_at = database_now
     WHERE lifecycle_job_id = job.lifecycle_job_id
     RETURNING * INTO job;
    SELECT * INTO finalized FROM finalize_hns_root_import_lifecycle_job_v1(
      job.lifecycle_job_id, input_executor_id, job.lease_fence, 'completed', NULL
    ) AS result;
    IF finalized.outcome = 'completed' THEN
      probe_outcome := 'ready';
      probe_reason := NULL;
    ELSE
      probe_outcome := 'failed';
      probe_reason := finalized.outcome;
    END IF;
  ELSE
    probe_outcome := 'lease_conflict';
    probe_reason := 'probe job is not claimable';
  END IF;

  INSERT INTO hns_lifecycle_service_identity (
    service_name, service_version, bundle_sha256, executor_id,
    started_at, heartbeat_at, probe_outcome, probe_reason
  ) VALUES (
    'pirate-hns-authority-provisioner', input_service_version, input_bundle_sha256,
    input_executor_id, database_now, database_now, probe_outcome, probe_reason
  )
  ON CONFLICT (service_name) DO UPDATE SET
    service_version = EXCLUDED.service_version,
    bundle_sha256 = EXCLUDED.bundle_sha256,
    executor_id = EXCLUDED.executor_id,
    heartbeat_at = EXCLUDED.heartbeat_at,
    probe_outcome = EXCLUDED.probe_outcome,
    probe_reason = EXCLUDED.probe_reason;

  RETURN probe_outcome;
END;
$$;
REVOKE ALL ON FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(TEXT, TEXT, TEXT) FROM PUBLIC;
