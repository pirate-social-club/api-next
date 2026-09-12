-- HNS cutover evidence consistency.
--
-- Review corrections: startup evidence, probe safety, renewal consistency and
-- the canonical request encoding. This is the reviewed cutover endpoint.

-- Migration 0171 created the three-argument probe before attempt binding
-- existed; its body reads the dropped `heartbeat_at` column. Replace it with
-- the six-argument attempt-bound form rather than leaving a callable overload
-- whose signature and body both describe the removed identity record.
DROP FUNCTION IF EXISTS run_hns_lifecycle_readiness_cutover_probe_v1(TEXT, TEXT, TEXT);

ALTER TABLE hns_lifecycle_service_identity
  RENAME COLUMN started_at TO process_started_at;
ALTER TABLE hns_lifecycle_service_identity
  DROP COLUMN heartbeat_at;
ALTER TABLE hns_lifecycle_service_identity
  ADD COLUMN attempt_id text,
  ADD COLUMN probe_job_id bigint,
  ADD COLUMN lease_fence bigint,
  ADD COLUMN expected_bundle_sha256 text,
  ADD COLUMN measured_bundle_sha256 text,
  ADD COLUMN probe_completed_at timestamp with time zone;
ALTER TABLE hns_lifecycle_service_identity
  ADD CONSTRAINT hns_lifecycle_service_identity_attempt_shape CHECK (
    attempt_id IS NULL
    OR (btrim(attempt_id) = attempt_id
        AND octet_length(attempt_id) BETWEEN 8 AND 128
        AND attempt_id ~ '^[A-Za-z0-9._:-]+$')
  ),
  ADD CONSTRAINT hns_lifecycle_service_identity_expected_bundle_shape CHECK (
    expected_bundle_sha256 IS NULL OR expected_bundle_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT hns_lifecycle_service_identity_measured_bundle_shape CHECK (
    measured_bundle_sha256 IS NULL OR measured_bundle_sha256 ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE hns_root_import_lifecycle
  ADD COLUMN synthetic boolean DEFAULT false NOT NULL;
CREATE INDEX hns_root_import_lifecycle_operational_idx
  ON hns_root_import_lifecycle (phase)
  WHERE NOT synthetic;

-- One canonical encoding for the readiness observation request.
CREATE FUNCTION encode_hns_root_readiness_observation_request_v1(input_session_id text) RETURNS TABLE(request_bytes bytea, request_sha256 text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  encoded TEXT;
BEGIN
  IF input_session_id IS NULL OR btrim(input_session_id) IS DISTINCT FROM input_session_id
  THEN RAISE EXCEPTION 'invalid HNS readiness request session'; END IF;
  SELECT * INTO session FROM hns_root_import_sessions
    WHERE root_import_session_id = input_session_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO provision FROM hns_authority_provision_jobs
    WHERE root_import_session_id = input_session_id AND state = 'completed';
  IF provision.provision_job_id IS NULL THEN RETURN; END IF;
  IF session.publish_plan_sha256 IS DISTINCT FROM provision.publish_plan_sha256 THEN RETURN; END IF;
  IF session.namespace_session_id IS NULL
    OR session.root_label IS NULL
    OR session.challenge_txt_value IS NULL
    OR session.ownership_result_sha256 IS NULL
    OR provision.publish_plan_sha256 IS NULL
    OR provision.result_sha256 IS NULL
  THEN RETURN; END IF;
  -- Alphabetical key order matches canonicalJson. Milliseconds are truncated,
  -- not rounded, so the value matches a JavaScript Date's toISOString.
  encoded := '{'
    || '"challenge_txt_value":' || to_json(session.challenge_txt_value)::text
    || ',"expires_at":' || to_json(to_char(
         date_trunc('milliseconds', session.expires_at) AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ))::text
    || ',"namespace_session_id":' || to_json(session.namespace_session_id)::text
    || ',"ownership_result_sha256":' || to_json(session.ownership_result_sha256)::text
    || ',"provision_result_sha256":' || to_json(provision.result_sha256)::text
    || ',"publish_plan_sha256":' || to_json(provision.publish_plan_sha256)::text
    || ',"root_import_session_id":' || to_json(session.root_import_session_id)::text
    || ',"root_label":' || to_json(session.root_label)::text
    || ',"version":"pirate-hns-root-readiness-observation-request-v1"'
    || '}';
  request_bytes := convert_to(encoded, 'UTF8');
  request_sha256 := encode(sha256(request_bytes), 'hex');
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION encode_hns_root_readiness_observation_request_v1(TEXT) FROM PUBLIC;

-- The probe is retained as cutover evidence. Its lifecycle row is synthetic
-- and excluded from the normal claim selector, and the partial index that
-- marks operational rows exists so the forthcoming observability
-- implementation can exclude synthetic rows from operational phase counts.
-- That reporting does not exist yet and this migration does not implement it.
-- The probe creates no session readiness or activation evidence. The seeder
-- may replace its job on a fresh cutover attempt; the lifecycle row and
-- identity record persist.

CREATE OR REPLACE FUNCTION seed_hns_lifecycle_readiness_cutover_probe_v1() RETURNS text
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
    finality_deadline_at, policy_name, policy_digest, plan_encoded_resource_sha256,
    synthetic
  ) VALUES (
    probe_session, 'cutover-probe', 'checking_authority', 1, 1,
    database_now - interval '1 hour', database_now + interval '13 days',
    database_now - interval '2 hours', database_now + interval '22 hours',
    'hns_root_import_lifecycle_v1', 'cutover-probe', repeat('a', 64), TRUE
  )
  ON CONFLICT (root_import_session_id) DO UPDATE SET synthetic = TRUE;

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

CREATE OR REPLACE FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(input_executor_id text, input_attempt_id text, input_service_version text, input_expected_bundle_sha256 text, input_measured_bundle_sha256 text, input_process_started_at timestamp with time zone) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  probe_session CONSTANT TEXT := 'cutover-readiness-probe';
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  existing hns_lifecycle_service_identity%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  probe_outcome TEXT;
  probe_reason TEXT;
  completed_at TIMESTAMPTZ;
  bound_job_id BIGINT;
  bound_fence BIGINT;
  finalized RECORD;
BEGIN
  IF btrim(input_executor_id) IS DISTINCT FROM input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR btrim(input_attempt_id) IS DISTINCT FROM input_attempt_id
    OR octet_length(input_attempt_id) NOT BETWEEN 8 AND 128
    OR input_attempt_id !~ '^[A-Za-z0-9._:-]+$'
    OR input_service_version !~ '^[A-Za-z0-9._:@/-]{1,128}$'
    OR input_expected_bundle_sha256 !~ '^[0-9a-f]{64}$'
    OR input_measured_bundle_sha256 !~ '^[0-9a-f]{64}$'
    OR input_process_started_at IS NULL
    OR input_process_started_at > database_now + interval '1 minute'
  THEN
    RAISE EXCEPTION 'invalid HNS cutover readiness probe request';
  END IF;

  SELECT * INTO existing FROM hns_lifecycle_service_identity
    WHERE service_name = 'pirate-hns-authority-provisioner' FOR UPDATE;

  IF input_measured_bundle_sha256 IS DISTINCT FROM input_expected_bundle_sha256 THEN
    probe_outcome := 'failed';
    probe_reason := 'artifact_mismatch';
  ELSE
    SELECT * INTO job FROM hns_root_import_lifecycle_jobs
      WHERE root_import_session_id = probe_session
        AND job_kind = 'observe_readiness'
      ORDER BY lifecycle_job_id DESC LIMIT 1 FOR UPDATE;
    IF job.lifecycle_job_id IS NULL THEN
      probe_outcome := 'probe_absent';
      probe_reason := 'probe job missing';
    ELSIF job.state = 'completed' THEN
      -- A completed probe belongs to exactly one attempt. The same attempt
      -- may refresh its process start; a different attempt must re-seed and
      -- can never be satisfied by the previous attempt's completion.
      IF existing.attempt_id = input_attempt_id THEN
        probe_outcome := 'replayed';
        probe_reason := NULL;
        completed_at := existing.probe_completed_at;
        bound_job_id := existing.probe_job_id;
        bound_fence := existing.lease_fence;
      ELSE
        probe_outcome := 'failed';
        probe_reason := 'attempt_mismatch';
      END IF;
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
        completed_at := database_now;
        bound_job_id := job.lifecycle_job_id;
        bound_fence := job.lease_fence;
      ELSE
        probe_outcome := 'failed';
        probe_reason := finalized.outcome;
        bound_job_id := job.lifecycle_job_id;
        bound_fence := job.lease_fence;
      END IF;
    ELSE
      probe_outcome := 'lease_conflict';
      probe_reason := 'probe job is not claimable';
      bound_job_id := job.lifecycle_job_id;
      bound_fence := job.lease_fence;
    END IF;
  END IF;

  INSERT INTO hns_lifecycle_service_identity (
    service_name, service_version, bundle_sha256, executor_id,
    process_started_at, probe_outcome, probe_reason,
    attempt_id, probe_job_id, lease_fence,
    expected_bundle_sha256, measured_bundle_sha256, probe_completed_at
  ) VALUES (
    'pirate-hns-authority-provisioner', input_service_version,
    input_measured_bundle_sha256, input_executor_id,
    input_process_started_at, probe_outcome, probe_reason,
    input_attempt_id, bound_job_id, bound_fence,
    input_expected_bundle_sha256, input_measured_bundle_sha256, completed_at
  )
  ON CONFLICT (service_name) DO UPDATE SET
    service_version = EXCLUDED.service_version,
    bundle_sha256 = EXCLUDED.bundle_sha256,
    executor_id = EXCLUDED.executor_id,
    process_started_at = EXCLUDED.process_started_at,
    probe_outcome = EXCLUDED.probe_outcome,
    probe_reason = EXCLUDED.probe_reason,
    attempt_id = EXCLUDED.attempt_id,
    probe_job_id = EXCLUDED.probe_job_id,
    lease_fence = EXCLUDED.lease_fence,
    expected_bundle_sha256 = EXCLUDED.expected_bundle_sha256,
    measured_bundle_sha256 = EXCLUDED.measured_bundle_sha256,
    probe_completed_at = EXCLUDED.probe_completed_at;

  RETURN probe_outcome;
END;
$$;
REVOKE ALL ON FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

-- The migration owns the runtime privilege contract in deployment order. A
-- deployment that applies the role template before this migration receives the
-- blanket default table privileges when 0171 creates the identity table; a
-- template-only revoke cannot repair that database, so the migration revokes
-- the runtime role directly and grants the exact six-argument probe. A role
-- template applied afterwards produces the same state. Migrations cannot
-- assume application roles exist, so the whole contract is guarded by the
-- repository's role-existence pattern.
DO $hns_cutover_runtime_privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    EXECUTE
      'REVOKE ALL ON TABLE hns_lifecycle_service_identity FROM api_next_app';
    EXECUTE
      'GRANT EXECUTE ON FUNCTION run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz) TO api_next_app';
  END IF;
END;
$hns_cutover_runtime_privileges$;

-- Renewal and lifecycle claim consistency.
CREATE OR REPLACE FUNCTION claim_hns_root_health_renewal_job_v1(input_executor_id text, input_lease_seconds integer) RETURNS TABLE(observation_job_id text, root_import_session_id text, operation_kind text, request_bytes bytea, request_sha256 text, publish_plan_bytes bytea, publish_plan_sha256 text, provision_result_bytes bytea, provision_result_sha256 text, lease_fence bigint, lease_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  candidate hns_root_health_renewal_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  current_generation BIGINT;
  latest_health_generation BIGINT;
  app_generation BIGINT;
  sale_generation BIGINT;
  renewal_request_bytes BYTEA;
  renewal_request_sha256 TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NOT is_hns_host_persistence_identity(input_executor_id, 256)
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN RAISE EXCEPTION 'invalid HNS root health renewal claim'; END IF;

  -- Expired leases enter the same persisted backoff as explicit failures.
  -- This maintenance is unconditional, not a side effect of an empty claim.
  UPDATE hns_root_health_renewal_jobs AS job
    SET state = 'delayed', leased_by = NULL, lease_expires_at = NULL,
        failure_code = 'lease_expired', updated_at = database_now,
        next_attempt_at = database_now + hns_root_health_renewal_delay_v1(job.attempt_count)
  WHERE job.renewal_job_id IN (
    SELECT expired.renewal_job_id FROM hns_root_health_renewal_jobs AS expired
    WHERE expired.state = 'leased' AND expired.lease_expires_at <= database_now
    ORDER BY expired.lease_expires_at, expired.renewal_job_id
    FOR UPDATE SKIP LOCKED LIMIT 100
  );

  SELECT job.* INTO candidate FROM hns_root_health_renewal_jobs AS job
  WHERE job.state = 'queued'
    OR (job.state = 'delayed' AND job.next_attempt_at <= database_now)
  ORDER BY COALESCE(job.next_attempt_at, job.created_at), job.renewal_job_id
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO session FROM hns_root_import_sessions
    WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id FOR SHARE;
  SELECT * INTO provision FROM hns_authority_provision_jobs
    WHERE hns_authority_provision_jobs.root_import_session_id = candidate.root_import_session_id;
  -- The lifecycle row is authoritative where it exists; a pre-lifecycle
  -- operation retains its session-only path.
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
    WHERE hns_root_import_lifecycle.root_import_session_id = candidate.root_import_session_id
    FOR SHARE;
  SELECT dns.current_generation INTO current_generation
    FROM hns_dns_zone_activation_current AS dns
    WHERE dns.dns_zone_activation_id = candidate.dns_zone_activation_id FOR SHARE;
  SELECT max(health.health_generation) INTO latest_health_generation
    FROM hns_dns_zone_health_observations AS health
    WHERE health.dns_zone_activation_id = candidate.dns_zone_activation_id
      AND health.activation_generation = candidate.activation_generation;
  SELECT app.current_generation, sale.current_generation INTO app_generation, sale_generation
    FROM hns_root_import_activation_operations activation
    JOIN hns_community_app_host_activation_current app ON app.app_host_activation_id=activation.app_host_activation_id
    JOIN community_handle_sale_namespace_activation_current sale ON sale.sale_namespace_activation_id=activation.sale_namespace_activation_id
    WHERE activation.root_import_session_id=candidate.root_import_session_id
    FOR SHARE OF app, sale;
  IF session.status IS DISTINCT FROM 'activated'
    OR current_generation IS DISTINCT FROM candidate.activation_generation
    OR latest_health_generation IS DISTINCT FROM candidate.expected_health_generation
  THEN
    -- Genuinely obsolete work stays terminal. A session that is no longer
    -- activated and a superseded DNS or health generation have no repair path
    -- under this job identity, and a terminal job keeps occupying its
    -- generation so the scheduler never recreates it.
    UPDATE hns_root_health_renewal_jobs SET state = 'terminal', next_attempt_at = NULL,
      failure_code = CASE
        WHEN session.status IS DISTINCT FROM 'activated' THEN 'session_not_activated'
        ELSE 'generation_superseded' END,
      completed_at = database_now, updated_at = database_now
    WHERE renewal_job_id = candidate.renewal_job_id;
    RETURN;
  END IF;

  IF app_generation IS NULL OR sale_generation IS NULL
    OR provision.state IS DISTINCT FROM 'completed'
    OR provision.publish_plan_sha256 IS NULL
    OR provision.result_sha256 IS NULL
    OR session.publish_plan_sha256 IS DISTINCT FROM provision.publish_plan_sha256
    OR session.readiness_result_sha256 IS NULL
    OR session.readiness_result_bytes IS NULL
    OR session.ownership_result_sha256 IS NULL
    OR (
      lifecycle.root_import_session_id IS NOT NULL
      AND (
        lifecycle.phase IS DISTINCT FROM 'activated'
        OR lifecycle.readiness_observed_at IS NULL
        OR lifecycle.readiness_accepted_at IS NULL
        OR lifecycle.plan_encoded_resource_sha256 IS NULL
      )
    )
  THEN
    -- Repairable evidence absence is not obsolescence. The named condition is
    -- persisted as a delayed disposition so the same job identity retries
    -- under the 0120 delay policy once the operator restores the binding or
    -- accepted readiness through its supported writer; the scheduler requeues
    -- the same row when due instead of creating a replacement.
    UPDATE hns_root_health_renewal_jobs SET state = 'delayed', leased_by = NULL,
      lease_expires_at = NULL, completed_at = NULL,
      attempt_count = LEAST(candidate.attempt_count + 1, 1024),
      failure_code = CASE
        WHEN provision.state IS DISTINCT FROM 'completed'
          OR provision.publish_plan_sha256 IS NULL
          OR provision.result_sha256 IS NULL
        THEN 'plan_binding_missing'
        WHEN session.publish_plan_sha256 IS DISTINCT FROM provision.publish_plan_sha256
        THEN 'plan_binding_mismatch'
        WHEN lifecycle.root_import_session_id IS NOT NULL
          AND lifecycle.plan_encoded_resource_sha256 IS NULL
        THEN 'plan_binding_missing'
        WHEN (
          lifecycle.root_import_session_id IS NOT NULL
          AND (
            lifecycle.phase IS DISTINCT FROM 'activated'
            OR lifecycle.readiness_observed_at IS NULL
            OR lifecycle.readiness_accepted_at IS NULL
          )
        )
          OR session.readiness_result_sha256 IS NULL
          OR session.readiness_result_bytes IS NULL
        THEN 'readiness_evidence_missing'
        WHEN session.ownership_result_sha256 IS NULL
        THEN 'ownership_evidence_missing'
        ELSE 'activation_evidence_missing' END,
      next_attempt_at = database_now
        + hns_root_health_renewal_delay_v1(LEAST(candidate.attempt_count + 1, 1024)),
      updated_at = database_now
    WHERE renewal_job_id = candidate.renewal_job_id;
    RETURN;
  END IF;

  -- The renewal envelope is derived from the retained session and provision
  -- evidence and bound to the claimed authority generation. It no longer
  -- depends on the retired observation job's request row.
  SELECT encoded.request_bytes, encoded.request_sha256
    INTO renewal_request_bytes, renewal_request_sha256
    FROM encode_hns_root_readiness_observation_request_v1(session.root_import_session_id) AS encoded;
  IF renewal_request_bytes IS NULL THEN
    RAISE EXCEPTION 'HNS renewal request envelope is unavailable';
  END IF;

  database_now := clock_timestamp();
  UPDATE hns_root_health_renewal_jobs AS job
    SET state = 'leased', attempt_count = LEAST(candidate.attempt_count + 1, 1024),
        lease_fence = candidate.lease_fence + 1, leased_by = input_executor_id,
        lease_expires_at = database_now + input_lease_seconds * interval '1 second',
        expected_app_generation=app_generation, expected_sale_generation=sale_generation,
        request_bytes = renewal_request_bytes, request_sha256 = renewal_request_sha256,
        failure_code = NULL, next_attempt_at = NULL, updated_at = database_now
  WHERE job.renewal_job_id = candidate.renewal_job_id;

  RETURN QUERY SELECT candidate.renewal_job_id, candidate.root_import_session_id,
    'renew_health_v1'::text, renewal_request_bytes, renewal_request_sha256,
    provision.publish_plan_bytes, provision.publish_plan_sha256,
    provision.result_bytes, provision.result_sha256, candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;
CREATE OR REPLACE FUNCTION finalize_hns_root_health_renewal_job_v1(input_renewal_job_id text, input_executor_id text, input_lease_fence bigint, input_request_sha256 text, input_outcome text, input_result_bytes bytea, input_result_sha256 text, input_failure_code text) RETURNS TABLE(outcome text, root_import_session_id text, session_revision bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
DECLARE
  job hns_root_health_renewal_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  result JSONB;
  dns_revision hns_dns_zone_activation_revisions%ROWTYPE;
  remaining_seconds INTEGER;
  latest_health_generation BIGINT;
  current_generation BIGINT;
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

  database_now := clock_timestamp();
  IF job.state IN ('completed', 'terminal') THEN
    -- Pre-0170 completed renewals carry no derived request digest. Their
    -- completion cannot be matched against a derived envelope, so a
    -- re-delivery is deliberately a conflict rather than a replay.
    IF job.state = 'completed' AND job.request_sha256 IS NULL THEN
      RETURN QUERY SELECT 'conflict'::text, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    IF job.state = 'completed' AND input_outcome = 'ready'
      AND job.request_sha256 = input_request_sha256
      AND job.result_bytes = input_result_bytes AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    THEN RETURN QUERY SELECT 'replayed'::text, session.root_import_session_id, session.revision;
    ELSE RETURN QUERY SELECT 'conflict'::text, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased' OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence IS DISTINCT FROM input_lease_fence OR job.lease_expires_at <= database_now
    OR (SELECT provision.publish_plan_sha256 FROM hns_authority_provision_jobs AS provision
         WHERE provision.root_import_session_id = job.root_import_session_id
           AND provision.state = 'completed') IS DISTINCT FROM session.publish_plan_sha256
    OR job.request_sha256 IS NULL
    OR job.request_sha256 IS DISTINCT FROM input_request_sha256
  THEN RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN; END IF;

  SELECT dns.current_generation INTO current_generation
    FROM hns_dns_zone_activation_current AS dns
    WHERE dns.dns_zone_activation_id = job.dns_zone_activation_id FOR SHARE;
  SELECT max(health.health_generation) INTO latest_health_generation
    FROM hns_dns_zone_health_observations AS health
    WHERE health.dns_zone_activation_id = job.dns_zone_activation_id
      AND health.activation_generation = job.activation_generation;
  -- Recheck expiry after authority locks, which can wait behind a promotion.
  database_now := clock_timestamp();
  IF job.lease_expires_at <= database_now THEN
    RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;

  IF session.status IS DISTINCT FROM 'activated'
    OR current_generation IS DISTINCT FROM job.activation_generation
    OR latest_health_generation IS DISTINCT FROM job.expected_health_generation
  THEN
    UPDATE hns_root_health_renewal_jobs SET state = 'terminal', leased_by = NULL,
      lease_expires_at = NULL, next_attempt_at = NULL,
      failure_code = CASE WHEN session.status IS DISTINCT FROM 'activated'
        THEN 'session_not_activated' ELSE 'generation_superseded' END,
      completed_at = database_now, updated_at = database_now
    WHERE renewal_job_id = input_renewal_job_id;
    RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;

  SELECT * INTO dns_revision FROM hns_dns_zone_activation_revisions AS dns
    WHERE dns.dns_zone_activation_id = job.dns_zone_activation_id
      AND dns.dns_zone_activation_generation = job.activation_generation;

  IF input_outcome = 'ready' THEN
    IF input_result_bytes IS NULL OR input_result_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_result_bytes), 'hex') <> input_result_sha256
      OR input_failure_code IS NOT NULL
    THEN RAISE EXCEPTION 'invalid ready HNS root health renewal result'; END IF;
    BEGIN result := convert_from(input_result_bytes, 'UTF8')::jsonb;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid HNS root health renewal result bytes'; END;
    IF (result->>'version' <> 'pirate-hns-root-import-readiness-result-v1'
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
      OR ('hns-root-chain:' || (result->>'chain_resource_sha256'))
         IS DISTINCT FROM dns_revision.stable_chain_delegation_snapshot_reference) IS DISTINCT FROM FALSE
    THEN
      UPDATE hns_root_health_renewal_jobs SET state = 'terminal', leased_by = NULL,
        lease_expires_at = NULL, next_attempt_at = NULL, failure_code = 'evidence_mismatch',
        completed_at = database_now, updated_at = database_now
      WHERE renewal_job_id = input_renewal_job_id;
      RETURN QUERY SELECT 'failed'::text, session.root_import_session_id, session.revision; RETURN;
    END IF;
    remaining_seconds := floor(extract(epoch FROM ((result->>'valid_until')::timestamptz - database_now)))::integer;
    IF (result->>'observed_at')::timestamptz > database_now + interval '60 seconds'
      OR remaining_seconds NOT BETWEEN 1 AND 604800
    THEN RAISE EXCEPTION 'HNS root health renewal evidence is stale'; END IF;
    SELECT recorded.outcome INTO health_outcome FROM record_hns_dns_zone_health_v1(
      'hns-health-renewal-record:' || job.renewal_job_id,
      'hns-health-renewal-record:' || job.renewal_job_id,
      input_result_sha256, job.dns_zone_activation_id, job.activation_generation,
      job.expected_health_generation,
      dns_revision.stable_chain_delegation_snapshot_reference,
      dns_revision.stable_chain_delegation_snapshot_digest,
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
  IF NOT hns_root_health_renewal_terminal_failure_v1(input_failure_code) THEN
    UPDATE hns_root_health_renewal_jobs SET state = 'delayed', leased_by = NULL,
      lease_expires_at = NULL, failure_code = input_failure_code, updated_at = database_now,
      next_attempt_at = database_now + hns_root_health_renewal_delay_v1(job.attempt_count)
    WHERE renewal_job_id = input_renewal_job_id;
    RETURN QUERY SELECT 'retry'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;
  UPDATE hns_root_health_renewal_jobs SET state = 'terminal', leased_by = NULL,
    lease_expires_at = NULL, next_attempt_at = NULL, failure_code = input_failure_code,
    completed_at = database_now, updated_at = database_now
  WHERE renewal_job_id = input_renewal_job_id;
  RETURN QUERY SELECT 'failed'::text, session.root_import_session_id, session.revision;
END;
$_$;
CREATE OR REPLACE FUNCTION prepare_hns_root_inventory_renewal_v1(input_renewal_job_id text, input_executor_id text, input_lease_fence bigint, input_request_sha256 text, input_outcome text, input_result_bytes bytea, input_result_sha256 text, input_failure_code text) RETURNS TABLE(outcome text, root_import_session_id text, session_revision bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
DECLARE
  job hns_root_health_renewal_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  result JSONB;
  dns_revision hns_dns_zone_activation_revisions%ROWTYPE;
  remaining_seconds INTEGER;
  latest_health_generation BIGINT;
  current_generation BIGINT;
  app_generation BIGINT;
  sale_generation BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_outcome IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'invalid HNS root health renewal finalization';
  END IF;
  SELECT * INTO job FROM hns_root_health_renewal_jobs
    WHERE renewal_job_id = input_renewal_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint; RETURN; END IF;
  SELECT * INTO session FROM hns_root_import_sessions
    WHERE hns_root_import_sessions.root_import_session_id = job.root_import_session_id FOR UPDATE;

  database_now := clock_timestamp();
  IF job.state IN ('completed', 'terminal') THEN
    -- See the renewal finalizer: a pre-0170 completed job's missing request
    -- digest is a deliberate conflict, never a replay.
    IF job.state = 'completed' AND job.request_sha256 IS NULL THEN
      RETURN QUERY SELECT 'conflict'::text, session.root_import_session_id, session.revision;
      RETURN;
    END IF;
    IF job.state = 'completed' AND input_outcome = 'ready'
      AND job.request_sha256 = input_request_sha256
      AND job.result_bytes = input_result_bytes AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    THEN RETURN QUERY SELECT 'replayed'::text, session.root_import_session_id, session.revision;
    ELSE RETURN QUERY SELECT 'conflict'::text, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased' OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence IS DISTINCT FROM input_lease_fence OR job.lease_expires_at <= database_now
    OR (SELECT provision.publish_plan_sha256 FROM hns_authority_provision_jobs AS provision
         WHERE provision.root_import_session_id = job.root_import_session_id
           AND provision.state = 'completed') IS DISTINCT FROM session.publish_plan_sha256
    OR job.request_sha256 IS NULL
    OR job.request_sha256 IS DISTINCT FROM input_request_sha256
  THEN RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN; END IF;

  SELECT dns.current_generation INTO current_generation
    FROM hns_dns_zone_activation_current AS dns
    WHERE dns.dns_zone_activation_id = job.dns_zone_activation_id FOR UPDATE;
  SELECT max(health.health_generation) INTO latest_health_generation
    FROM hns_dns_zone_health_observations AS health
    WHERE health.dns_zone_activation_id = job.dns_zone_activation_id
      AND health.activation_generation = job.activation_generation;
  -- Recheck expiry after authority locks, which can wait behind a promotion.
  database_now := clock_timestamp();
  IF job.lease_expires_at <= database_now THEN
    RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;

  IF session.status IS DISTINCT FROM 'activated'
    OR current_generation IS DISTINCT FROM job.activation_generation
    OR latest_health_generation IS DISTINCT FROM job.expected_health_generation
  THEN
    UPDATE hns_root_health_renewal_jobs SET state = 'terminal', leased_by = NULL,
      lease_expires_at = NULL, next_attempt_at = NULL,
      failure_code = CASE WHEN session.status IS DISTINCT FROM 'activated'
        THEN 'session_not_activated' ELSE 'generation_superseded' END,
      completed_at = database_now, updated_at = database_now
    WHERE renewal_job_id = input_renewal_job_id;
    RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;

  SELECT app.current_generation, sale.current_generation INTO app_generation, sale_generation
    FROM hns_root_import_activation_operations activation
    JOIN hns_community_app_host_activation_current app ON app.app_host_activation_id=activation.app_host_activation_id
    JOIN community_handle_sale_namespace_activation_current sale ON sale.sale_namespace_activation_id=activation.sale_namespace_activation_id
    WHERE activation.root_import_session_id=job.root_import_session_id
    FOR UPDATE OF app, sale;
  database_now := clock_timestamp();
  IF job.lease_expires_at <= database_now THEN
    RETURN QUERY SELECT 'lost'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;
  IF app_generation IS DISTINCT FROM job.expected_app_generation
    OR sale_generation IS DISTINCT FROM job.expected_sale_generation
    OR app_generation IS NULL OR sale_generation IS NULL
  THEN
    UPDATE hns_root_health_renewal_jobs SET state='delayed', leased_by=NULL,
      lease_expires_at=NULL, next_attempt_at=database_now + interval '30 seconds',
      failure_code='successor_generation_changed', updated_at=database_now
    WHERE renewal_job_id=input_renewal_job_id;
    RETURN QUERY SELECT 'retry'::text, session.root_import_session_id, session.revision; RETURN;
  END IF;

  SELECT * INTO dns_revision FROM hns_dns_zone_activation_revisions AS dns
    WHERE dns.dns_zone_activation_id = job.dns_zone_activation_id
      AND dns.dns_zone_activation_generation = job.activation_generation;

  IF input_outcome = 'ready' THEN
    IF input_result_bytes IS NULL OR input_result_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_result_bytes), 'hex') <> input_result_sha256
      OR input_failure_code IS NOT NULL
    THEN RAISE EXCEPTION 'invalid ready HNS root health renewal result'; END IF;
    BEGIN result := convert_from(input_result_bytes, 'UTF8')::jsonb;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid HNS root health renewal result bytes'; END;
    IF (result->>'version' <> 'pirate-hns-root-import-readiness-result-v1'
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
      OR result->>'observed_zone_bytes_sha256' IS DISTINCT FROM dns_revision.zone_bytes_digest
      OR result->>'dnssec_keyset_reference' IS DISTINCT FROM dns_revision.dnssec_keyset_reference
      OR result->>'dnssec_keyset_version' IS DISTINCT FROM dns_revision.dnssec_keyset_version
      OR result->>'gateway_deployment_reference' IS DISTINCT FROM dns_revision.gateway_deployment_reference
      OR result->>'gateway_certificate_spki_sha256' IS DISTINCT FROM dns_revision.gateway_certificate_spki_sha256
      OR ('hns-root-chain:' || (result->>'chain_resource_sha256'))
         IS DISTINCT FROM dns_revision.stable_chain_delegation_snapshot_reference) IS DISTINCT FROM FALSE
    THEN
      UPDATE hns_root_health_renewal_jobs SET state = 'terminal', leased_by = NULL,
        lease_expires_at = NULL, next_attempt_at = NULL, failure_code = 'evidence_mismatch',
        completed_at = database_now, updated_at = database_now
      WHERE renewal_job_id = input_renewal_job_id;
      RETURN QUERY SELECT 'failed'::text, session.root_import_session_id, session.revision; RETURN;
    END IF;
    remaining_seconds := floor(extract(epoch FROM ((result->>'valid_until')::timestamptz - database_now)))::integer;
    IF (result->>'observed_at')::timestamptz > database_now + interval '60 seconds'
      OR remaining_seconds NOT BETWEEN 1 AND 604800
    THEN RAISE EXCEPTION 'HNS root health renewal evidence is stale'; END IF;
    RETURN QUERY SELECT 'prepared'::text, session.root_import_session_id, session.revision;
  END IF;
END;
$_$;
CREATE OR REPLACE FUNCTION claim_hns_root_import_lifecycle_job_v1(input_executor_id text, input_lease_seconds integer) RETURNS TABLE(lifecycle_job_id bigint, root_import_session_id text, job_kind text, due_at timestamp with time zone, lease_fence bigint, lease_expires_at timestamp with time zone, generation bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  candidate hns_root_import_lifecycle_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_executor_id IS NULL
    OR btrim(input_executor_id) IS DISTINCT FROM input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds IS NULL
    OR input_lease_seconds NOT BETWEEN 4 AND 120 THEN
    RAISE EXCEPTION 'invalid HNS lifecycle job claim';
  END IF;

  UPDATE hns_root_import_lifecycle_jobs AS stale
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'generation_superseded', completed_at = database_now,
         updated_at = database_now
   WHERE stale.lifecycle_job_id IN (
     SELECT job.lifecycle_job_id
       FROM hns_root_import_lifecycle_jobs AS job
       JOIN hns_root_import_lifecycle AS lifecycle
         ON lifecycle.root_import_session_id = job.root_import_session_id
      WHERE NOT lifecycle.synthetic
        AND job.generation < lifecycle.generation
        AND (
          job.state = 'queued'
          OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
        )
      FOR UPDATE OF job SKIP LOCKED
   );

  SELECT job.* INTO candidate
    FROM hns_root_import_lifecycle_jobs AS job
    JOIN hns_root_import_lifecycle AS lifecycle
      ON lifecycle.root_import_session_id = job.root_import_session_id
   WHERE ((job.state = 'queued' AND job.due_at <= database_now)
      OR (job.state = 'leased' AND job.lease_expires_at <= database_now))
     AND job.generation = lifecycle.generation
     AND NOT lifecycle.synthetic
     AND NOT EXISTS (
       SELECT 1 FROM hns_root_import_observation_jobs AS legacy
        WHERE legacy.root_import_session_id = job.root_import_session_id
          AND legacy.state = 'leased'
          AND legacy.lease_expires_at > database_now
     )
   ORDER BY job.due_at, job.lifecycle_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE hns_root_import_lifecycle_jobs AS job
     SET state = 'leased',
         attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + input_lease_seconds * interval '1 second',
         failure_code = NULL,
         updated_at = database_now
   WHERE job.lifecycle_job_id = candidate.lifecycle_job_id;
  RETURN QUERY SELECT
    candidate.lifecycle_job_id, candidate.root_import_session_id,
    candidate.job_kind, candidate.due_at,
    candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second',
    candidate.generation;
END;
$$;
