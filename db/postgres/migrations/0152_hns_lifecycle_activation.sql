-- Lifecycle-aware activation: the `activation_requested` decision commits in
-- the existing activation transaction — spec 012, "Execution ownership and
-- readiness handover" (ratified 2026-09-10) and "Activation and the public
-- contract".
--
-- The activation command remains the existing explicit path and its
-- database-only activation architecture is unchanged: the DNS, app-host and
-- sale effects, the session update and the activation operation all commit in
-- the repository's one transaction. This function adds the lifecycle half:
-- under the operation's row lock it revalidates the lifecycle phase and
-- revision, the generation, the stored plan and readiness digests, the
-- readiness freshness window and a pre-gathered current-view evidence binding,
-- then commits the `activation_requested` decision in the same transaction.
-- A refusal changes nothing and the repository maps it to a conflict, so a
-- lifecycle-managed activation cannot land without fresh readiness and a
-- current-control observation that qualified against the retained plan.
--
-- Current-control evidence is gathered before the transaction. The function
-- revalidates its binding under the locks — the lifecycle revision and
-- generation it was taken against, the observation time against the database
-- clock and the readiness freshness window, and that it qualified — while the
-- encoded-resource comparison itself was the gatherer's read of the chain,
-- exactly as chain facts are attributed elsewhere on this lane. The client's
-- publish-plan and readiness digests are checked against the stored session
-- values, so a caller cannot substitute another plan or readiness result.
--
-- A session with no lifecycle row is the pre-lifecycle shape; the function
-- reports `lifecycle_absent` and the existing activation path continues
-- unchanged.

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
    -- The pre-lifecycle session shape, handled by the existing path.
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

  -- An activation identity that already committed is an idempotent replay,
  -- whatever phase it left behind; the decision writer also recognises it,
  -- but the phase gate below would otherwise turn a retry into a conflict.
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
  -- A lifecycle-managed activation requires the pre-gathered current-view
  -- binding; without it the command refuses rather than activating on stale
  -- control. The pre-lifecycle path returned above.
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

  -- The pre-gathered current-view evidence must describe this operation's
  -- current state: it qualified against the retained plan, it was observed in
  -- the freshness window, it is not in the future, and it was taken against
  -- the generation this transaction is activating.
  IF input_current_qualifying IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'current_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF input_current_observed_at IS NULL
    OR input_current_observed_at > database_now
    OR input_current_observed_at <= database_now - interval '1800 seconds'
    OR input_current_resource_sha256 IS NULL
    OR input_current_resource_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RETURN QUERY SELECT 'current_stale'::TEXT, lifecycle.revision;
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
    '[]'::jsonb
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

DO $pin_activation_lifecycle$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION commit_hns_root_import_activation_v1(text,bigint,bigint,bigint,text,text,text,timestamptz,text,boolean) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_activation_lifecycle$;
