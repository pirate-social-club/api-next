-- Three review findings on 0143 and 0144, before any of it is used against a
-- real incident.
--
-- First, the observation writer had no fence of its own. Its comment said it
-- must only be reached from inside the runner's transaction, where the job
-- lease and the operation row lock are already held — but a comment is not an
-- enforcement, and the function is SECURITY DEFINER and granted to the runtime
-- role. Any caller with EXECUTE could have written an arbitrary observation
-- summary onto any operation, and that summary is what the public projection
-- reports as server evidence. It now validates the lease the way every other
-- writer on this lane does.
--
-- Second, recovery bounded the authorization's age but never the evidence's. A
-- finding recorded weeks ago could be authorized today and applied within the
-- authorization's window, so the operator would be acting on a reading of a
-- chain that has had weeks to change. Generation fencing does not cover this:
-- the generation only moves on supersession, not on anything the owner does to
-- their own name. Both authorizing and applying now bound the evidence's age
-- explicitly, and applying re-checks it because permission is granted at one
-- moment and used at another.
--
-- Third, applying consumed the operator's single-use authorization before the
-- transition was committed. That was not in fact reachable as a defect: the
-- commit function raises on a transition the table refuses, so the whole
-- statement rolls back and the consumption with it. The ordering is inverted
-- anyway so the invariant is local to this function rather than resting on the
-- callee choosing to raise instead of to return an outcome.

DROP FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ
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
  input_observed_at TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  job hns_root_import_lifecycle_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_view NOT IN ('current', 'safe')
    OR input_resource_sha256 !~ '^[0-9a-f]{64}$'
    OR input_tip_height IS NULL
    OR input_tip_height <= 0
    OR input_observed_at IS NULL
  THEN
    RAISE EXCEPTION 'invalid HNS lifecycle observation evidence';
  END IF;
  -- The same fence the decision itself commits under: state, holder, fence and
  -- expiry. Evidence recorded by a worker that has lost its lease describes an
  -- observation nobody can vouch for.
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
  UPDATE hns_root_import_lifecycle
     SET last_observation_view = input_view,
         last_observation_resource_sha256 = input_resource_sha256,
         last_observation_tip_height = input_tip_height,
         last_observation_update_inclusion_height = input_update_inclusion_height,
         last_observation_commitment_height = input_commitment_height,
         last_observation_at = input_observed_at,
         updated_at = database_now
   WHERE root_import_session_id = input_session_id;
  IF NOT FOUND THEN RETURN 'lifecycle_absent'; END IF;
  RETURN 'recorded';
END;
$$;

