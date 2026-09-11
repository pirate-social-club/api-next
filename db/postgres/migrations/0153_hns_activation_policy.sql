-- Activation acceptance corrections: pre-flight authorization, the
-- wire-digest binding and the policy's requested work — spec 012, "Execution
-- ownership and readiness handover" and "Activation and the public contract".
--
-- Three corrections to 0152, which wrote a literal successful transition and
-- no requested work.
--
-- First, a pre-flight authorization. The activation command's effects must
-- roll back when the command is refused, but the stale-readiness policy is a
-- pending hold that schedules exactly one `observe_readiness` refresh and must
-- survive the refusal. `authorize_hns_root_import_activation_v1` runs as its
-- own statement before the effects transaction: it commits the pending hold
-- and its refresh work when readiness is stale (or already pending, in which
-- case it changes nothing), and otherwise returns `authorized` without
-- writing. A later `commit_hns_root_import_activation_v1` at the end of the
-- effects transaction revalidates everything under the locks, so the
-- authorized decision cannot outrun a state change.
--
-- Second, the current-view binding now carries the wire digest of the
-- observed resource and is compared with the operation's effective
-- encoded-resource digest under the lifecycle lock. After adoption that is
-- the adopted covenant digest. The gatherer still establishes the chain
-- attribution and the encoding; SQL enforces the binding it can verify.
--
-- Third, a successful activation schedules the policy's initial retention
-- review (`retention_review_v1`: seven days after the terminal decision) as
-- requested work in the same decision that activates the operation.

CREATE OR REPLACE FUNCTION authorize_hns_root_import_activation_v1(
  input_session_id TEXT,
  input_expected_session_revision BIGINT,
  input_expected_lifecycle_revision BIGINT,
  input_expected_generation BIGINT,
  input_publish_plan_sha256 TEXT,
  input_readiness_result_sha256 TEXT,
  input_activation_identity TEXT,
  input_current_observed_at TIMESTAMPTZ,
  input_current_resource_sha256 TEXT,
  input_current_qualifying BOOLEAN
) RETURNS TABLE (outcome TEXT, revision BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  database_now TIMESTAMPTZ;
  committed RECORD;
BEGIN
  IF input_session_id IS NULL
    OR length(btrim(input_session_id)) = 0
    OR btrim(input_session_id) IS DISTINCT FROM input_session_id
    OR input_expected_session_revision IS NULL
    OR input_expected_session_revision <= 0
    OR (input_expected_lifecycle_revision IS NOT NULL AND input_expected_lifecycle_revision <= 0)
    OR (input_expected_generation IS NOT NULL AND input_expected_generation <= 0)
    OR input_publish_plan_sha256 IS NULL
    OR input_publish_plan_sha256 !~ '^[0-9a-f]{64}$'
    OR input_readiness_result_sha256 IS NULL
    OR input_readiness_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_activation_identity IS NULL
    OR length(btrim(input_activation_identity)) = 0
    OR btrim(input_activation_identity) IS DISTINCT FROM input_activation_identity
    OR octet_length(input_activation_identity) > 256
    OR (input_current_resource_sha256 IS NOT NULL AND input_current_resource_sha256 !~ '^[0-9a-f]{64}$')
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle activation input';
  END IF;

  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  database_now := clock_timestamp();
  IF session.root_import_session_id IS NULL THEN
    RETURN QUERY SELECT 'session_absent'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM hns_root_import_lifecycle_history
     WHERE root_import_session_id = input_session_id
       AND event_id = 'activation:' || input_activation_identity
  ) THEN
    RETURN QUERY SELECT 'replayed'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  IF lifecycle.phase IS DISTINCT FROM 'ready' THEN
    RETURN QUERY SELECT 'phase_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_expected_lifecycle_revision IS NOT NULL
    AND lifecycle.revision IS DISTINCT FROM input_expected_lifecycle_revision
  THEN
    RETURN QUERY SELECT 'revision_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_expected_generation IS NOT NULL
    AND lifecycle.generation IS DISTINCT FROM input_expected_generation
  THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF session.status IS DISTINCT FROM 'ready'
    OR session.revision IS DISTINCT FROM input_expected_session_revision
  THEN
    RETURN QUERY SELECT 'session_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF session.publish_plan_sha256 IS DISTINCT FROM input_publish_plan_sha256 THEN
    RETURN QUERY SELECT 'plan_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF session.readiness_result_sha256 IS DISTINCT FROM input_readiness_result_sha256 THEN
    RETURN QUERY SELECT 'readiness_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  -- Stale readiness is the one refusal that records a durable pending hold:
  -- it schedules exactly one readiness refresh per pending episode and keeps
  -- the phase at ready, matching the pure transition policy's pending hold.
  IF lifecycle.readiness_observed_at IS NULL
    OR lifecycle.readiness_observed_at <= database_now - interval '1800 seconds'
  THEN
    IF lifecycle.pending_reason = 'readiness_evidence_stale'
      AND EXISTS (
        SELECT 1 FROM hns_root_import_lifecycle_jobs AS pending_job
         WHERE pending_job.root_import_session_id = input_session_id
           AND pending_job.job_kind = 'observe_readiness'
           AND pending_job.generation = lifecycle.generation
           AND pending_job.state IN ('queued', 'leased')
      )
    THEN
      RETURN QUERY SELECT 'readiness_pending'::TEXT, lifecycle.revision;
      RETURN;
    END IF;
    SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
      input_session_id,
      lifecycle.revision,
      'activation-pending:' || input_activation_identity,
      'activation_requested',
      'pending',
      'readiness_evidence_stale',
      'ready',
      jsonb_build_object(
        'pending_reason', 'readiness_evidence_stale',
        'next_check_at', database_now + interval '900 seconds'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'kind', 'observe_readiness',
          'due_at', database_now + interval '900 seconds'
        )
      )
    );
    IF committed.outcome IS DISTINCT FROM 'pending' THEN
      RETURN QUERY SELECT 'readiness_pending'::TEXT, lifecycle.revision;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'readiness_pending'::TEXT, committed.revision;
    RETURN;
  END IF;

  IF input_expected_lifecycle_revision IS NULL
    OR input_expected_generation IS NULL
    OR input_current_observed_at IS NULL
    OR input_current_resource_sha256 IS NULL
    OR input_current_qualifying IS NULL
  THEN
    RETURN QUERY SELECT 'evidence_required'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_current_qualifying IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'current_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_current_observed_at > database_now
    OR input_current_observed_at <= database_now - interval '1800 seconds'
  THEN
    RETURN QUERY SELECT 'current_stale'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF lifecycle.plan_encoded_resource_sha256 IS NULL
    OR input_current_resource_sha256 IS DISTINCT FROM lifecycle.plan_encoded_resource_sha256
  THEN
    RETURN QUERY SELECT 'current_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'authorized'::TEXT, lifecycle.revision;
