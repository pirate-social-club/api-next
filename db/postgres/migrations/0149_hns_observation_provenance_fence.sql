-- Complete the observation fence in a new migration: provenance, generation,
-- clocks and NULLs.
--
-- The independent review of 0148 found five openings, none of which rewrites
-- that committed migration:
--
--   * The accepted decision was identified by event id, outcome, revision and
--     phase only. The history table had no job, fence or generation columns,
--     so the fence could not distinguish the decision committed for the
--     claimed job from one committed for another job on the same operation.
--     History now carries `lifecycle_job_id`, `lease_fence` and `generation`,
--     the commit function populates them for job-driven decisions (null for
--     explicit commands and operator recovery), and the observation writer
--     requires the decision to match the claimed job, its fence and the
--     operation's current generation, with an event name that corresponds to
--     the view being recorded.
--   * Generation was compared against a caller-supplied
--     `input_expected_generation`. The jobs table had no generation. Jobs are
--     now stamped with the operation generation at scheduling, the claim
--     returns it, and the writer compares the claimed job's own generation to
--     the lifecycle row. A caller cannot assert a generation the job does not
--     have.
--   * The clock was read before the job and lifecycle row locks. It is now
--     read after both locks, and the lease expiry and observation-age checks
--     are evaluated against that later reading.
--   * A NULL lease fence (or session, job id or executor) slipped the
--     comparison chain, because `x <> NULL` is NULL and a NULL condition
--     does not return. Every argument is validated for NULL explicitly and
--     every row comparison uses `IS DISTINCT FROM`.
--   * A thirty-second future tolerance for `observed_at` was introduced in
--     0148 without ratification. It is removed: any `observed_at` later than
--     the post-lock database clock is refused.
--
-- A job scheduled for a superseded generation is failed with the named
-- disposition `generation_superseded` rather than left queued forever, which
-- would also keep the due-job wait loop awake. The disposition is the only
-- mutation; nothing is deleted or rewritten.

ALTER TABLE hns_root_import_lifecycle_history
  ADD COLUMN lifecycle_job_id BIGINT,
  ADD COLUMN lease_fence BIGINT,
  ADD COLUMN generation BIGINT;

-- The job identity and its lease fence are a pair: both present for a
-- job-driven decision, both absent for an explicit command or operator
-- recovery. Every new decision also records the generation it applied to;
-- historical rows predate the column and stay null, which is the honest
-- record of absent provenance rather than an invented one.
ALTER TABLE hns_root_import_lifecycle_history
  ADD CONSTRAINT hns_root_import_lifecycle_history_provenance_shape CHECK (
    (lifecycle_job_id IS NULL) = (lease_fence IS NULL)
    AND (lifecycle_job_id IS NULL OR lifecycle_job_id > 0)
    AND (lease_fence IS NULL OR lease_fence >= 0)
    AND (generation IS NULL OR generation > 0)
    AND (lifecycle_job_id IS NULL OR generation IS NOT NULL)
  );

-- Existing history rows predate the columns and stay null: they were written
-- by the explicit-command and recovery paths as well as by jobs, and
-- inventing provenance for them would be worse than recording its absence.
-- Existing queued or leased jobs inherit the operation's current generation,
-- conservatively assuming the row they were scheduled under. A job scheduled
-- before a supersession that has not run yet is caught by the claim's stale
-- disposition on its next attempt, not by guessing here.
ALTER TABLE hns_root_import_lifecycle_jobs
  ADD COLUMN generation BIGINT;

UPDATE hns_root_import_lifecycle_jobs AS job
   SET generation = lifecycle.generation
  FROM hns_root_import_lifecycle AS lifecycle
 WHERE lifecycle.root_import_session_id = job.root_import_session_id
   AND job.generation IS NULL;

