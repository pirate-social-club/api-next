-- The readiness writer must not gate on the finality deadline — spec 012,
-- "Deadline kinds": the finality window is active only in
-- `waiting_safe_commitment`, and no import deadline is active in
-- `checking_authority`, `ready` or `activated`. A qualifying safe
-- observation advances the operation out of `waiting_safe_commitment`, and
-- the finality timestamp it left behind is history, not recovery evidence.
--
-- Migration 0154 had replaced the retired session expiry with a
-- finality-deadline guard. That guard was wrong twice: it misread a
-- historical deadline as active, and its `deadline_expired` refusal was not
-- terminal for the performer, so a late-safe-commitment operation retried
-- under the frozen backoff forever while the reducer correctly rejected a
-- `deadline_reached` event outside `waiting_safe_commitment`. This migration
-- removes the guard; the marker, lease, decision, phase, revision and
-- generation fences remain, and a `ready` refresh still commits in place.
--
-- The `deadline_expired` outcome is also removed from the performer's
-- refusal set so a future writer cannot reintroduce the retry loop.
-- The retired single session expiry stops gating readiness and activation —
-- spec 012, "Expiry consumers":
--
--   "The retired single import/challenge expiry is consumed by exactly these
--    consumers ... finalizers, readiness, activation ... each of which must
--    adopt the separated clocks and hns_root_import_policy_v1 by name and may
--    not re-derive any deadline from another window's remainder."
--
-- The readiness writer accepted only a session whose `expires_at` had not
-- passed, so a lifecycle-managed operation whose publication and finality
-- windows were still valid could not accept fresh readiness after the retired
-- expiry. The phase deadline governs instead: a checking-authority operation
-- past its finality deadline is refused as recovery evidence, and a ready
-- operation has no active deadline and refreshes in place. The marker,
-- lease, decision, phase, revision and generation fences are unchanged.

