-- Readiness ownership corrections: the claim/handover serialization, the
-- stale-ready refresh, the handover replacement work and the legacy gate.
--
-- Five corrections to 0150, found by review before handover was ever enabled.
--
-- First, the claim/handover lease race. Both claim functions read the
-- ownership marker with a plain `EXISTS`, and the handover checked for live
-- leases without any lock spanning the two. A claim could be granted between
-- the handover's check and its marker update, leaving a live legacy lease
-- after cutover. All claims now take `FOR SHARE` on the marker row in the
-- same position, and the handover takes `FOR UPDATE` on it. A claim therefore
-- either completes before the handover's check — and is seen as a live lease,
-- so the handover refuses — or starts after the marker is enabled and yields.
-- Concurrent claims still proceed together under `FOR SHARE`.
--
-- Second, the stale-ready refresh. `activation_requested` with stale
-- readiness schedules an `observe_readiness` job as a pending hold that keeps
-- the phase at `ready`, but the atomic writer accepted only
-- `checking_authority` and only a session in `observing`. A stale-ready
-- operation could never refresh: its probe result was refused as a phase
-- conflict. The writer now accepts `checking_authority` (advance) and `ready`
-- (refresh in place), and a session that is already `ready`, updating the
-- readiness result, `readiness_observed_at` and the next check together. The
-- event identity includes the new result digest, so a refresh is a new
-- accepted decision rather than a replay.
--
-- Third, the handover replacement work. Disposing a legacy readiness row for
-- an operation whose phase was `ready` with stale evidence removed the only
-- scheduled refresh without queuing its replacement. Replacement work is now
-- queued for `checking_authority` and for `ready` operations whose readiness
-- evidence is absent or older than the frozen freshness window, exactly once
-- per current generation.
--
-- Fourth, the legacy finalizer's ownership gate covered only a `ready`
-- acceptance. A post-handover `retry` or `failed` outcome could still mutate
-- the session while the lifecycle runner owned readiness. The gate now covers
-- every outcome for a lifecycle-managed `observe_root_v1` job once the marker
-- is enabled, while an idempotent replay of an already-completed job remains
-- a replay.
--
-- Fifth, the readiness writer itself now takes `FOR SHARE` on the marker
-- row, so acceptance serializes with the handover on the same ownership fact.