DROP FUNCTION authorize_hns_root_import_recovery_v1(TEXT, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION authorize_hns_root_import_recovery_v1(
  input_session_id TEXT,
  input_evidence_ref TEXT,
  input_action TEXT,
  input_ttl_seconds INTEGER,
  input_evidence_freshness_seconds INTEGER
) RETURNS TABLE (outcome TEXT, recovery_authorization_id BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  finding hns_root_import_recovery_findings%ROWTYPE;
  existing BIGINT;
  inserted BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_ttl_seconds IS NULL OR input_ttl_seconds NOT BETWEEN 60 AND 86400
    OR input_evidence_freshness_seconds IS NULL
    OR input_evidence_freshness_seconds NOT BETWEEN 1 AND 86400
  THEN
    RAISE EXCEPTION 'invalid HNS recovery authorization window';
  END IF;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO finding FROM hns_root_import_recovery_findings
   WHERE root_import_session_id = input_session_id AND evidence_ref = input_evidence_ref;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finding_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF finding.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF finding.recorded_at <= database_now - (input_evidence_freshness_seconds * interval '1 second')
  THEN
    -- The generation only moves on supersession. It says nothing about what
    -- the owner did to their own name since this reading, so the reading's own
    -- age has to be bounded separately.
    RETURN QUERY SELECT 'evidence_stale'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF finding.supported_action IS DISTINCT FROM input_action THEN
    RETURN QUERY SELECT 'action_unsupported'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT recovery_grant.recovery_authorization_id INTO existing
    FROM hns_root_import_recovery_authorizations AS recovery_grant
   WHERE recovery_grant.recovery_finding_id = finding.recovery_finding_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'replayed'::TEXT, existing;
    RETURN;
  END IF;
  INSERT INTO hns_root_import_recovery_authorizations (
    recovery_finding_id, root_import_session_id, authority_generation,
    action, authorized_at, expires_at
  ) VALUES (
    finding.recovery_finding_id, input_session_id, finding.authority_generation,
    input_action, database_now, database_now + input_ttl_seconds * interval '1 second'
  ) RETURNING hns_root_import_recovery_authorizations.recovery_authorization_id INTO inserted;
  RETURN QUERY SELECT 'recorded'::TEXT, inserted;
END;
$$;

DROP FUNCTION apply_hns_root_import_recovery_v1(TEXT, TEXT, BIGINT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION apply_hns_root_import_recovery_v1(
  input_session_id TEXT,
  input_evidence_ref TEXT,
  input_expected_revision BIGINT,
  input_target_phase TEXT,
  input_requested_work JSONB,
  input_evidence_freshness_seconds INTEGER
) RETURNS TABLE (outcome TEXT, revision BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle hns_root_import_lifecycle%ROWTYPE;
  finding hns_root_import_recovery_findings%ROWTYPE;
  recovery_grant hns_root_import_recovery_authorizations%ROWTYPE;
  committed RECORD;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_evidence_freshness_seconds IS NULL
    OR input_evidence_freshness_seconds NOT BETWEEN 1 AND 86400
  THEN
    RAISE EXCEPTION 'invalid HNS recovery evidence freshness bound';
  END IF;
  SELECT * INTO lifecycle FROM hns_root_import_lifecycle
   WHERE root_import_session_id = input_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lifecycle_absent'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF lifecycle.phase <> 'recovery_required' THEN
    RETURN QUERY SELECT 'phase_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF lifecycle.revision <> input_expected_revision THEN
    RETURN QUERY SELECT 'revision_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  SELECT * INTO finding FROM hns_root_import_recovery_findings
   WHERE root_import_session_id = input_session_id AND evidence_ref = input_evidence_ref;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'finding_absent'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF finding.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF finding.recorded_at <= database_now - (input_evidence_freshness_seconds * interval '1 second')
  THEN
    -- Permission was granted at one moment and is being used at another. The
    -- evidence has to still be fresh now, not only when it was authorized.
    RETURN QUERY SELECT 'evidence_stale'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  SELECT * INTO recovery_grant FROM hns_root_import_recovery_authorizations
   WHERE recovery_finding_id = finding.recovery_finding_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'authorization_absent'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF recovery_grant.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'authorization_consumed'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF recovery_grant.expires_at <= database_now THEN
    RETURN QUERY SELECT 'authorization_expired'::TEXT, lifecycle.revision;
    RETURN;
  END IF;
  IF recovery_grant.authority_generation <> lifecycle.generation THEN
    RETURN QUERY SELECT 'generation_conflict'::TEXT, lifecycle.revision;
    RETURN;
  END IF;

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
    -- Nothing moved, so the operator's single-use authorization is not spent.
    RETURN QUERY SELECT committed.outcome::TEXT, committed.revision;
    RETURN;
  END IF;
  UPDATE hns_root_import_recovery_authorizations
     SET consumed_at = database_now
   WHERE recovery_authorization_id = recovery_grant.recovery_authorization_id;
  RETURN QUERY SELECT 'applied'::TEXT, committed.revision;
END;
$$;

REVOKE ALL ON FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION authorize_hns_root_import_recovery_v1(
  TEXT, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_hns_root_import_recovery_v1(
  TEXT, TEXT, BIGINT, TEXT, JSONB, INTEGER
) FROM PUBLIC;
ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(
  TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ
) SECURITY DEFINER;
ALTER FUNCTION authorize_hns_root_import_recovery_v1(
  TEXT, TEXT, TEXT, INTEGER, INTEGER
) SECURITY DEFINER;
ALTER FUNCTION apply_hns_root_import_recovery_v1(
  TEXT, TEXT, BIGINT, TEXT, JSONB, INTEGER
) SECURITY DEFINER;
DO $pin_recovery_fix_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION record_hns_root_import_lifecycle_observation_v1(text,bigint,text,bigint,text,text,bigint,bigint,bigint,timestamptz) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION authorize_hns_root_import_recovery_v1(text,text,text,integer,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION apply_hns_root_import_recovery_v1(text,text,bigint,text,jsonb,integer) SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_recovery_fix_privileges$;
