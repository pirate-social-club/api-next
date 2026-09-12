-- HNS single-owner readiness cutover.
--
-- Ratified specification: spec 012 section "HNS single-owner readiness
-- cutover - 2026-09-11" (anchor hns-single-owner-readiness-cutover-v1).
--
-- This is the removal migration. It preserves valid queued or leased
-- current-generation lifecycle readiness work, dispositions queued legacy
-- readiness work with `readiness_single_owner_cutover`, provisions exactly one
-- readiness successor where the phase supports it, and refuses with identified
-- blockers when a live legacy lease or a session without a lifecycle row
-- cannot be represented safely. It then makes `observe_readiness` claimable
-- without the ownership marker, strips the legacy readiness acceptance from
-- the observation finalizer, and drops the marker, the handover and
-- withdrawal functions, and the private legacy finalizer. Teardown and
-- renewal routes are untouched.
--
-- Historical migrations, evidence and import/recovery data remain history,
-- not compatibility code.

-- 1. Refuse unsafe cutover states and serialize against claims. The marker
--    row lock is the common lock order every old claim and finalizer takes
--    FOR SHARE, so no claim is granted between this check and the schema
--    replacement below.
DO $cutover_preflight$
DECLARE
  database_now TIMESTAMPTZ := clock_timestamp();
  blockers TEXT;
BEGIN
  IF to_regclass('hns_root_import_execution_ownership') IS NOT NULL THEN
    PERFORM 1 FROM hns_root_import_execution_ownership
     WHERE responsibility = 'readiness'
     FOR UPDATE;
  END IF;

  SELECT string_agg(entry, ', ' ORDER BY entry) INTO blockers
    FROM (
      SELECT job.observation_job_id || ' [' || job.root_import_session_id || ']' AS entry
        FROM hns_root_import_observation_jobs AS job
       WHERE job.operation_kind = 'observe_root_v1'
         AND job.state = 'leased'
         AND job.lease_expires_at > database_now
    ) AS live_leases;
  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION 'readiness_single_owner_cutover_blocked: live legacy readiness lease: %', blockers;
  END IF;

  SELECT string_agg(DISTINCT session_id, ', ' ORDER BY session_id) INTO blockers
    FROM (
      SELECT job.root_import_session_id AS session_id
        FROM hns_root_import_observation_jobs AS job
       WHERE job.operation_kind = 'observe_root_v1'
         AND (
           job.state = 'queued'
           OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
         )
         AND NOT EXISTS (
           SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
            WHERE lifecycle.root_import_session_id = job.root_import_session_id
         )
    ) AS unresolved_sessions;
  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION
      'readiness_single_owner_cutover_blocked: session without lifecycle row requires recovery before removal: %',
      blockers;
  END IF;
END;
$cutover_preflight$;

-- 2. Disposition queued legacy readiness work for lifecycle-managed sessions
--    and provision the exactly-one readiness successor. A valid queued or
--    leased current-generation lifecycle readiness job is preserved and
--    counted as that successor.
CREATE TABLE hns_readiness_single_owner_cutover_receipt (
    cutover_receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    applied_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    dispositioned_jobs bigint NOT NULL,
    successor_jobs bigint NOT NULL,
    legacy_readiness_functions bigint,
    readiness_writers bigint,
    ownership_functions bigint,
    CONSTRAINT hns_readiness_single_owner_cutover_receipt_counts CHECK (
      dispositioned_jobs >= 0 AND successor_jobs >= 0
    )
);

DO $cutover_disposition$
DECLARE
  database_now TIMESTAMPTZ := clock_timestamp();
  dispositioned BIGINT := 0;
  successors BIGINT := 0;
BEGIN
  UPDATE hns_root_import_observation_jobs AS job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'readiness_single_owner_cutover',
         completed_at = database_now, updated_at = database_now
   WHERE job.operation_kind = 'observe_root_v1'
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     );
  GET DIAGNOSTICS dispositioned = ROW_COUNT;

  INSERT INTO hns_root_import_lifecycle_jobs (
    root_import_session_id, job_kind, due_at, generation
  )
  SELECT lifecycle.root_import_session_id, 'observe_readiness',
         database_now, lifecycle.generation
    FROM hns_root_import_lifecycle AS lifecycle
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
       SELECT 1 FROM hns_root_import_lifecycle_jobs AS pending
        WHERE pending.root_import_session_id = lifecycle.root_import_session_id
          AND pending.job_kind = 'observe_readiness'
          AND pending.generation = lifecycle.generation
          AND pending.state IN ('queued', 'leased')
     );
  GET DIAGNOSTICS successors = ROW_COUNT;

  -- A fresh baseline has no cutover work and stays deterministic; a real
  -- cutover records its counts once.
  IF dispositioned > 0 OR successors > 0 THEN
    INSERT INTO hns_readiness_single_owner_cutover_receipt (
      dispositioned_jobs, successor_jobs
    ) VALUES (dispositioned, successors);
  END IF;
END;
$cutover_disposition$;

