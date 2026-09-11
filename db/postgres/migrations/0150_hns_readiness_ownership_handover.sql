-- Readiness ownership handover, the atomic readiness acceptance, and the
-- retirement of schedule_activation_window — spec 012, "Execution ownership
-- and readiness handover" (ratified 2026-09-10).
--
-- The ratified ownership table moves authority readiness to the lifecycle
-- runner. This migration installs the machinery in the disabled state, as the
-- spec's sequence requires: the atomic writer, the persisted enablement
-- marker and a handover transaction that an operator runs in the separately
-- authorized rollout. Installing a schema is not evidence that the service
-- can perform readiness, so nothing here enables the handover.
--
-- Readiness probes run outside the acceptance transaction. The acceptance
-- function verifies the claimed job kind, holder, lease fence and expiry, the
-- operation generation and expected revision, the enabled marker, the
-- permitted phase and the session's readiness preconditions, then persists
-- the exact readiness result bytes and digest on the session, commits the
-- lifecycle `readiness_observed` decision with job provenance and completes
-- the leased job in one statement.
--
-- The ownership marker is a persisted row, not a runtime flag, so the legacy
-- claim, the lifecycle claim and both finalizers read the same fact. The
-- legacy readiness claimant yields lifecycle-managed operations only when the
-- marker is enabled; sessions with no lifecycle row keep the legacy
-- performer. An observation gathered before handover cannot accept readiness
-- afterwards.
--
-- `schedule_activation_window` is retired. No performer ever existed, the
-- domain vocabulary never scheduled it, activation is an explicit command,
-- and freshness checks use `observe_readiness`. Existing rows receive an
-- explicit named disposition and the job-kind constraint no longer admits the
-- kind.

CREATE TABLE hns_root_import_execution_ownership (
  responsibility TEXT PRIMARY KEY CHECK (responsibility IN ('readiness')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ,
  evidence_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Disabled means no enablement record; enabled means there is one.
  CONSTRAINT hns_root_import_execution_ownership_marker_shape CHECK (
    (enabled AND enabled_at IS NOT NULL)
    OR (NOT enabled AND enabled_at IS NULL)
  ),
  CONSTRAINT hns_root_import_execution_ownership_evidence_shape CHECK (
    evidence_ref IS NULL
    OR (btrim(evidence_ref) = evidence_ref AND octet_length(evidence_ref) BETWEEN 1 AND 512)
  )
);

INSERT INTO hns_root_import_execution_ownership (responsibility, enabled)
VALUES ('readiness', FALSE)
ON CONFLICT (responsibility) DO NOTHING;

REVOKE INSERT, UPDATE, DELETE ON hns_root_import_execution_ownership FROM PUBLIC;

-- Retire schedule_activation_window. Existing rows are failed with a named
-- disposition that preserves their identity and attempt history; the
-- constraint is replaced so no new row of that kind can be inserted.
UPDATE hns_root_import_lifecycle_jobs
   SET state = 'failed',
       leased_by = NULL,
       lease_expires_at = NULL,
       failure_code = 'schedule_activation_window_retired',
       completed_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE job_kind = 'schedule_activation_window'
   AND state IN ('queued', 'leased');

DO $retire_activation_window$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS relation ON relation.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relname = 'hns_root_import_lifecycle_jobs'
     AND con.contype = 'c'
     AND namespace.nspname = current_schema()
     AND pg_catalog.pg_get_constraintdef(con.oid) LIKE '%schedule_activation_window%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE hns_root_import_lifecycle_jobs DROP CONSTRAINT %I',
      constraint_name);
  END IF;
  ALTER TABLE hns_root_import_lifecycle_jobs
    ADD CONSTRAINT hns_root_import_lifecycle_jobs_job_kind_v2_check CHECK (
      job_kind IN (
        'observe_current', 'observe_safe', 'observe_readiness',
        'reconcile_provider', 'retention_review'
      )
    );
END;
$retire_activation_window$;

-- The lifecycle claim performs readiness work only once readiness ownership
-- is enabled. Until then an observe_readiness job stays queued and is never
-- claimed or marked successfully performed.
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
BEGIN
  IF input_executor_id IS NULL
    OR btrim(input_executor_id) IS DISTINCT FROM input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds IS NULL
    OR input_lease_seconds NOT BETWEEN 4 AND 120 THEN
    RAISE EXCEPTION 'invalid HNS lifecycle job claim';
  END IF;

  -- A job scheduled for an earlier authority generation describes a
  -- different operation. It is failed with a named disposition rather than
  -- left queued forever, which would also keep the due-job wait loop awake.
  -- SKIP LOCKED keeps a concurrent claim from blocking on a row it is about
  -- to handle itself; the skipped row is disposed by the next claim.
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
     AND (
       job.job_kind <> 'observe_readiness'
       OR EXISTS (
         SELECT 1 FROM hns_root_import_execution_ownership AS ownership
          WHERE ownership.responsibility = 'readiness' AND ownership.enabled
       )
     )
     -- The reciprocal of the observation exclusion. A legacy readiness lease
     -- taken before the lifecycle row existed is still in flight, so the
     -- lifecycle runner waits for it to drain rather than observing the same
     -- operation alongside it. The wait is bounded by that lease.
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

