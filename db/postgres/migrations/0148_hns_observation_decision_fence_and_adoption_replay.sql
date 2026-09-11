-- Complete the observation-write fence and make adoption replay-safe.
--
-- Two defects remained after 0145 and 0146. Both were found by the
-- independent review of those migrations, not by a failing test.
--
-- First, the observation writer's fence checked the job lease but not the job
-- kind, the operation generation, or the decision that accepted the reading,
-- and it stored a caller-supplied observed_at without any bound. Because the
-- function is SECURITY DEFINER and reachable by the runtime role, the holder
-- of any still-valid lease on the session — an old-generation lease after
-- adoption, or the retention reviewer's lease on the same operation — could
-- write a summary through the SQL function directly, and the summary is what
-- the public projection reports as server evidence. The writer now:
--
--   * requires the claimed job's kind to match the view it asserts;
--   * reads the operation row under its own lock and requires the generation
--     the observation was taken under, so a lease issued against a superseded
--     generation cannot write;
--   * binds the summary to one accepted decision: the history row named by
--     event identity, with outcome `transition` or `pending` (the two outcomes
--     the commit function gives an accepted observation), `revision_after`
--     equal to the row's current revision, and `new_phase` equal to the row's
--     current phase. A rejection row is not an accepted observation, and a
--     replay wrote no new history, so neither substitutes for the decision;
--   * refuses an observed_at in the future beyond a bounded clock-skew
--     tolerance and an observed_at older than the caller's validated freshness
--     window, both measured against the database clock;
--   * stamps `last_observation_recorded_at` from the database clock, so the
--     time the server recorded the reading is not caller-controlled either.
--
-- Second, adoption rebound the operation before it knew whether the
-- transition would commit. When the commit function returned its
-- non-raising replay outcome for an existing `recovery:<evidence_ref>`
-- identity, generation had already incremented, the plan digest was rebound
-- and the anchor, finality deadline and readiness evidence were cleared,
-- while the phase had not moved and the operator's authorization was
-- unspent. Rebinding now happens only after an explicitly successful
-- transition and atomically with authorization consumption. Every other
-- outcome — replay, a refusal, or a raise — leaves generation, digest,
-- anchors and authorization untouched.

ALTER TABLE hns_root_import_lifecycle
  ADD COLUMN last_observation_recorded_at TIMESTAMPTZ;

-- Rows written before the column existed get the observation's own timestamp
-- as the best available record of when the server persisted it.
UPDATE hns_root_import_lifecycle
   SET last_observation_recorded_at = last_observation_at
 WHERE last_observation_view IS NOT NULL;

ALTER TABLE hns_root_import_lifecycle
  DROP CONSTRAINT hns_root_import_lifecycle_observation_shape;