-- Every job carries the generation it was scheduled under. The commit
-- function states it explicitly; this insert-time fill covers any other
-- writer and keeps the column NOT NULL without inventing a constant.
CREATE OR REPLACE FUNCTION fill_hns_root_import_lifecycle_job_generation_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation IS NULL THEN
    SELECT lifecycle.generation INTO NEW.generation
      FROM hns_root_import_lifecycle AS lifecycle
     WHERE lifecycle.root_import_session_id = NEW.root_import_session_id;
  END IF;
  IF NEW.generation IS NULL THEN
    RAISE EXCEPTION 'HNS lifecycle job requires an operation generation';
  END IF;
  IF NEW.generation <= 0 THEN
    RAISE EXCEPTION 'HNS lifecycle job generation must be positive';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_root_import_lifecycle_jobs_generation_fill
BEFORE INSERT ON hns_root_import_lifecycle_jobs
FOR EACH ROW EXECUTE FUNCTION fill_hns_root_import_lifecycle_job_generation_v1();

REVOKE ALL ON FUNCTION fill_hns_root_import_lifecycle_job_generation_v1() FROM PUBLIC;

ALTER TABLE hns_root_import_lifecycle_jobs
  ALTER COLUMN generation SET NOT NULL;
ALTER TABLE hns_root_import_lifecycle_jobs
  ADD CONSTRAINT hns_root_import_lifecycle_jobs_generation_positive CHECK (
    generation > 0
  );

DROP FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB
);

