-- HNS root health renewal on authoritative retained evidence.
--
-- Ratified specification: spec 012, renewal allocation and the 2026-09-11
-- single-owner cutover amendment.
--
-- `claim_hns_root_health_renewal_job_v1` previously required a completed
-- legacy observation job and returned that job's request bytes as the renewal
-- envelope. After the single-owner cutover the legacy observation executor is
-- retired, so that job never completes for lifecycle-managed operations and
-- renewal terminated with `evidence_mismatch`. This migration moves the
-- renewal claim and finalizer onto retained session and lifecycle evidence:
-- an activated session with retained accepted readiness, a completed
-- provision, an activated lifecycle phase where a lifecycle row exists, and
-- the existing DNS, health, app and sale generation fences. The renewal
-- request envelope is derived in the claim from that authoritative evidence
-- and persisted on the generation-bound renewal job, so the finalizer no
-- longer reads the retired observation row.

ALTER TABLE hns_root_health_renewal_jobs
  ADD COLUMN request_bytes bytea,
  ADD COLUMN request_sha256 text;

ALTER TABLE hns_root_health_renewal_jobs
  ADD CONSTRAINT hns_root_health_renewal_jobs_request_envelope_shape CHECK (
    (request_bytes IS NULL) = (request_sha256 IS NULL)
    AND (
      request_sha256 IS NULL
      OR (
        octet_length(request_bytes) >= 1
        AND octet_length(request_bytes) <= 65536
        AND request_sha256 ~ '^[0-9a-f]{64}$'
        AND encode(sha256(request_bytes), 'hex') = request_sha256
      )
    )
  );

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
    OR app_generation IS NULL OR sale_generation IS NULL
    OR provision.state IS DISTINCT FROM 'completed'
    OR provision.publish_plan_sha256 IS NULL
    OR provision.result_sha256 IS NULL
    OR session.readiness_result_sha256 IS NULL
    OR session.ownership_result_sha256 IS NULL
    OR (
      lifecycle.root_import_session_id IS NOT NULL
      AND (
        lifecycle.phase IS DISTINCT FROM 'activated'
        OR lifecycle.readiness_observed_at IS NULL
      )
    )
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

  -- The renewal envelope is derived from the retained session and provision
  -- evidence and bound to the claimed authority generation. It no longer
  -- depends on the retired observation job's request row.
  renewal_request_bytes := convert_to(
    '{"version":"pirate-hns-root-readiness-observation-request-v1"'
      || ',"root_import_session_id":' || to_json(session.root_import_session_id)::text
      || ',"namespace_session_id":' || to_json(session.namespace_session_id)::text
      || ',"root_label":' || to_json(session.root_label)::text
      || ',"challenge_txt_value":' || to_json(session.challenge_txt_value)::text
      || ',"ownership_result_sha256":' || to_json(session.ownership_result_sha256)::text
      || ',"publish_plan_sha256":' || to_json(provision.publish_plan_sha256)::text
      || ',"provision_result_sha256":' || to_json(provision.result_sha256)::text
      || ',"expires_at":' || to_json(to_char(
           session.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ))::text
      || '}',
    'UTF8'
  );
  renewal_request_sha256 := encode(sha256(renewal_request_bytes), 'hex');

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

-- The inventory-renewal preparation path joined the retired observation row
-- only to compare the lease's request digest. It now compares the digest
-- persisted on the generation-bound renewal job.
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
