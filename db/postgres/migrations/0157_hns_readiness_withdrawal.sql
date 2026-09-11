-- Readiness ownership withdrawal: a tested reverse handover.
--
-- The forward handover (0150, corrected by 0151) enables the lifecycle
-- readiness performer, disposes queued legacy readiness work and queues the
-- lifecycle replacement exactly once. This migration provides the inverse:
-- an operator-only withdrawal that returns readiness to the legacy executor
-- while preserving authority, generation, plan binding, deadlines and
-- accepted evidence, and a receiving-executor wrapper that advances both
-- session and lifecycle state for the operations it can safely resume.
--
-- Where the receiver cannot safely resume an operation the withdrawal refuses
-- with a named reason and leaves ownership enabled: adopted generations,
-- absent plan digests, absent legacy observation rows, stale-ready refreshes
-- the legacy claim cannot serve, and phase/session mismatches.

-- The pre-existing finalizer is preserved under a private name. The rename
-- keeps its body, security attributes and pinned search path; its runtime
-- grant is revoked because the public name moves to the wrapper below.
ALTER FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) RENAME TO finalize_hns_root_import_observation_job_legacy_v1;

REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_legacy_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;

DO $revoke_legacy_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_legacy_v1(text,text,bigint,text,text,bytea,text,text) FROM api_next_app';
  END IF;
END;
$revoke_legacy_runtime$;

-- The public finalizer now holds the common lock order first — marker, then
-- lifecycle — delegates the legacy outcome, and commits the lifecycle
-- readiness decision in the same transaction when the legacy path advanced a
-- lifecycle-managed operation under withdrawn ownership.
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
LANGUAGE plpgsql AS $$
DECLARE
  readiness_enabled BOOLEAN;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  job_session TEXT;
  legacy RECORD;
  committed RECORD;
  database_now TIMESTAMPTZ := clock_timestamp();
  readiness_event_id TEXT;
BEGIN
  SELECT ownership.enabled INTO readiness_enabled
    FROM hns_root_import_execution_ownership AS ownership
   WHERE ownership.responsibility = 'readiness'
   FOR SHARE;
  readiness_enabled := coalesce(readiness_enabled, FALSE);

  IF NOT readiness_enabled THEN
    SELECT observation.root_import_session_id INTO job_session
      FROM hns_root_import_observation_jobs AS observation
     WHERE observation.observation_job_id = input_observation_job_id;
    IF job_session IS NOT NULL THEN
      SELECT * INTO lifecycle FROM hns_root_import_lifecycle AS selected_lifecycle
       WHERE selected_lifecycle.root_import_session_id = job_session
       FOR UPDATE;
    END IF;
  END IF;

  SELECT * INTO legacy FROM finalize_hns_root_import_observation_job_legacy_v1(
    input_observation_job_id,
    input_executor_id,
    input_lease_fence,
    input_request_sha256,
    input_outcome,
    input_result_bytes,
    input_result_sha256,
    input_failure_code
  );

  IF legacy.outcome = 'ready'
    AND NOT readiness_enabled
    AND lifecycle.root_import_session_id IS NOT NULL
  THEN
    IF lifecycle.phase NOT IN ('checking_authority', 'ready') THEN
      RAISE EXCEPTION
        'HNS legacy readiness lifecycle phase conflict: %', lifecycle.phase;
    END IF;
    readiness_event_id :=
      'readiness:legacy:' || input_observation_job_id || ':' ||
      input_lease_fence::TEXT || ':' || input_result_sha256;
    SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
      lifecycle.root_import_session_id,
      lifecycle.revision,
      readiness_event_id,
      'readiness_observed',
      'transition',
      'readiness_retained',
      'ready',
      jsonb_build_object(
        'readiness_observed_at', database_now,
        'next_check_at', database_now + interval '1800 seconds',
        'pending_reason', NULL
      ),
      '[]'::jsonb
    );
    IF committed.outcome IS DISTINCT FROM 'transition' THEN
      RAISE EXCEPTION
        'HNS legacy readiness lifecycle decision failed: %', committed.outcome;
    END IF;
  END IF;

  RETURN QUERY SELECT
    legacy.outcome, legacy.root_import_session_id, legacy.session_revision;
END;
$$;
REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
ALTER FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) SECURITY DEFINER;