CREATE OR REPLACE FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  input_session_id TEXT,
  input_expected_revision BIGINT,
  input_event_id TEXT,
  input_event_name TEXT,
  input_outcome TEXT,
  input_decision_reason TEXT,
  input_new_phase TEXT,
  input_deadline_patch JSONB,
  input_requested_work JSONB,
  input_lifecycle_job_id BIGINT DEFAULT NULL,
  input_lease_fence BIGINT DEFAULT NULL,
  input_scheduled_generation BIGINT DEFAULT NULL
) RETURNS TABLE (outcome TEXT, revision BIGINT, replayed BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  work JSONB;
  index_ INTEGER;
  kind TEXT;
  due TIMESTAMPTZ;
  requested_generation BIGINT;
BEGIN
  IF input_session_id IS NULL
    OR length(btrim(input_session_id)) = 0
    OR btrim(input_session_id) IS DISTINCT FROM input_session_id
    OR input_event_id IS NULL
    OR length(btrim(input_event_id)) = 0
    OR btrim(input_event_id) IS DISTINCT FROM input_event_id
    OR input_outcome IS NULL
    OR input_outcome NOT IN ('transition', 'replay', 'pending', 'rejection')
    OR input_decision_reason IS NULL
    OR btrim(input_decision_reason) IS DISTINCT FROM input_decision_reason
    OR octet_length(input_decision_reason) > 512
    -- Provenance is a pair: a job identity without its fence, or the reverse,
    -- cannot describe a claimed job and is refused rather than half-recorded.
    OR ((input_lifecycle_job_id IS NULL) <> (input_lease_fence IS NULL))
    OR (input_lifecycle_job_id IS NOT NULL AND input_lifecycle_job_id <= 0)
    OR (input_lease_fence IS NOT NULL AND input_lease_fence < 0)
    OR (input_scheduled_generation IS NOT NULL AND input_scheduled_generation <= 0)
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle decision input';
  END IF;

  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
    WHERE root_import_session_id = input_session_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HNS lifecycle operation not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM hns_root_import_lifecycle_history
    WHERE root_import_session_id = input_session_id AND event_id = input_event_id
  ) THEN
    RETURN QUERY SELECT 'replay'::TEXT, lifecycle.revision, TRUE;
    RETURN;
  END IF;

  IF lifecycle.revision <> input_expected_revision THEN
    RAISE EXCEPTION 'HNS lifecycle revision conflict'
      USING ERRCODE = '40001';
  END IF;

  -- Requested work is stamped with the generation it was scheduled under.
  -- The default is the generation the decision applies to; adoption passes
  -- the post-rebinding generation explicitly, because the jobs it requests
  -- describe the operation after the rebinding, not before it.
  requested_generation := coalesce(input_scheduled_generation, lifecycle.generation);

  IF input_outcome = 'transition' OR input_outcome = 'pending' THEN
    IF input_new_phase IS NULL OR input_new_phase <> lifecycle.phase THEN
      IF input_new_phase IS NULL OR NOT hns_root_import_lifecycle_transition_allowed_v1(
        lifecycle.phase, input_new_phase
      ) THEN
        RAISE EXCEPTION 'HNS lifecycle transition not permitted: % -> %',
          lifecycle.phase, coalesce(input_new_phase, 'NULL');
      END IF;
    END IF;
    UPDATE hns_root_import_lifecycle
      SET phase = input_new_phase,
          publication_deadline_at = COALESCE(
            (input_deadline_patch->>'publication_deadline_at')::TIMESTAMPTZ,
            publication_deadline_at
          ),
          first_current_observation_at = COALESCE(
            (input_deadline_patch->>'first_current_observation_at')::TIMESTAMPTZ,
            first_current_observation_at
          ),
          finality_deadline_at = COALESCE(
            (input_deadline_patch->>'finality_deadline_at')::TIMESTAMPTZ,
            finality_deadline_at
          ),
          readiness_observed_at = CASE
            WHEN input_deadline_patch->>'clear_readiness_observed_at' = 'true' THEN NULL
            ELSE COALESCE(
              (input_deadline_patch->>'readiness_observed_at')::TIMESTAMPTZ,
              readiness_observed_at
            )
          END,
          plan_exposed_at = COALESCE(
            (input_deadline_patch->>'plan_exposed_at')::TIMESTAMPTZ,
            plan_exposed_at
          ),
          pending_reason = input_deadline_patch->>'pending_reason',
          next_check_at = (input_deadline_patch->>'next_check_at')::TIMESTAMPTZ,
          observation_count = COALESCE(
            (input_deadline_patch->>'observation_count')::BIGINT, observation_count),
          consecutive_operational_failures = COALESCE(
            (input_deadline_patch->>'consecutive_operational_failures')::BIGINT,
            consecutive_operational_failures),
          last_useful_error = input_deadline_patch->>'last_useful_error',
          last_useful_error_at = (input_deadline_patch->>'last_useful_error_at')::TIMESTAMPTZ,
          terminal_decided_at = (input_deadline_patch->>'terminal_decided_at')::TIMESTAMPTZ,
          revision = lifecycle.revision + 1,
          updated_at = database_now
      WHERE root_import_session_id = input_session_id;
    FOR index_ IN 0 .. jsonb_array_length(input_requested_work) - 1 LOOP
      work := input_requested_work->index_;
      kind := work->>'kind';
      due := (work->>'due_at')::TIMESTAMPTZ;
      IF kind IS NULL OR due IS NULL THEN
        RAISE EXCEPTION 'invalid HNS lifecycle requested work';
      END IF;
      INSERT INTO hns_root_import_lifecycle_jobs(
        root_import_session_id, job_kind, due_at, generation
      ) VALUES (input_session_id, kind, due, requested_generation);
    END LOOP;
    INSERT INTO hns_root_import_lifecycle_history(
      root_import_session_id, event_id, event_name, outcome,
      prior_phase, new_phase, decision_reason, requested_work, revision_after,
      lifecycle_job_id, lease_fence, generation
    ) VALUES (
      input_session_id, input_event_id, input_event_name, input_outcome,
      lifecycle.phase, input_new_phase, input_decision_reason,
      input_requested_work, lifecycle.revision + 1,
      input_lifecycle_job_id, input_lease_fence, lifecycle.generation
    );
    RETURN QUERY SELECT input_outcome::TEXT, lifecycle.revision + 1, FALSE;
    RETURN;
  END IF;

  INSERT INTO hns_root_import_lifecycle_history(
    root_import_session_id, event_id, event_name, outcome,
    prior_phase, new_phase, decision_reason, requested_work, revision_after,
    lifecycle_job_id, lease_fence, generation
  ) VALUES (
    input_session_id, input_event_id, input_event_name, input_outcome,
    lifecycle.phase, NULL, input_decision_reason, '[]'::jsonb, lifecycle.revision,
    input_lifecycle_job_id, input_lease_fence, lifecycle.generation
  );
  RETURN QUERY SELECT input_outcome::TEXT, lifecycle.revision, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BIGINT, BIGINT, BIGINT
) FROM PUBLIC;
ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(
  TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BIGINT, BIGINT, BIGINT
) SECURITY DEFINER;

