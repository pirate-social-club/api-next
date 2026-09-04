-- Schedule and execute bounded, full-grade health observations for activated
-- self-service HNS roots. The health observation remains the sole serving
-- authority; this queue is operational state only.

CREATE TABLE hns_root_health_renewal_jobs (
  renewal_job_id TEXT PRIMARY KEY,
  root_import_session_id TEXT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  activation_generation BIGINT NOT NULL,
  expected_health_generation BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_fence BIGINT NOT NULL DEFAULT 0,
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  result_bytes BYTEA,
  result_sha256 TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT hns_root_health_renewal_jobs_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_sessions(root_import_session_id),
  CONSTRAINT hns_root_health_renewal_jobs_activation_fk
    FOREIGN KEY (dns_zone_activation_id, activation_generation)
    REFERENCES hns_dns_zone_activation_revisions(
      dns_zone_activation_id, dns_zone_activation_generation
    ),
  CONSTRAINT hns_root_health_renewal_jobs_identity_check CHECK (
    is_hns_host_persistence_identity(renewal_job_id, 256)
    AND activation_generation BETWEEN 1 AND 9007199254740991
    AND expected_health_generation BETWEEN 1 AND 9007199254740990
    AND attempt_count BETWEEN 0 AND 3
    AND lease_fence BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT hns_root_health_renewal_jobs_state_check CHECK (
    state IN ('queued', 'leased', 'completed', 'failed')
  ),
  CONSTRAINT hns_root_health_renewal_jobs_state_shape CHECK (
    (state = 'queued' AND leased_by IS NULL AND lease_expires_at IS NULL
      AND result_bytes IS NULL AND result_sha256 IS NULL AND completed_at IS NULL)
    OR (state = 'leased' AND is_hns_host_persistence_identity(leased_by, 256)
      AND lease_expires_at IS NOT NULL AND result_bytes IS NULL
      AND result_sha256 IS NULL AND failure_code IS NULL AND completed_at IS NULL)
    OR (state = 'completed' AND leased_by IS NULL AND lease_expires_at IS NULL
      AND octet_length(result_bytes) BETWEEN 1 AND 1048576
      AND result_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(result_bytes), 'hex') = result_sha256
      AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (state = 'failed' AND leased_by IS NULL AND lease_expires_at IS NULL
      AND result_bytes IS NULL AND result_sha256 IS NULL
      AND is_hns_host_persistence_identity(failure_code, 128)
      AND completed_at IS NOT NULL)
  ),
  CONSTRAINT hns_root_health_renewal_jobs_time_check CHECK (
    updated_at >= created_at AND (completed_at IS NULL OR completed_at >= created_at)
  ),
  UNIQUE (dns_zone_activation_id, activation_generation, expected_health_generation)
);

CREATE INDEX hns_root_health_renewal_jobs_claim_idx
  ON hns_root_health_renewal_jobs(state, created_at, renewal_job_id);

CREATE TABLE hns_root_health_renewal_scheduler_heartbeat (
  scheduler_id TEXT PRIMARY KEY,
  last_successful_tick_at TIMESTAMPTZ NOT NULL,
  freshness_threshold_seconds INTEGER NOT NULL,
  eligible_roots INTEGER NOT NULL,
  enqueued_roots INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_root_health_renewal_scheduler_heartbeat_identity_check CHECK (
    scheduler_id = 'hns-root-health-renewal-v1'
    AND freshness_threshold_seconds BETWEEN 60 AND 86400
    AND eligible_roots >= 0 AND enqueued_roots >= 0
  )
);

CREATE FUNCTION schedule_hns_root_health_renewals_v1(
  input_limit INTEGER,
  input_renew_when_remaining_seconds INTEGER,
  input_heartbeat_freshness_seconds INTEGER
)
RETURNS TABLE(eligible_roots INTEGER, enqueued_roots INTEGER, successful_tick_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  database_now TIMESTAMPTZ := clock_timestamp();
  eligible_count INTEGER := 0;
  inserted_count INTEGER := 0;
BEGIN
  IF input_limit NOT BETWEEN 1 AND 100
    OR input_renew_when_remaining_seconds NOT BETWEEN 3600 AND 604799
    OR input_heartbeat_freshness_seconds NOT BETWEEN 60 AND 86400
  THEN
    RAISE EXCEPTION 'invalid HNS root health renewal schedule';
  END IF;

  WITH latest_health AS (
    SELECT DISTINCT ON (health.dns_zone_activation_id, health.activation_generation)
      health.dns_zone_activation_id, health.activation_generation,
      health.health_generation, health.valid_until
    FROM hns_dns_zone_health_observations AS health
    ORDER BY health.dns_zone_activation_id, health.activation_generation,
      health.health_generation DESC
  ), eligible AS (
    SELECT activation.root_import_session_id, activation.dns_zone_activation_id,
      activation_row.current_generation AS activation_generation,
      health.health_generation
    FROM hns_root_import_activation_operations AS activation
    JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = activation.root_import_session_id
     AND session.status = 'activated'
    JOIN hns_dns_zone_activation_current AS activation_row
      ON activation_row.dns_zone_activation_id = activation.dns_zone_activation_id
    JOIN latest_health AS health
      ON health.dns_zone_activation_id = activation_row.dns_zone_activation_id
     AND health.activation_generation = activation_row.current_generation
    WHERE health.valid_until <= database_now
      + input_renew_when_remaining_seconds * interval '1 second'
      AND NOT EXISTS (
        SELECT 1 FROM hns_root_health_renewal_jobs AS existing
        WHERE existing.dns_zone_activation_id = activation_row.dns_zone_activation_id
          AND existing.activation_generation = activation_row.current_generation
          AND existing.expected_health_generation = health.health_generation
      )
    ORDER BY health.valid_until, activation.root_import_session_id
    LIMIT input_limit
    FOR UPDATE OF session SKIP LOCKED
  ), inserted AS (
    INSERT INTO hns_root_health_renewal_jobs (
      renewal_job_id, root_import_session_id, dns_zone_activation_id,
      activation_generation, expected_health_generation
    )
    SELECT
      'hns-health-renewal:' || encode(sha256(convert_to(
        eligible.dns_zone_activation_id || ':' || eligible.activation_generation::text
          || ':' || eligible.health_generation::text, 'UTF8'
      )), 'hex'),
      eligible.root_import_session_id, eligible.dns_zone_activation_id,
      eligible.activation_generation, eligible.health_generation
    FROM eligible
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT count(*)::integer FROM eligible),
    (SELECT count(*)::integer FROM inserted)
  INTO eligible_count, inserted_count;

  INSERT INTO hns_root_health_renewal_scheduler_heartbeat (
    scheduler_id, last_successful_tick_at, freshness_threshold_seconds,
    eligible_roots, enqueued_roots, updated_at
  ) VALUES (
    'hns-root-health-renewal-v1', database_now, input_heartbeat_freshness_seconds,
    eligible_count, inserted_count, database_now
  )
  ON CONFLICT (scheduler_id) DO UPDATE SET
    last_successful_tick_at = EXCLUDED.last_successful_tick_at,
    freshness_threshold_seconds = EXCLUDED.freshness_threshold_seconds,
    eligible_roots = EXCLUDED.eligible_roots,
    enqueued_roots = EXCLUDED.enqueued_roots,
    updated_at = EXCLUDED.updated_at;

  RETURN QUERY SELECT eligible_count, inserted_count, database_now;
END;
$$;

CREATE FUNCTION claim_hns_root_health_renewal_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
)
RETURNS TABLE (
  observation_job_id TEXT, root_import_session_id TEXT, operation_kind TEXT,
  request_bytes BYTEA, request_sha256 TEXT, publish_plan_bytes BYTEA,
  publish_plan_sha256 TEXT, provision_result_bytes BYTEA,
  provision_result_sha256 TEXT, lease_fence BIGINT, lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  candidate hns_root_health_renewal_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  observation hns_root_import_observation_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NOT is_hns_host_persistence_identity(input_executor_id, 256)
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN RAISE EXCEPTION 'invalid HNS root health renewal claim'; END IF;

  SELECT job.* INTO candidate
  FROM hns_root_health_renewal_jobs AS job
  JOIN hns_root_import_sessions AS selected_session
    ON selected_session.root_import_session_id = job.root_import_session_id
  WHERE job.attempt_count < 3
    AND (job.state = 'queued' OR (job.state = 'leased' AND job.lease_expires_at <= database_now))
    AND selected_session.status = 'activated'
  ORDER BY job.created_at, job.renewal_job_id
  FOR UPDATE OF job SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN
    UPDATE hns_root_health_renewal_jobs AS exhausted
      SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
          failure_code = 'renewal_attempts_exhausted', completed_at = database_now,
          updated_at = database_now
    WHERE exhausted.renewal_job_id = (
      SELECT job.renewal_job_id FROM hns_root_health_renewal_jobs AS job
      WHERE job.attempt_count >= 3
        AND (job.state = 'queued' OR (job.state = 'leased' AND job.lease_expires_at <= database_now))
      ORDER BY job.created_at, job.renewal_job_id
      FOR UPDATE SKIP LOCKED LIMIT 1
    );
    RETURN;
  END IF;

  SELECT * INTO session FROM hns_root_import_sessions
    WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id;
  SELECT * INTO provision FROM hns_authority_provision_jobs
    WHERE hns_authority_provision_jobs.root_import_session_id = candidate.root_import_session_id;
  SELECT * INTO observation FROM hns_root_import_observation_jobs
    WHERE hns_root_import_observation_jobs.root_import_session_id = candidate.root_import_session_id;
  IF provision.state <> 'completed' OR observation.state <> 'completed' THEN
    RAISE EXCEPTION 'HNS root health renewal evidence is unavailable';
  END IF;

  UPDATE hns_root_health_renewal_jobs AS job
    SET state = 'leased', attempt_count = candidate.attempt_count + 1,
        lease_fence = candidate.lease_fence + 1, leased_by = input_executor_id,
        lease_expires_at = database_now + input_lease_seconds * interval '1 second',
        failure_code = NULL, updated_at = database_now
  WHERE job.renewal_job_id = candidate.renewal_job_id;

  RETURN QUERY SELECT candidate.renewal_job_id, candidate.root_import_session_id,
    'renew_health_v1'::text, observation.request_bytes, observation.request_sha256,
    provision.publish_plan_bytes, provision.publish_plan_sha256,
    provision.result_bytes, provision.result_sha256, candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;

CREATE FUNCTION finalize_hns_root_health_renewal_job_v1(
  input_renewal_job_id TEXT, input_executor_id TEXT, input_lease_fence BIGINT,
  input_request_sha256 TEXT, input_outcome TEXT, input_result_bytes BYTEA,
  input_result_sha256 TEXT, input_failure_code TEXT
)
RETURNS TABLE(outcome TEXT, root_import_session_id TEXT, session_revision BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  job hns_root_health_renewal_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  observation hns_root_import_observation_jobs%ROWTYPE;
  result JSONB;
  remaining_seconds INTEGER;
  latest_health_generation BIGINT;
  health_outcome TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_outcome NOT IN ('ready', 'retry', 'failed') THEN
    RAISE EXCEPTION 'invalid HNS root health renewal finalization';
  END IF;
  SELECT * INTO job FROM hns_root_health_renewal_jobs
    WHERE renewal_job_id = input_renewal_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint; RETURN; END IF;
  SELECT * INTO session FROM hns_root_import_sessions
    WHERE hns_root_import_sessions.root_import_session_id = job.root_import_session_id FOR SHARE;
  SELECT * INTO observation FROM hns_root_import_observation_jobs
    WHERE hns_root_import_observation_jobs.root_import_session_id = job.root_import_session_id;

  IF job.state IN ('completed', 'failed') THEN
    IF job.state = 'completed' AND input_outcome = 'ready'
      AND observation.request_sha256 = input_request_sha256
      AND job.result_bytes = input_result_bytes AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    THEN RETURN QUERY SELECT 'replayed'::text, session.root_import_session_id, session.revision;
    ELSE RETURN QUERY SELECT 'conflict'::text, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased' OR job.leased_by <> input_executor_id
    OR job.lease_fence <> input_lease_fence OR job.lease_expires_at <= database_now
    OR observation.request_sha256 <> input_request_sha256 OR session.status <> 'activated'
  THEN RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN; END IF;

  IF input_outcome = 'ready' THEN
    IF input_result_bytes IS NULL OR input_result_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_result_bytes), 'hex') <> input_result_sha256
      OR input_failure_code IS NOT NULL
    THEN RAISE EXCEPTION 'invalid ready HNS root health renewal result'; END IF;
    BEGIN result := convert_from(input_result_bytes, 'UTF8')::jsonb;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid HNS root health renewal result bytes'; END;
    IF result->>'version' <> 'pirate-hns-root-import-readiness-result-v1'
      OR result->>'root_import_session_id' <> job.root_import_session_id
      OR result->>'namespace_session_id' <> session.namespace_session_id
      OR result->>'root_label' <> session.root_label
      OR result->>'ownership_result_sha256' <> session.ownership_result_sha256
      OR result->>'publish_plan_sha256' <> session.publish_plan_sha256
      OR result->>'provision_result_sha256' IS DISTINCT FROM (
        SELECT provision.result_sha256 FROM hns_authority_provision_jobs AS provision
        WHERE provision.root_import_session_id = job.root_import_session_id
          AND provision.state = 'completed'
      )
      OR result->>'delegation_matches' <> 'true'
      OR result->>'ds_authenticates_zone' <> 'true'
      OR result->>'retained_zone_digest_matches' <> 'true'
      OR result->>'gateway_healthy' <> 'true'
    THEN RAISE EXCEPTION 'HNS root health renewal evidence mismatch'; END IF;
    remaining_seconds := floor(extract(epoch FROM ((result->>'valid_until')::timestamptz - database_now)))::integer;
    IF (result->>'observed_at')::timestamptz > database_now + interval '60 seconds'
      OR remaining_seconds NOT BETWEEN 1 AND 604800
    THEN RAISE EXCEPTION 'HNS root health renewal evidence is stale'; END IF;
    SELECT COALESCE(max(health.health_generation), 0) INTO latest_health_generation
      FROM hns_dns_zone_health_observations AS health
      WHERE health.dns_zone_activation_id = job.dns_zone_activation_id
        AND health.activation_generation = job.activation_generation;
    IF latest_health_generation <> job.expected_health_generation THEN
      RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN;
    END IF;
    SELECT recorded.outcome INTO health_outcome FROM record_hns_dns_zone_health_v1(
      'hns-health-renewal-record:' || job.renewal_job_id,
      'hns-health-renewal-record:' || job.renewal_job_id,
      input_result_sha256, job.dns_zone_activation_id, job.activation_generation,
      job.expected_health_generation,
      'hns-root-chain:' || (result->>'chain_resource_sha256'), input_result_sha256,
      result->>'observed_zone_bytes_sha256', result->>'dnssec_keyset_reference',
      result->>'dnssec_keyset_version', result->>'gateway_deployment_reference',
      result->>'gateway_certificate_spki_sha256',
      (result->>'delegation_matches')::boolean,
      (result->>'ds_authenticates_zone')::boolean,
      (result->>'retained_zone_digest_matches')::boolean,
      (result->>'gateway_healthy')::boolean,
      remaining_seconds
    ) AS recorded;
    IF health_outcome NOT IN ('recorded', 'replayed') THEN
      RAISE EXCEPTION 'HNS root health renewal write failed';
    END IF;
    UPDATE hns_root_health_renewal_jobs SET state = 'completed', leased_by = NULL,
      lease_expires_at = NULL, result_bytes = input_result_bytes,
      result_sha256 = input_result_sha256, failure_code = NULL,
      completed_at = database_now, updated_at = database_now
    WHERE renewal_job_id = input_renewal_job_id;
    RETURN QUERY SELECT 'ready'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;

  IF input_result_bytes IS NOT NULL OR input_result_sha256 IS NOT NULL
    OR NOT is_hns_host_persistence_identity(input_failure_code, 128)
  THEN RAISE EXCEPTION 'invalid failed HNS root health renewal result'; END IF;
  IF input_outcome = 'retry' AND job.attempt_count < 3 THEN
    UPDATE hns_root_health_renewal_jobs SET state = 'queued', leased_by = NULL,
      lease_expires_at = NULL, failure_code = input_failure_code, updated_at = database_now
    WHERE renewal_job_id = input_renewal_job_id;
    RETURN QUERY SELECT 'retry'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;
  UPDATE hns_root_health_renewal_jobs SET state = 'failed', leased_by = NULL,
    lease_expires_at = NULL,
    failure_code = CASE WHEN job.attempt_count >= 3 THEN 'renewal_attempts_exhausted' ELSE input_failure_code END,
    completed_at = database_now, updated_at = database_now
  WHERE renewal_job_id = input_renewal_job_id;
  RETURN QUERY SELECT 'failed'::text, session.root_import_session_id, session.revision;
END;
$$;

CREATE TRIGGER hns_root_health_renewal_jobs_retain
BEFORE DELETE ON hns_root_health_renewal_jobs
FOR EACH ROW EXECUTE FUNCTION reject_hns_authority_provision_job_delete();

DO $$
DECLARE installed_schema TEXT := current_schema(); function_signature TEXT;
BEGIN
  IF installed_schema IS NULL THEN RAISE EXCEPTION 'HNS root health renewal migration requires a current schema'; END IF;
  FOREACH function_signature IN ARRAY ARRAY[
    'schedule_hns_root_health_renewals_v1(integer,integer,integer)',
    'claim_hns_root_health_renewal_job_v1(text,integer)',
    'finalize_hns_root_health_renewal_job_v1(text,text,bigint,text,text,bytea,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO %I, pg_temp',
      installed_schema, function_signature, installed_schema);
  END LOOP;
END;
$$;