-- The session guard treated readiness evidence as write-once and did not
-- admit a `ready -> ready` revision, so even a writer that accepted the
-- refresh could not persist it. The refresh is the one permitted replacement
-- of readiness evidence: the status stays `ready`, the revision advances and
-- the retained identity fields remain untouched.
CREATE OR REPLACE FUNCTION guard_hns_root_import_session_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS root-import sessions are retained';
  END IF;
  IF ROW(
    NEW.root_import_session_id, NEW.actor_id, NEW.origin_kind,
    NEW.creation_intent_id, NEW.ceremony_intent_id, NEW.namespace_session_id,
    NEW.community_id, NEW.attachment_intent_id, NEW.ownership_generation,
    NEW.ownership_expected_revision, NEW.root_label, NEW.challenge_txt_value,
    NEW.start_idempotency_key, NEW.start_request_sha256, NEW.provision_job_id,
    NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.root_import_session_id, OLD.actor_id, OLD.origin_kind,
    OLD.creation_intent_id, OLD.ceremony_intent_id, OLD.namespace_session_id,
    OLD.community_id, OLD.attachment_intent_id, OLD.ownership_generation,
    OLD.ownership_expected_revision, OLD.root_label, OLD.challenge_txt_value,
    OLD.start_idempotency_key, OLD.start_request_sha256, OLD.provision_job_id,
    OLD.expires_at, OLD.created_at
  ) OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'HNS root-import session identity or revision changed';
  END IF;
  IF (OLD.ownership_result_sha256 IS NOT NULL AND NEW.ownership_result_sha256 IS DISTINCT FROM OLD.ownership_result_sha256)
    OR (OLD.provision_idempotency_key IS NOT NULL AND NEW.provision_idempotency_key IS DISTINCT FROM OLD.provision_idempotency_key)
    OR (OLD.provision_poll_request_sha256 IS NOT NULL AND NEW.provision_poll_request_sha256 IS DISTINCT FROM OLD.provision_poll_request_sha256)
    OR (OLD.observation_job_id IS NOT NULL AND NEW.observation_job_id IS DISTINCT FROM OLD.observation_job_id)
    OR (OLD.observation_idempotency_key IS NOT NULL AND NEW.observation_idempotency_key IS DISTINCT FROM OLD.observation_idempotency_key)
    OR (OLD.observation_request_sha256 IS NOT NULL AND NEW.observation_request_sha256 IS DISTINCT FROM OLD.observation_request_sha256)
    OR (
      OLD.readiness_result_bytes IS NOT NULL
      AND NEW.readiness_result_bytes IS DISTINCT FROM OLD.readiness_result_bytes
      AND NOT (OLD.status = 'ready' AND NEW.status = 'ready')
    )
    OR (
      OLD.readiness_result_sha256 IS NOT NULL
      AND NEW.readiness_result_sha256 IS DISTINCT FROM OLD.readiness_result_sha256
      AND NOT (OLD.status = 'ready' AND NEW.status = 'ready')
    ) THEN
    RAISE EXCEPTION 'HNS root-import retained evidence changed';
  END IF;
  IF NOT (
    (OLD.status = 'awaiting_ownership' AND NEW.status IN ('provisioning', 'failed', 'expired'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('awaiting_owner_update', 'failed', 'expired'))
    OR (OLD.status IN ('awaiting_owner_update', 'observing') AND NEW.status IN ('observing', 'ready', 'failed', 'expired'))
    OR (OLD.status = 'ready' AND NEW.status IN ('activated', 'expired', 'ready'))
  ) THEN
    RAISE EXCEPTION 'HNS root-import session transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

-- The lifecycle claim gains the marker lock and reads the enabled value once.
CREATE OR REPLACE FUNCTION claim_hns_root_import_lifecycle_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
) RETURNS TABLE (
  lifecycle_job_id BIGINT,
  root_import_session_id TEXT,
  job_kind TEXT,
  due_at TIMESTAMPTZ,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ,
  generation BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
  candidate hns_root_import_lifecycle_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  readiness_enabled BOOLEAN;
BEGIN
  IF input_executor_id IS NULL
    OR btrim(input_executor_id) IS DISTINCT FROM input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds IS NULL
    OR input_lease_seconds NOT BETWEEN 4 AND 120 THEN
    RAISE EXCEPTION 'invalid HNS lifecycle job claim';
  END IF;

  -- The common lock order with the handover transaction. FOR SHARE admits
  -- concurrent claims and excludes the handover's FOR UPDATE, so a claim
  -- cannot be granted in the window between the handover's lease check and
  -- its marker update.
  SELECT ownership.enabled INTO readiness_enabled
    FROM hns_root_import_execution_ownership AS ownership
   WHERE ownership.responsibility = 'readiness'
   FOR SHARE;
  readiness_enabled := coalesce(readiness_enabled, FALSE);

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
     AND (job.job_kind <> 'observe_readiness' OR readiness_enabled)
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

-- The legacy claim gains the same marker lock and uses the read value.
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
  readiness_enabled BOOLEAN;
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN
    RAISE EXCEPTION 'invalid HNS root observation claim';
  END IF;

  -- The common lock order with the handover transaction, shared with the
  -- lifecycle claim so both executors serialize on the same ownership fact.
  SELECT ownership.enabled INTO readiness_enabled
    FROM hns_root_import_execution_ownership AS ownership
   WHERE ownership.responsibility = 'readiness'
   FOR SHARE;
  readiness_enabled := coalesce(readiness_enabled, FALSE);

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
     AND NOT (
       job.operation_kind = 'observe_root_v1'
       AND readiness_enabled
       AND EXISTS (
         SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
          WHERE lifecycle_owner.root_import_session_id = job.root_import_session_id
       )
     )
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
     AND NOT (
       job.operation_kind = 'observe_root_v1'
       AND readiness_enabled
       AND EXISTS (
         SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
          WHERE lifecycle_owner.root_import_session_id = job.root_import_session_id
       )
     )
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

-- The legacy finalizer now gates every outcome, with the marker lock held.
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
  readiness_enabled BOOLEAN;
BEGIN
  IF input_outcome NOT IN ('ready', 'retry', 'failed') THEN
    RAISE EXCEPTION 'invalid HNS root observation finalization';
  END IF;
  SELECT ownership.enabled INTO readiness_enabled
    FROM hns_root_import_execution_ownership AS ownership
   WHERE ownership.responsibility = 'readiness'
   FOR SHARE;
  readiness_enabled := coalesce(readiness_enabled, FALSE);
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
  -- A completed job replays idempotently regardless of ownership; the work
  -- was accepted under the ownership that was current when it ran.
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
  -- Ownership handover gates every new outcome, not only a readiness
  -- acceptance: a post-handover retry or failure would also mutate the
  -- session while the lifecycle runner owns readiness.
  IF readiness_enabled
    AND job.operation_kind = 'observe_root_v1'
    AND EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
       WHERE lifecycle_owner.root_import_session_id = job.root_import_session_id
    )
  THEN
    RETURN QUERY SELECT 'ownership_conflict'::TEXT, session.root_import_session_id, session.revision;
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

