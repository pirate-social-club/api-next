-- Adoption binds the operation to what was actually published.
--
-- Recovery could classify a name as adoptable and could move its phase, and
-- then the operation went on comparing observations against the plan digest it
-- was created with. Nothing could rebind it, because the plan digest, the
-- finality anchor and the finality deadline are all immutable once set — which
-- is correct within one authority generation and wrong across a decision that
-- says "the published resource is now what this operation is about". An adopted
-- operation would have spun until its finality deadline and then re-entered
-- recovery, having observed a chain that matched what the owner published and
-- not what we asked for.
--
-- A new generation is the existing mechanism for "this operation now concerns
-- different infrastructure". So the immutability rules become
-- within-a-generation rules: the anchor, the deadline and the plan digest may
-- only change when the generation increases, which is the one moment at which
-- the operation is deliberately being rebound.
--
-- Adoption is deliberately narrow. It binds to the digest recorded in the
-- finding — the covenant bytes the evidence attributed to a transaction — and
-- not to anything the caller supplies. It clears the anchor, the finality
-- deadline and the readiness evidence, so the operation must establish a fresh
-- current observation, a fresh safe-view commitment and fresh readiness before
-- it can be activated again. And it publishes nothing: the owner's resource is
-- adopted as it stands, so whatever unrelated records they added stay exactly
-- where they are.

CREATE OR REPLACE FUNCTION guard_hns_root_import_lifecycle_anchor_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rebinding BOOLEAN := NEW.generation > OLD.generation;
BEGIN
  IF NOT rebinding THEN
    IF NEW.first_current_observation_at IS DISTINCT FROM OLD.first_current_observation_at
      AND OLD.first_current_observation_at IS NOT NULL THEN
      RAISE EXCEPTION 'HNS lifecycle finality anchor is immutable';
    END IF;
    IF NEW.finality_deadline_at IS DISTINCT FROM OLD.finality_deadline_at
      AND OLD.finality_deadline_at IS NOT NULL THEN
      RAISE EXCEPTION 'HNS lifecycle finality deadline is immutable';
    END IF;
    IF NEW.plan_encoded_resource_sha256 IS DISTINCT FROM OLD.plan_encoded_resource_sha256
      AND OLD.plan_encoded_resource_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'HNS lifecycle plan digest is immutable';
    END IF;
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'HNS lifecycle generation never decreases';
  END IF;
  IF OLD.phase = 'failed' AND NEW.phase <> 'failed' THEN
    RAISE EXCEPTION 'HNS lifecycle terminal decisions allow no further transitions';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_hns_root_import_lifecycle_anchor_v1() FROM PUBLIC;

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
    RETURN QUERY SELECT committed.outcome::TEXT, committed.revision, rebound;
    RETURN;
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
DO $pin_adoption_privileges$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION apply_hns_root_import_recovery_v1(text,text,bigint,text,jsonb,integer) SET search_path TO %I, pg_temp',
    installed_schema);
  EXECUTE format(
    'ALTER FUNCTION guard_hns_root_import_lifecycle_anchor_v1() SET search_path TO %I, pg_temp',
    installed_schema);
END;
$pin_adoption_privileges$;