DROP FUNCTION claim_hns_root_import_lifecycle_job_v1(TEXT, INTEGER);

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

DROP FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT, BIGINT, INTEGER
);

CREATE OR REPLACE FUNCTION record_hns_root_import_lifecycle_observation_v1(
  input_session_id TEXT,
  input_lifecycle_job_id BIGINT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_view TEXT,
  input_resource_sha256 TEXT,
  input_tip_height BIGINT,
  input_update_inclusion_height BIGINT,
  input_commitment_height BIGINT,
  input_observed_at TIMESTAMPTZ,
  input_decision_event_id TEXT,
  input_freshness_seconds INTEGER
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  decision hns_root_import_lifecycle_history%ROWTYPE;
  expected_job_kind TEXT;
  expected_event_name TEXT;
  database_now TIMESTAMPTZ;
BEGIN
  expected_job_kind := CASE input_view
    WHEN 'current' THEN 'observe_current'
    WHEN 'safe' THEN 'observe_safe'
  END;
  expected_event_name := CASE input_view
    WHEN 'current' THEN 'current_observation'
    WHEN 'safe' THEN 'safe_observation'
  END;
  -- Every argument is validated for NULL explicitly. A NULL comparison result
  -- is not TRUE and would otherwise fall through an OR chain, which is how a
  -- NULL lease fence could once have passed the fence.
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
    OR expected_job_kind IS NULL
    OR input_resource_sha256 IS NULL
    OR input_resource_sha256 !~ '^[0-9a-f]{64}$'
    OR input_tip_height IS NULL
    OR input_tip_height <= 0
    OR input_update_inclusion_height IS NOT NULL AND (
      input_update_inclusion_height <= 0 OR input_update_inclusion_height > input_tip_height
    )
    OR input_commitment_height IS NOT NULL AND (
      input_commitment_height <= 0 OR input_commitment_height > input_tip_height
    )
    OR input_observed_at IS NULL
    OR input_decision_event_id IS NULL
    OR length(btrim(input_decision_event_id)) = 0
    OR btrim(input_decision_event_id) IS DISTINCT FROM input_decision_event_id
    OR input_freshness_seconds IS NULL
    OR input_freshness_seconds NOT BETWEEN 1 AND 86400
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle observation evidence';
  END IF;

  -- Lock the job first, then the operation, the same order the runner uses.
  SELECT * INTO job FROM hns_root_import_lifecycle_jobs
   WHERE lifecycle_job_id = input_lifecycle_job_id
   FOR UPDATE;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  -- The clock is read only after both locks are held, so every check below is
  -- measured against the moment the fence actually executes.
  database_now := clock_timestamp();

  IF NOT FOUND OR job.root_import_session_id IS DISTINCT FROM input_session_id
    OR job.state IS DISTINCT FROM 'leased'
    OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence IS DISTINCT FROM input_lease_fence
    OR job.lease_expires_at <= database_now
  THEN
    RETURN 'lease_conflict';
  END IF;
  IF job.job_kind IS DISTINCT FROM expected_job_kind THEN
    RETURN 'job_kind_mismatch';
  END IF;
  IF lifecycle.root_import_session_id IS NULL THEN
    RETURN 'lifecycle_absent';
  END IF;
  -- The job's own generation, stamped at scheduling, must be the operation's
  -- current generation. The caller cannot assert a generation the job does
  -- not have.
  IF job.generation IS DISTINCT FROM lifecycle.generation THEN
    RETURN 'generation_conflict';
  END IF;
  -- Any future observation is refused. No clock-skew allowance: the producer
  -- and this database share the clock discipline the lane is built on.
  IF input_observed_at > database_now THEN
    RETURN 'observation_in_future';
  END IF;
  IF input_observed_at <= database_now - input_freshness_seconds * interval '1 second' THEN
    RETURN 'observation_stale';
  END IF;
  SELECT * INTO decision FROM hns_root_import_lifecycle_history
   WHERE root_import_session_id = input_session_id
     AND event_id = input_decision_event_id;
  IF NOT FOUND
    OR decision.outcome NOT IN ('transition', 'pending')
    OR decision.revision_after IS DISTINCT FROM lifecycle.revision
    OR decision.new_phase IS DISTINCT FROM lifecycle.phase
    OR decision.event_name IS DISTINCT FROM expected_event_name
    OR decision.lifecycle_job_id IS DISTINCT FROM input_lifecycle_job_id
    OR decision.lease_fence IS DISTINCT FROM input_lease_fence
    OR decision.generation IS DISTINCT FROM lifecycle.generation
  THEN
    RETURN 'decision_conflict';
  END IF;
  UPDATE hns_root_import_lifecycle
     SET last_observation_view = input_view,
         last_observation_resource_sha256 = input_resource_sha256,
         last_observation_tip_height = input_tip_height,
         last_observation_update_inclusion_height = input_update_inclusion_height,
         last_observation_commitment_height = input_commitment_height,
         last_observation_at = input_observed_at,
         last_observation_recorded_at = database_now,
         updated_at = database_now
   WHERE root_import_session_id = input_session_id;
  IF NOT FOUND THEN RETURN 'lifecycle_absent'; END IF;
  RETURN 'recorded';
END;
$$;

REVOKE ALL ON FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT, INTEGER
) FROM PUBLIC;
ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT, INTEGER
) SECURITY DEFINER;