ALTER TABLE hns_root_import_lifecycle
  ADD CONSTRAINT hns_root_import_lifecycle_observation_shape CHECK (
    num_nulls(
      last_observation_view,
      last_observation_resource_sha256,
      last_observation_tip_height,
      last_observation_at,
      last_observation_recorded_at
    ) IN (0, 5)
    AND (last_observation_view IS NULL OR last_observation_view IN ('current', 'safe'))
    AND (
      last_observation_resource_sha256 IS NULL
      OR last_observation_resource_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (
      last_observation_tip_height IS NULL
      OR (last_observation_tip_height > 0 AND last_observation_tip_height <= 9007199254740991)
    )
    AND (
      last_observation_update_inclusion_height IS NULL
      OR (
        last_observation_tip_height IS NOT NULL
        AND last_observation_update_inclusion_height > 0
        AND last_observation_update_inclusion_height <= last_observation_tip_height
      )
    )
    AND (
      last_observation_commitment_height IS NULL
      OR (
        last_observation_tip_height IS NOT NULL
        AND last_observation_commitment_height > 0
        AND last_observation_commitment_height <= last_observation_tip_height
      )
    )
  );

DROP FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ
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
  input_expected_generation BIGINT,
  input_freshness_seconds INTEGER
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  decision hns_root_import_lifecycle_history%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  expected_job_kind TEXT;
BEGIN
  expected_job_kind := CASE input_view
    WHEN 'current' THEN 'observe_current'
    WHEN 'safe' THEN 'observe_safe'
  END;
  IF expected_job_kind IS NULL
    OR input_resource_sha256 !~ '^[0-9a-f]{64}$'
    OR input_tip_height IS NULL
    OR input_tip_height <= 0
    OR input_observed_at IS NULL
    OR input_decision_event_id IS NULL
    OR btrim(input_decision_event_id) <> input_decision_event_id
    OR input_expected_generation IS NULL
    OR input_expected_generation < 1
    OR input_freshness_seconds IS NULL
    OR input_freshness_seconds NOT BETWEEN 1 AND 86400
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle observation evidence';
  END IF;
  -- The reading is the server's own; an observation cannot have happened in
  -- the future. The tolerance bounds clock skew between the observer and the
  -- database rather than extending the window.
  IF input_observed_at > database_now + interval '30 seconds' THEN
    RETURN 'observation_in_future';
  END IF;
  IF input_observed_at <= database_now - input_freshness_seconds * interval '1 second' THEN
    RETURN 'observation_stale';
  END IF;
  SELECT * INTO job FROM hns_root_import_lifecycle_jobs
   WHERE lifecycle_job_id = input_lifecycle_job_id
   FOR UPDATE;
  IF NOT FOUND
    OR job.root_import_session_id <> input_session_id
    OR job.state <> 'leased'
    OR job.leased_by IS DISTINCT FROM input_executor_id
    OR job.lease_fence <> input_lease_fence
    OR job.lease_expires_at <= database_now
  THEN
    RETURN 'lease_conflict';
  END IF;
  IF job.job_kind <> expected_job_kind THEN
    RETURN 'job_kind_mismatch';
  END IF;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'lifecycle_absent'; END IF;
  IF lifecycle.generation <> input_expected_generation THEN
    RETURN 'generation_conflict';
  END IF;
  SELECT * INTO decision FROM hns_root_import_lifecycle_history
   WHERE root_import_session_id = input_session_id
     AND event_id = input_decision_event_id;
  IF NOT FOUND
    OR decision.outcome NOT IN ('transition', 'pending')
    OR decision.revision_after IS DISTINCT FROM lifecycle.revision
    OR decision.new_phase IS DISTINCT FROM lifecycle.phase
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
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT, BIGINT, INTEGER
) FROM PUBLIC;
ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT, BIGINT, INTEGER
) SECURITY DEFINER;

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
      -- Adoption binds to attributed bytes. Without them there is nothing to
      -- bind to, and a finding that supports adoption should never lack them.
      RETURN QUERY SELECT 'adoption_evidence_missing'::TEXT, lifecycle.revision,
                          lifecycle.generation;
      RETURN;
    END IF;
    IF input_target_phase <> 'checking_publication' THEN
      -- Every later phase asserts evidence this rebinding has just discarded.
      -- Adoption re-enters the checking phase and earns the rest again.
      RETURN QUERY SELECT 'adoption_target_invalid'::TEXT, lifecycle.revision,
                          lifecycle.generation;
      RETURN;
    END IF;
  END IF;

  -- Decide first, and only then rebind. The commit function returns a
  -- non-raising `replay` outcome when the event identity already exists; a
  -- replay must not move the generation, rewrite the digest, clear the
  -- anchors, or spend the authorization. Gating every rebinding on an
  -- explicit `transition` keeps that invariant local to this function rather
  -- than resting on which outcome the callee happens to return.
  SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
    input_session_id,
    lifecycle.revision,
    'recovery:' || input_evidence_ref,
    'recovery_decided',
    'transition',
    'recovery_' || recovery_grant.action || ':' || finding.reason,
    input_target_phase,
    '{}'::jsonb,
    coalesce(input_requested_work, '[]'::jsonb)
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

DO $pin_observation_fence_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(text,bigint,text,bigint,text,text,bigint,bigint,bigint,timestamptz,text,bigint,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION apply_hns_root_import_recovery_v1(text,text,bigint,text,jsonb,integer) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_observation_fence_privileges$;