END;
$$;

REVOKE ALL ON FUNCTION authorize_hns_root_import_activation_v1(
  TEXT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN
) FROM PUBLIC;
ALTER FUNCTION authorize_hns_root_import_activation_v1(
  TEXT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN
) SECURITY DEFINER;

-- The committing half, revalidated at the end of the effects transaction. It
-- adds the wire-digest binding and the policy's initial retention review.
CREATE OR REPLACE FUNCTION commit_hns_root_import_activation_v1(
  input_session_id TEXT,
  input_expected_session_revision BIGINT,
  input_expected_lifecycle_revision BIGINT,
  input_expected_generation BIGINT,
  input_publish_plan_sha256 TEXT,
  input_readiness_result_sha256 TEXT,
  input_activation_identity TEXT,
  input_current_observed_at TIMESTAMPTZ,
  input_current_resource_sha256 TEXT,
  input_current_qualifying BOOLEAN
) RETURNS TABLE (outcome TEXT, revision BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  database_now TIMESTAMPTZ;
  committed RECORD;
BEGIN
  IF input_session_id IS NULL
    OR length(btrim(input_session_id)) = 0
    OR btrim(input_session_id) IS DISTINCT FROM input_session_id
    OR input_expected_session_revision IS NULL
    OR input_expected_session_revision <= 0
    OR (input_expected_lifecycle_revision IS NOT NULL AND input_expected_lifecycle_revision <= 0)
    OR (input_expected_generation IS NOT NULL AND input_expected_generation <= 0)
    OR input_publish_plan_sha256 IS NULL
    OR input_publish_plan_sha256 !~ '^[0-9a-f]{64}$'
    OR input_readiness_result_sha256 IS NULL
    OR input_readiness_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_activation_identity IS NULL
    OR length(btrim(input_activation_identity)) = 0
    OR btrim(input_activation_identity) IS DISTINCT FROM input_activation_identity
    OR octet_length(input_activation_identity) > 256
    OR (input_current_resource_sha256 IS NOT NULL AND input_current_resource_sha256 !~ '^[0-9a-f]{64}$')
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle activation input';
  END IF;

  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO session FROM hns_root_import_sessions
   WHERE root_import_session_id = input_session_id
   FOR UPDATE;
  database_now := clock_timestamp();
  IF session.root_import_session_id IS NULL THEN
    RETURN QUERY SELECT 'session_absent'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM hns_root_import_lifecycle_history
     WHERE root_import_session_id = input_session_id
       AND event_id = 'activation:' || input_activation_identity
  ) THEN
    RETURN QUERY SELECT 'replayed'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  IF lifecycle.phase IS DISTINCT FROM 'ready' THEN
    RETURN QUERY SELECT 'phase_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_expected_lifecycle_revision IS NULL
    OR input_expected_generation IS NULL
    OR input_current_observed_at IS NULL
    OR input_current_resource_sha256 IS NULL
    OR input_current_qualifying IS NULL
  THEN
    RETURN QUERY SELECT 'evidence_required'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF lifecycle.revision IS DISTINCT FROM input_expected_lifecycle_revision THEN
    RETURN QUERY SELECT 'revision_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF lifecycle.generation IS DISTINCT FROM input_expected_generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF session.status IS DISTINCT FROM 'ready'
    OR session.revision IS DISTINCT FROM input_expected_session_revision
  THEN
    RETURN QUERY SELECT 'session_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF session.publish_plan_sha256 IS DISTINCT FROM input_publish_plan_sha256 THEN
    RETURN QUERY SELECT 'plan_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF session.readiness_result_sha256 IS DISTINCT FROM input_readiness_result_sha256 THEN
    RETURN QUERY SELECT 'readiness_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF lifecycle.readiness_observed_at IS NULL
    OR lifecycle.readiness_observed_at <= database_now - interval '1800 seconds'
  THEN
    RETURN QUERY SELECT 'readiness_stale'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_current_qualifying IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'current_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_current_observed_at > database_now
    OR input_current_observed_at <= database_now - interval '1800 seconds'
  THEN
    RETURN QUERY SELECT 'current_stale'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  -- The binding SQL can verify: the observed wire digest must be the
  -- operation's effective, generation-bound encoded-resource digest.
  IF lifecycle.plan_encoded_resource_sha256 IS NULL
    OR input_current_resource_sha256 IS DISTINCT FROM lifecycle.plan_encoded_resource_sha256
  THEN
    RETURN QUERY SELECT 'current_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

  SELECT * INTO committed FROM commit_hns_root_import_lifecycle_decision_v1(
    input_session_id,
    lifecycle.revision,
    'activation:' || input_activation_identity,
    'activation_requested',
    'transition',
    'activated',
    'activated',
    '{}'::jsonb,
    jsonb_build_array(
      jsonb_build_object(
        'kind', 'retention_review',
        'due_at', database_now + interval '604800 seconds'
      )
    )
  );
  IF committed.outcome = 'transition' THEN
    RETURN QUERY SELECT 'activated'::TEXT, committed.revision;
    RETURN;
  END IF;
  IF committed.outcome = 'replay' THEN
    RETURN QUERY SELECT 'replayed'::TEXT, committed.revision;
    RETURN;
  END IF;
  RETURN QUERY SELECT committed.outcome::TEXT, committed.revision;
END;
$$;

REVOKE ALL ON FUNCTION commit_hns_root_import_activation_v1(
  TEXT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN
) FROM PUBLIC;
ALTER FUNCTION commit_hns_root_import_activation_v1(
  TEXT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN
) SECURITY DEFINER;

DO $pin_activation_policy$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION authorize_hns_root_import_activation_v1(text,bigint,bigint,bigint,text,text,text,timestamptz,text,boolean) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_activation_v1(text,bigint,bigint,bigint,text,text,text,timestamptz,text,boolean) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_activation_policy$;