REVOKE ALL ON FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) FROM PUBLIC;
ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER) SECURITY DEFINER;

-- The legacy readiness claimant yields lifecycle-managed operations once the
-- marker is enabled. Sessions with no lifecycle row keep the legacy
-- performer, which is the migration matrix's pre-lifecycle shape. Teardown
-- claims are untouched: readiness ownership is not teardown ownership.
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
     -- Readiness ownership handover: once the marker is enabled, the legacy
     -- readiness claimant yields lifecycle-managed operations to the
     -- lifecycle runner. Sessions with no lifecycle row keep the legacy
     -- performer.
     AND NOT (
       job.operation_kind = 'observe_root_v1'
       AND EXISTS (
         SELECT 1 FROM hns_root_import_execution_ownership AS ownership
          WHERE ownership.responsibility = 'readiness' AND ownership.enabled
       )
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
       AND EXISTS (
         SELECT 1 FROM hns_root_import_execution_ownership AS ownership
          WHERE ownership.responsibility = 'readiness' AND ownership.enabled
       )
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
ALTER FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) SECURITY DEFINER;
REVOKE ALL ON FUNCTION claim_hns_root_import_observation_job_v1(TEXT, INTEGER) FROM PUBLIC;

-- The legacy readiness finalizer now validates ownership as well as its
-- original execution fence. A lease that survived the handover cannot accept
-- readiness for a lifecycle-managed operation; the refusal is named and
-- changes nothing.
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
  -- Ownership handover: readiness acceptance for a lifecycle-managed
  -- operation belongs to the lifecycle runner once the marker is enabled. A
  -- legacy lease that survived handover is refused and changes nothing.
  IF input_outcome = 'ready'
    AND job.operation_kind = 'observe_root_v1'
    AND EXISTS (
      SELECT 1 FROM hns_root_import_execution_ownership AS ownership
       WHERE ownership.responsibility = 'readiness' AND ownership.enabled
    )
    AND EXISTS (
      SELECT 1 FROM hns_root_import_lifecycle AS lifecycle_owner
       WHERE lifecycle_owner.root_import_session_id = job.root_import_session_id
    )
  THEN
    RETURN QUERY SELECT 'ownership_conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
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
ALTER FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) SECURITY DEFINER;
REVOKE ALL ON FUNCTION finalize_hns_root_import_observation_job_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BYTEA, TEXT, TEXT
) FROM PUBLIC;

-- The atomic readiness acceptance. One statement persists the readiness
-- result bytes and digest on the session, commits the lifecycle
-- `readiness_observed` transition with job provenance, and completes the
-- leased job. The probes ran outside this transaction; a refusal changes
-- nothing.
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
  IF NOT EXISTS (
    SELECT 1 FROM hns_root_import_execution_ownership AS ownership
     WHERE ownership.responsibility = 'readiness' AND ownership.enabled
  ) THEN
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
  IF lifecycle.phase IS DISTINCT FROM 'checking_authority' THEN
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
  IF session.status IS DISTINCT FROM 'observing' THEN
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

REVOKE ALL ON FUNCTION commit_hns_root_import_readiness_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, BYTEA, TEXT
) FROM PUBLIC;
ALTER FUNCTION commit_hns_root_import_readiness_v1(
  TEXT, BIGINT, TEXT, BIGINT, BIGINT, BYTEA, TEXT
) SECURITY DEFINER;

-- The handover transaction. An operator runs it once, in the separately
-- authorized rollout, after the capable service is available. It refuses
-- while a conflicting lease is live, disposes queued and expired legacy
-- readiness rows for lifecycle-managed operations with a named reason, queues
-- missing readiness work for the current generation exactly once, and only
-- then enables the marker. Repeating it changes nothing.
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

  -- Quiesce: a live legacy readiness lease on a lifecycle-managed operation
  -- is a conflicting claim. The operator retries after it finishes or
  -- expires; a stale observation cannot be accepted after handover anyway,
  -- so the handover waits rather than racing it.
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

  -- Obsolete queued or abandoned legacy readiness rows for operations the
  -- lifecycle now owns receive a named disposition. Live rows were excluded
  -- above; nothing is completed as though it had been performed.
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

  -- Unfinished readiness work is queued for the operation's current
  -- generation exactly once: only phases where readiness is the next
  -- evidence, and only when no current-generation readiness job is already
  -- queued or leased.
  INSERT INTO hns_root_import_lifecycle_jobs (
    root_import_session_id, job_kind, due_at, generation
  )
  SELECT lifecycle.root_import_session_id, 'observe_readiness',
         database_now, lifecycle.generation
    FROM hns_root_import_lifecycle AS lifecycle
   WHERE lifecycle.phase = 'checking_authority'
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

REVOKE ALL ON FUNCTION begin_hns_root_import_readiness_ownership_v1(TEXT) FROM PUBLIC;
ALTER FUNCTION begin_hns_root_import_readiness_ownership_v1(TEXT) SECURITY DEFINER;

DO $pin_readiness_ownership_privileges$
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
END;
$pin_readiness_ownership_privileges$;