-- The withdrawal: operator-only, marker-locked, live-lease refusing and
-- preserving every retained field. It dispositions lifecycle-owned readiness
-- jobs, queues exactly-once replacement work for the receiving executor on
-- the legacy observation row that is unique per session, and disables the
-- marker with the disabled shape the table requires.
CREATE OR REPLACE FUNCTION withdraw_hns_root_import_readiness_ownership_v1(
  input_evidence_ref TEXT
) RETURNS TABLE (
  outcome TEXT,
  dispositioned_jobs BIGINT,
  queued_jobs BIGINT,
  disabled_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
DECLARE
  marker hns_root_import_execution_ownership%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  dispositioned BIGINT := 0;
  queued BIGINT := 0;
  blocker TEXT;
BEGIN
  IF input_evidence_ref IS NULL
    OR btrim(input_evidence_ref) IS DISTINCT FROM input_evidence_ref
    OR octet_length(input_evidence_ref) NOT BETWEEN 1 AND 512
  THEN
    RAISE EXCEPTION 'invalid HNS readiness withdrawal evidence';
  END IF;

  SELECT * INTO marker FROM hns_root_import_execution_ownership
   WHERE responsibility = 'readiness'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'marker_absent'::TEXT, 0::BIGINT, 0::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF NOT marker.enabled THEN
    RETURN QUERY SELECT 'already_disabled'::TEXT, 0::BIGINT, 0::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- The common lock order is already held: the marker FOR UPDATE excludes
  -- every claim and finalizer that takes the marker FOR SHARE, so no claim
  -- can be granted between this check and the marker update below. A live
  -- conflicting lease refuses withdrawal with state unchanged.
  IF EXISTS (
    SELECT 1
      FROM hns_root_import_observation_jobs AS job
      JOIN hns_root_import_lifecycle AS lifecycle
        ON lifecycle.root_import_session_id = job.root_import_session_id
     WHERE job.operation_kind = 'observe_root_v1'
       AND job.state = 'leased'
       AND job.lease_expires_at > database_now
  ) OR EXISTS (
    SELECT 1 FROM hns_root_import_lifecycle_jobs AS job
     WHERE job.state = 'leased'
       AND job.lease_expires_at > database_now
       AND job.job_kind IN ('observe_current', 'observe_safe', 'observe_readiness')
  ) THEN
    RETURN QUERY SELECT 'live_lease_present'::TEXT, 0::BIGINT, 0::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
       WHERE (
           lifecycle.phase = 'checking_authority'
           OR (
             lifecycle.phase = 'ready'
             AND (
               lifecycle.readiness_observed_at IS NULL
               OR lifecycle.readiness_observed_at <= database_now - interval '1800 seconds'
             )
           )
         )
         AND lifecycle.generation <> 1
    ) THEN 'receiver_cannot_resume_adopted_generation'
    WHEN EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
       WHERE (
           lifecycle.phase = 'checking_authority'
           OR (
             lifecycle.phase = 'ready'
             AND (
               lifecycle.readiness_observed_at IS NULL
               OR lifecycle.readiness_observed_at <= database_now - interval '1800 seconds'
             )
           )
         )
         AND lifecycle.plan_encoded_resource_sha256 IS NULL
    ) THEN 'receiver_plan_absent'
    WHEN EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
       WHERE (
           lifecycle.phase = 'checking_authority'
           OR (
             lifecycle.phase = 'ready'
             AND (
               lifecycle.readiness_observed_at IS NULL
               OR lifecycle.readiness_observed_at <= database_now - interval '1800 seconds'
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM hns_root_import_observation_jobs AS observation
            WHERE observation.root_import_session_id = lifecycle.root_import_session_id
              AND observation.operation_kind = 'observe_root_v1'
         )
    ) THEN 'receiver_observation_absent'
    WHEN EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
       WHERE lifecycle.phase = 'ready'
         AND (
           lifecycle.readiness_observed_at IS NULL
           OR lifecycle.readiness_observed_at <= database_now - interval '1800 seconds'
         )
    ) THEN 'receiver_cannot_resume_ready_refresh'
    WHEN EXISTS (
      SELECT 1
        FROM hns_root_import_lifecycle AS lifecycle
        JOIN hns_root_import_sessions AS session
          ON session.root_import_session_id = lifecycle.root_import_session_id
       WHERE lifecycle.phase = 'checking_authority'
         AND session.status <> 'observing'
    ) THEN 'receiver_session_phase_conflict'
    ELSE NULL
  END INTO blocker;
  IF blocker IS NOT NULL THEN
    RETURN QUERY SELECT blocker, 0::BIGINT, 0::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  UPDATE hns_root_import_lifecycle_jobs AS job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'readiness_ownership_withdrawn',
         completed_at = database_now, updated_at = database_now
   WHERE job.job_kind = 'observe_readiness'
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     );
  GET DIAGNOSTICS dispositioned = ROW_COUNT;

  -- One legacy observation row exists per session, so this is exactly-once
  -- replacement work for the receiver and a replay of the withdrawal changes
  -- nothing because the marker is already disabled.
  UPDATE hns_root_import_observation_jobs AS observation
     SET state = 'queued', attempt_count = 0, leased_by = NULL,
         lease_expires_at = NULL, result_bytes = NULL, result_sha256 = NULL,
         failure_code = NULL, completed_at = NULL, updated_at = database_now
   WHERE observation.operation_kind = 'observe_root_v1'
     AND EXISTS (
       SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
        WHERE lifecycle.root_import_session_id = observation.root_import_session_id
          AND lifecycle.phase = 'checking_authority'
     );
  GET DIAGNOSTICS queued = ROW_COUNT;

  UPDATE hns_root_import_execution_ownership
     SET enabled = FALSE,
         enabled_at = NULL,
         evidence_ref = input_evidence_ref,
         updated_at = database_now
   WHERE responsibility = 'readiness';

  RETURN QUERY SELECT 'withdrawn'::TEXT, dispositioned, queued, database_now;
END;
$$;
REVOKE ALL ON FUNCTION withdraw_hns_root_import_readiness_ownership_v1(TEXT) FROM PUBLIC;
ALTER FUNCTION withdraw_hns_root_import_readiness_ownership_v1(TEXT) SECURITY DEFINER;

DO $pin_withdrawal_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION finalize_hns_root_import_observation_job_legacy_v1(text,text,bigint,text,text,bytea,text,text) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION withdraw_hns_root_import_readiness_ownership_v1(text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_withdrawal_privileges$;