CREATE OR REPLACE FUNCTION commit_hns_root_import_readiness_v1(
  input_session_id TEXT,
  input_lifecycle_job_id BIGINT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_expected_revision BIGINT,
  input_result_bytes BYTEA,
  input_result_sha256 TEXT
) RETURNS TABLE (outcome TEXT, revision BIGINT, readiness_result_sha256 TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  result JSONB;
  database_now TIMESTAMPTZ;
  readiness_event_id TEXT;
  committed RECORD;
  problem TEXT;
  readiness_enabled BOOLEAN;
BEGIN
  IF input_session_id IS NULL
    OR length(btrim(input_session_id)) = 0
    OR btrim(input_session_id) IS DISTINCT FROM input_session_id
    OR input_lifecycle_job_id IS NULL
    OR input_lifecycle_job_id <= 0
    OR input_executor_id IS NULL
    OR length(btrim(input_executor_id)) = 0
    OR btrim(input_executor_id) IS DISTINCT FROM input_executor_id
    OR input_lease_fence IS NULL
    OR input_lease_fence < 0
    OR input_expected_revision IS NULL
    OR input_expected_revision <= 0
    OR input_result_bytes IS NULL
    OR octet_length(input_result_bytes) NOT BETWEEN 1 AND 1048576
    OR input_result_sha256 IS NULL
    OR input_result_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_result_bytes), 'hex') IS DISTINCT FROM input_result_sha256
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle readiness result';
  END IF;

  SELECT ownership.enabled INTO readiness_enabled
    FROM hns_root_import_execution_ownership AS ownership
   WHERE ownership.responsibility = 'readiness'
   FOR SHARE;
  readiness_enabled := coalesce(readiness_enabled, FALSE);
  SELECT * INTO job FROM hns_root_import_lifecycle_jobs
   WHERE lifecycle_job_id = input_lifecycle_job_id
   FOR UPDATE;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  database_now := clock_timestamp();

  IF lifecycle.root_import_session_id IS NULL THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT, NULL::TEXT;
    RETURN;
  END IF;
  IF session.root_import_session_id IS NULL THEN
    RETURN QUERY SELECT 'session_absent'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;
  IF NOT readiness_enabled THEN
    RETURN QUERY SELECT 'ownership_not_enabled'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;

  readiness_event_id :=
    'readiness:' || input_lifecycle_job_id::text || ':' || input_lease_fence::text ||
    ':' || input_result_sha256;

  IF job.state = 'completed' THEN
    IF EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle_history
       WHERE root_import_session_id = input_session_id AND event_id = readiness_event_id
    ) THEN
      RETURN QUERY SELECT 'replayed'::TEXT, lifecycle.revision, input_result_sha256;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'conflict'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;
  IF job.root_import_session_id IS DISTINCT FROM input_session_id
    OR job.state IS DISTINCT FROM 'leased'
    OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence IS DISTINCT FROM input_lease_fence
    OR job.lease_expires_at <= database_now
    OR job.job_kind IS DISTINCT FROM 'observe_readiness'
    OR job.generation IS DISTINCT FROM lifecycle.generation
  THEN
    RETURN QUERY SELECT 'lease_conflict'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;
  -- Readiness is accepted in `checking_authority` as the advance to `ready`,
  -- and in `ready` as a refresh in place: activation keeps stale readiness as
  -- a pending hold and schedules this observation, so refusing `ready` made
  -- the refresh impossible.
  IF lifecycle.phase NOT IN ('checking_authority', 'ready') THEN
    RETURN QUERY SELECT 'phase_conflict'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;
  IF lifecycle.revision IS DISTINCT FROM input_expected_revision THEN
    RETURN QUERY SELECT 'revision_conflict'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;
  IF lifecycle.plan_encoded_resource_sha256 IS NULL THEN
    RETURN QUERY SELECT 'plan_absent'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;
  -- An advance comes from `observing`; a refresh comes from `ready`.
  IF session.status NOT IN ('observing', 'ready') THEN
    RETURN QUERY SELECT 'session_conflict'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;

  BEGIN
    result := convert_from(input_result_bytes, 'UTF8')::jsonb;
    IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN
      problem := 'shape';
    ELSIF result->>'version' IS DISTINCT FROM 'pirate-hns-root-import-readiness-result-v1' THEN
      problem := 'version';
    ELSIF result->>'root_import_session_id' IS DISTINCT FROM input_session_id THEN
      problem := 'session';
    ELSIF result->>'publish_plan_sha256' IS DISTINCT FROM session.publish_plan_sha256 THEN
      problem := 'plan';
    ELSIF (result->>'observed_at')::TIMESTAMPTZ > database_now THEN
      problem := 'observed_future';
    ELSIF (result->>'valid_until')::TIMESTAMPTZ <= database_now THEN
      problem := 'expired';
    ELSE
      problem := NULL;
    END IF;
  EXCEPTION WHEN others THEN
    problem := 'unreadable';
  END;
  IF problem IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid_result'::TEXT, lifecycle.revision, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
    input_session_id,
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
    '[]'::jsonb,
    input_lifecycle_job_id,
    input_lease_fence
  );
  IF committed.outcome IS DISTINCT FROM 'transition' THEN
    RETURN QUERY SELECT committed.outcome::TEXT, committed.revision, NULL::TEXT;
    RETURN;
  END IF;

  UPDATE hns_root_import_sessions
     SET status = 'ready',
         revision = session.revision + 1,
         readiness_result_bytes = input_result_bytes,
         readiness_result_sha256 = input_result_sha256,
         updated_at = database_now
   WHERE root_import_session_id = input_session_id;
  UPDATE hns_root_import_lifecycle_jobs
     SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = NULL, completed_at = database_now, updated_at = database_now
   WHERE lifecycle_job_id = input_lifecycle_job_id;
  RETURN QUERY SELECT 'ready'::TEXT, committed.revision, input_result_sha256;
END;
$$;

REVOKE ALL ON FUNCTION commit_hns_root_import_readiness_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, BYTEA, TEXT
) FROM PUBLIC;
ALTER FUNCTION commit_hns_root_import_readiness_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, BYTEA, TEXT
) SECURITY DEFINER;

DO $pin_expiry_consumers$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_readiness_v1(text,bigint,text,bigint,bigint,bytea,text) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_expiry_consumers$;