-- 3. One claimant and one writer. The lifecycle claim performs
--    `observe_readiness` unconditionally; the legacy readiness acceptance is
--    removed from the observation claim and the public finalizer, which keeps
--    only teardown handling.
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
      WHERE job.generation < lifecycle.generation
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
CREATE OR REPLACE FUNCTION claim_hns_root_import_observation_job_v1(input_executor_id text, input_lease_seconds integer) RETURNS TABLE(observation_job_id text, root_import_session_id text, operation_kind text, request_bytes bytea, request_sha256 text, publish_plan_bytes bytea, publish_plan_sha256 text, provision_result_bytes bytea, provision_result_sha256 text, lease_fence bigint, lease_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
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
         AND NOT EXISTS (
           SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
            WHERE lifecycle_owner.root_import_session_id = cleanup_session.root_import_session_id
         )
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
         AND NOT EXISTS (
           SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
            WHERE lifecycle_owner.root_import_session_id = cleanup_session.root_import_session_id
         )
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



END;
$$;
CREATE OR REPLACE FUNCTION commit_hns_root_import_readiness_v1(input_session_id text, input_lifecycle_job_id bigint, input_executor_id text, input_lease_fence bigint, input_expected_revision bigint, input_result_bytes bytea, input_result_sha256 text) RETURNS TABLE(outcome text, revision bigint, readiness_result_sha256 text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  result JSONB;
  database_now TIMESTAMPTZ;
  readiness_event_id TEXT;
  committed RECORD;
  problem TEXT;
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
$_$;
CREATE OR REPLACE FUNCTION finalize_hns_root_import_observation_job_v1(input_observation_job_id text, input_executor_id text, input_lease_fence bigint, input_request_sha256 text, input_outcome text, input_result_bytes bytea, input_result_sha256 text, input_failure_code text) RETURNS TABLE(outcome text, root_import_session_id text, session_revision bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
DECLARE
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
      OR NOT (
        session.status IN ('failed', 'expired')
        OR (
          session.status IN ('awaiting_owner_update', 'observing', 'ready')
          AND session.expires_at <= database_now
          AND NOT EXISTS (
           SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
            WHERE lifecycle_owner.root_import_session_id = session.root_import_session_id
         )
        )
      )
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
      IF session.status NOT IN ('failed', 'expired') THEN
        UPDATE hns_root_import_sessions
           SET status = 'expired', revision = session.revision + 1,
               updated_at = database_now
         WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
        RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id,
                            session.revision + 1;
      ELSE
        RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision;
      END IF;
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
    IF session.status NOT IN ('failed', 'expired') THEN
      UPDATE hns_root_import_sessions
         SET status = 'expired', revision = session.revision + 1,
             updated_at = database_now
       WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
      RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id,
                          session.revision + 1;
    ELSE
      RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;

END;
$_$;
DROP FUNCTION finalize_hns_root_import_observation_job_legacy_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
);

-- 4. Remove the ownership controls and their functions. No marker, no
--    forward handover and no reverse withdrawal remain callable.
DROP TABLE hns_root_import_execution_ownership;
DROP FUNCTION begin_hns_root_import_readiness_ownership_v1(TEXT);
DROP FUNCTION withdraw_hns_root_import_readiness_ownership_v1(TEXT);

-- 5. Record the target-schema readback and assert the single-owner invariant.
DO $cutover_receipt$
DECLARE
  legacy_functions BIGINT;
  writers BIGINT;
  ownership_function_count BIGINT;
BEGIN
  SELECT count(*) INTO legacy_functions
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = current_schema()
     AND procedure.proname IN (
       'begin_hns_root_import_readiness_ownership_v1',
       'withdraw_hns_root_import_readiness_ownership_v1',
       'finalize_hns_root_import_observation_job_legacy_v1'
     );
  SELECT count(*) INTO writers
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = current_schema()
     AND procedure.proname = 'commit_hns_root_import_readiness_v1';
  SELECT count(*) INTO ownership_function_count
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
   WHERE namespace.nspname = current_schema()
     AND procedure.proname LIKE '%readiness_ownership%';
  IF legacy_functions <> 0 THEN
    RAISE EXCEPTION 'readiness_single_owner_cutover_incomplete: legacy readiness functions remain: %',
      legacy_functions;
  END IF;
  IF writers <> 1 THEN
    RAISE EXCEPTION 'readiness_single_owner_cutover_incomplete: expected one readiness writer, found %',
      writers;
  END IF;
  IF to_regclass('hns_root_import_execution_ownership') IS NOT NULL THEN
    RAISE EXCEPTION 'readiness_single_owner_cutover_incomplete: ownership marker table remains';
  END IF;
  UPDATE hns_readiness_single_owner_cutover_receipt
     SET legacy_readiness_functions = legacy_functions,
         readiness_writers = writers,
         ownership_functions = ownership_function_count
   WHERE cutover_receipt_id = (
     SELECT max(cutover_receipt_id) FROM hns_readiness_single_owner_cutover_receipt
   );
END;
$cutover_receipt$;
