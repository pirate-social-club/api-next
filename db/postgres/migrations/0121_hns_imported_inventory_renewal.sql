-- Spec 012 September 5 erratum: evidence expires within 604800 seconds.
-- Preparation holds predecessor job, session and DNS locks in the caller's
-- transaction. The maintained promotion body writes all serving successors;
-- only then may that caller complete the original job and commit.
ALTER TABLE hns_root_health_renewal_jobs
  ADD COLUMN expected_app_generation BIGINT CHECK (expected_app_generation BETWEEN 1 AND 9007199254740991),
  ADD COLUMN expected_sale_generation BIGINT CHECK (expected_sale_generation BETWEEN 1 AND 9007199254740991);

CREATE OR REPLACE FUNCTION schedule_hns_root_health_renewals_v1(
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
    JOIN hns_dns_zone_activation_revisions AS revision
      ON revision.dns_zone_activation_id = activation_row.dns_zone_activation_id
     AND revision.dns_zone_activation_generation = activation_row.current_generation
    JOIN hns_authority_inventories AS inventory
      ON inventory.authority_inventory_reference = revision.pirate_dns_authority_inventory_reference
     AND inventory.authority_inventory_version = revision.pirate_dns_authority_inventory_version
     AND inventory.authority_inventory_digest = revision.pirate_dns_authority_inventory_digest
    WHERE LEAST(health.valid_until, inventory.expires_at) <= database_now
      + input_renew_when_remaining_seconds * interval '1 second'
      AND NOT EXISTS (
        SELECT 1 FROM hns_root_health_renewal_jobs AS existing
        WHERE existing.dns_zone_activation_id = activation_row.dns_zone_activation_id
          AND existing.activation_generation = activation_row.current_generation
          AND existing.expected_health_generation = health.health_generation
          AND NOT (existing.state = 'delayed' AND existing.next_attempt_at <= database_now)
      )
    ORDER BY LEAST(health.valid_until, inventory.expires_at), activation.root_import_session_id
    LIMIT input_limit
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
    ON CONFLICT (dns_zone_activation_id, activation_generation, expected_health_generation)
    DO UPDATE SET state = 'queued', next_attempt_at = NULL, updated_at = database_now
    WHERE hns_root_health_renewal_jobs.state = 'delayed'
      AND hns_root_health_renewal_jobs.next_attempt_at <= database_now
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

CREATE OR REPLACE FUNCTION claim_hns_root_health_renewal_job_v1(
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
  current_generation BIGINT;
  latest_health_generation BIGINT;
  app_generation BIGINT;
  sale_generation BIGINT;
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
  SELECT * INTO observation FROM hns_root_import_observation_jobs
    WHERE hns_root_import_observation_jobs.root_import_session_id = candidate.root_import_session_id;
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
    OR app_generation IS NULL OR sale_generation IS NULL
    OR provision.state IS DISTINCT FROM 'completed'
    OR observation.state IS DISTINCT FROM 'completed'
  THEN
    UPDATE hns_root_health_renewal_jobs SET state = 'terminal', next_attempt_at = NULL,
      failure_code = CASE WHEN session.status IS DISTINCT FROM 'activated'
        THEN 'session_not_activated'
        WHEN current_generation IS DISTINCT FROM candidate.activation_generation
          OR latest_health_generation IS DISTINCT FROM candidate.expected_health_generation
        THEN 'generation_superseded' ELSE 'evidence_mismatch' END,
      completed_at = database_now, updated_at = database_now
    WHERE renewal_job_id = candidate.renewal_job_id;
    RETURN;
  END IF;

  database_now := clock_timestamp();
  UPDATE hns_root_health_renewal_jobs AS job
    SET state = 'leased', attempt_count = LEAST(candidate.attempt_count + 1, 1024),
        lease_fence = candidate.lease_fence + 1, leased_by = input_executor_id,
        lease_expires_at = database_now + input_lease_seconds * interval '1 second',
        expected_app_generation=app_generation, expected_sale_generation=sale_generation,
        failure_code = NULL, next_attempt_at = NULL, updated_at = database_now
  WHERE job.renewal_job_id = candidate.renewal_job_id;

  RETURN QUERY SELECT candidate.renewal_job_id, candidate.root_import_session_id,
    'renew_health_v1'::text, observation.request_bytes, observation.request_sha256,
    provision.publish_plan_bytes, provision.publish_plan_sha256,
    provision.result_bytes, provision.result_sha256, candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;

CREATE FUNCTION prepare_hns_root_inventory_renewal_v1(
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
  SELECT * INTO observation FROM hns_root_import_observation_jobs
    WHERE hns_root_import_observation_jobs.root_import_session_id = job.root_import_session_id;

  database_now := clock_timestamp();
  IF job.state IN ('completed', 'terminal') THEN
    IF job.state = 'completed' AND input_outcome = 'ready'
      AND observation.request_sha256 = input_request_sha256
      AND job.result_bytes = input_result_bytes AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    THEN RETURN QUERY SELECT 'replayed'::text, session.root_import_session_id, session.revision;
    ELSE RETURN QUERY SELECT 'conflict'::text, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased' OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence IS DISTINCT FROM input_lease_fence OR job.lease_expires_at <= database_now
    OR observation.request_sha256 IS DISTINCT FROM input_request_sha256
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
$$;
DO $$
DECLARE installed_schema TEXT := current_schema(); signature TEXT;
BEGIN
  IF installed_schema IS NULL THEN RAISE EXCEPTION 'HNS inventory renewal requires a current schema'; END IF;
  FOREACH signature IN ARRAY ARRAY[
    'schedule_hns_root_health_renewals_v1(integer,integer,integer)',
    'claim_hns_root_health_renewal_job_v1(text,integer)',
    'prepare_hns_root_inventory_renewal_v1(text,text,bigint,text,text,bytea,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO %I, pg_temp', installed_schema, signature, installed_schema);
  END LOOP;
END;
$$;