-- The atomic readiness acceptance gains the marker lock and the in-place
-- refresh from `ready`.
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
  IF session.expires_at <= database_now THEN
    RETURN QUERY SELECT 'session_expired'::TEXT, lifecycle.revision, NULL::TEXT;
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

-- Handover replacement work now covers a stale-ready refresh.
CREATE OR REPLACE FUNCTION begin_hns_root_import_readiness_ownership_v1(
  input_evidence_ref TEXT
) RETURNS TABLE (
  outcome TEXT,
  dispositioned_jobs BIGINT,
  queued_jobs BIGINT,
  enabled_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
DECLARE
  marker hns_root_import_execution_ownership%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  dispositioned BIGINT := 0;
  queued BIGINT := 0;
BEGIN
  IF input_evidence_ref IS NULL
    OR btrim(input_evidence_ref) IS DISTINCT FROM input_evidence_ref
    OR octet_length(input_evidence_ref) NOT BETWEEN 1 AND 512
  THEN
    RAISE EXCEPTION 'invalid HNS readiness handover evidence';
  END IF;

  SELECT * INTO marker FROM hns_root_import_execution_ownership
   WHERE responsibility = 'readiness'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'marker_absent'::TEXT, 0::BIGINT, 0::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF marker.enabled THEN
    RETURN QUERY SELECT 'already_enabled'::TEXT, 0::BIGINT, 0::BIGINT, marker.enabled_at;
    RETURN;
  END IF;

  -- The marker's FOR UPDATE is held for the rest of this transaction, and
  -- every claim takes FOR SHARE on the same row, so no claim can be granted
  -- between this check and the marker update below.
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

  UPDATE hns_root_import_observation_jobs AS job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'readiness_ownership_transferred', completed_at = database_now,
         updated_at = database_now
   WHERE job.operation_kind = 'observe_root_v1'
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND EXISTS (
       SELECT 1 FROM hns_root_import_lifecycle AS lifecycle
        WHERE lifecycle.root_import_session_id = job.root_import_session_id
     );
  GET DIAGNOSTICS dispositioned = ROW_COUNT;

  -- Replacement work for the current generation exactly once. Readiness is
  -- the next evidence in `checking_authority`, and a `ready` operation with
  -- absent or stale readiness needs the refresh the disposed legacy row would
  -- have performed.
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
  GET DIAGNOSTICS queued = ROW_COUNT;

  UPDATE hns_root_import_execution_ownership
     SET enabled = TRUE,
         enabled_at = database_now,
         evidence_ref = input_evidence_ref,
         updated_at = database_now
   WHERE responsibility = 'readiness';

  RETURN QUERY SELECT 'enabled'::TEXT, dispositioned, queued, database_now;
END;
$$;

ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) SECURITY DEFINER;
ALTER FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) SECURITY DEFINER;
ALTER FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) SECURITY DEFINER;
ALTER FUNCTION commit_hns_root_import_readiness_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, BYTEA, TEXT
) SECURITY DEFINER;
ALTER FUNCTION begin_hns_root_import_readiness_ownership_v1(TEXT) SECURITY DEFINER;
REVOKE ALL ON FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION commit_hns_root_import_readiness_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, BYTEA, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_hns_root_import_readiness_ownership_v1(TEXT) FROM PUBLIC;

DO $pin_readiness_corrections$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_observation_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_readiness_v1(text,bigint,text,bigint,bigint,bytea,text) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION begin_hns_root_import_readiness_ownership_v1(text) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION guard_hns_root_import_session_change() SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_readiness_corrections$;