-- The recovery application now passes the post-rebinding generation to the
-- jobs an adoption transition requests, because those jobs describe the
-- operation as it is after the rebinding. It also records explicit-command
-- provenance as absent rather than inventing a job.
DROP FUNCTION apply_hns_root_import_recovery_v1(TEXT, TEXT, BIGINT, TEXT, JSONB, INTEGER);

CREATE OR REPLACE FUNCTION apply_hns_root_import_recovery_v1(
  input_session_id TEXT,
  input_evidence_ref TEXT,
  input_expected_revision BIGINT,
  input_target_phase TEXT,
  input_requested_work JSONB,
  input_evidence_freshness_seconds INTEGER
) RETURNS TABLE (outcome TEXT, revision BIGINT, generation BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  finding hns_root_import_recovery_findings%ROWTYPE;
  recovery_grant hns_root_import_recovery_authorizations%ROWTYPE;
  committed RECORD;
  rebound BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_evidence_freshness_seconds IS NULL
    OR input_evidence_freshness_seconds NOT BETWEEN 1 AND 86400
  THEN
    RAISE EXCEPTION 'invalid HNS recovery evidence freshness bound';
  END IF;
  -- The row lock is held for the whole application: the generation check, the
  -- transition, the rebinding, and the single-use consumption are one
  -- serialized unit, so a concurrent application cannot interleave between
  -- them.
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT, NULL::BIGINT;
    RETURN;
  END IF;
  IF lifecycle.phase <> 'recovery_required' THEN
    RETURN QUERY SELECT 'phase_conflict'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  IF lifecycle.revision <> input_expected_revision THEN
    RETURN QUERY SELECT 'revision_conflict'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  SELECT * INTO finding FROM hns_root_import_recovery_findings
   WHERE root_import_session_id = input_session_id AND evidence_ref = input_evidence_ref;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finding_absent'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  IF finding.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  IF finding.recorded_at <= database_now - (input_evidence_freshness_seconds * interval '1 second')
  THEN
    RETURN QUERY SELECT 'evidence_stale'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  SELECT * INTO recovery_grant FROM hns_root_import_recovery_authorizations
   WHERE recovery_finding_id = finding.recovery_finding_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'authorization_absent'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  IF recovery_grant.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'authorization_consumed'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  IF recovery_grant.expires_at <= database_now THEN
    RETURN QUERY SELECT 'authorization_expired'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;
  IF recovery_grant.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision, lifecycle.generation;
    RETURN;
  END IF;

  IF recovery_grant.action = 'adopt' THEN
    IF finding.covenant_resource_sha256 IS NULL THEN
      RETURN QUERY SELECT 'adoption_evidence_missing'::TEXT, lifecycle.revision,
                          lifecycle.generation;
      RETURN;
    END IF;
    IF input_target_phase <> 'checking_publication' THEN
      RETURN QUERY SELECT 'adoption_target_invalid'::TEXT, lifecycle.revision,
                          lifecycle.generation;
      RETURN;
    END IF;
  END IF;

  -- Decide first, and only then rebind. The commit function returns a
  -- non-raising `replay` outcome when the event identity already exists; a
  -- replay must not move the generation, rewrite the digest, clear the
  -- anchors, or spend the authorization.
  SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
    input_session_id,
    lifecycle.revision,
    'recovery:' || input_evidence_ref,
    'recovery_decided',
    'transition',
    'recovery_' || recovery_grant.action || ':' || finding.reason,
    input_target_phase,
    '{}'::jsonb,
    coalesce(input_requested_work, '[]'::jsonb),
    NULL,
    NULL,
    CASE WHEN recovery_grant.action = 'adopt' THEN lifecycle.generation + 1 ELSE NULL END
  );
  IF committed.outcome IS DISTINCT FROM 'transition' THEN
    RETURN QUERY SELECT committed.outcome::TEXT, committed.revision, lifecycle.generation;
    RETURN;
  END IF;

  IF recovery_grant.action = 'adopt' THEN
    UPDATE hns_root_import_lifecycle
       SET generation = lifecycle.generation + 1,
           plan_encoded_resource_sha256 = finding.covenant_resource_sha256,
           first_current_observation_at = NULL,
           finality_deadline_at = NULL,
           readiness_observed_at = NULL,
           updated_at = database_now
     WHERE root_import_session_id = input_session_id
    RETURNING hns_root_import_lifecycle.generation INTO rebound;
  ELSE
    rebound := lifecycle.generation;
  END IF;
  UPDATE hns_root_import_recovery_authorizations
     SET consumed_at = database_now
   WHERE recovery_authorization_id = recovery_grant.recovery_authorization_id;
  RETURN QUERY SELECT 'applied'::TEXT, committed.revision, rebound;
END;
$$;

REVOKE ALL ON FUNCTION apply_hns_root_import_recovery_v1(
  TEXT, TEXT, BIGINT, TEXT, JSONB, INTEGER
) FROM PUBLIC;
ALTER FUNCTION apply_hns_root_import_recovery_v1(
  TEXT, TEXT, BIGINT, TEXT, JSONB, INTEGER
) SECURITY DEFINER;

DO $pin_fence_provenance_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb,bigint,bigint,bigint) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION claim_hns_root_import_lifecycle_job_v1(text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(text,bigint,text,bigint,text,text,bigint,bigint,bigint,timestamptz,text,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION apply_hns_root_import_recovery_v1(text,text,bigint,text,jsonb,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION fill_hns_root_import_lifecycle_job_generation_v1() SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_fence_provenance_privileges$;
