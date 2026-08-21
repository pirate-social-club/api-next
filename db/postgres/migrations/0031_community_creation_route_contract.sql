-- Mark the community-creation runtime clean break and make the two requirement
-- rows structural for route-v1 intents. Legacy slug intents remain retained as
-- audit evidence but are not readable or replayable through the route-v1 API.

ALTER TABLE community_creation_intents
  ADD COLUMN creation_contract_version TEXT NOT NULL DEFAULT 'legacy_slug_v1'
    CHECK (creation_contract_version IN ('legacy_slug_v1', 'route_v1')),
  ADD CONSTRAINT community_creation_intents_route_v1_draft_shape CHECK (
    creation_contract_version <> 'route_v1'
    OR (
      NOT (draft ? 'slug')
      AND jsonb_typeof(draft -> 'route_request') = 'object'
      AND (draft -> 'route_request') ? 'family'
      AND (draft -> 'route_request') ? 'root_label'
      AND ((draft -> 'route_request') - 'family' - 'root_label') = '{}'::jsonb
      AND draft -> 'route_request' ->> 'family' IN ('hns', 'spaces')
      AND is_community_route_root_label(
        draft -> 'route_request' ->> 'family',
        draft -> 'route_request' ->> 'root_label'
      ) IS TRUE
    )
  ),
  ADD CONSTRAINT community_creation_intents_route_v1_committed_href CHECK (
    creation_contract_version <> 'route_v1'
    OR status <> 'committed'
    OR committed_resource_href LIKE '/c/%'
  );

COMMENT ON COLUMN community_creation_intents.creation_contract_version IS
  'Runtime contract fence. route_v1 is the only version exposed after the canonical-route cutover.';

CREATE OR REPLACE FUNCTION guard_community_creation_contract_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.creation_contract_version <> OLD.creation_contract_version THEN
    RAISE EXCEPTION 'community creation contract version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_contract_version_guard
BEFORE UPDATE OF creation_contract_version ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION guard_community_creation_contract_version();

CREATE OR REPLACE FUNCTION validate_route_v1_creation_requirement_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_intent_id TEXT;
  contract_version TEXT;
  human_count BIGINT;
  namespace_count BIGINT;
BEGIN
  checked_intent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.intent_id ELSE NEW.intent_id END;

  SELECT creation_contract_version INTO contract_version
    FROM community_creation_intents
   WHERE intent_id = checked_intent_id;

  IF NOT FOUND OR contract_version <> 'route_v1' THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE requirement_kind = 'human_identity'),
    COUNT(*) FILTER (WHERE requirement_kind = 'namespace_ownership')
    INTO human_count, namespace_count
    FROM community_creation_requirement_states
   WHERE intent_id = checked_intent_id;

  IF human_count <> 1 OR namespace_count <> 1 THEN
    RAISE EXCEPTION 'route-v1 community creation requires exactly two requirement rows';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER route_v1_creation_intent_requirement_cardinality
AFTER INSERT OR UPDATE ON community_creation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_route_v1_creation_requirement_cardinality();

CREATE CONSTRAINT TRIGGER route_v1_creation_requirement_cardinality
AFTER INSERT OR UPDATE OR DELETE ON community_creation_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_route_v1_creation_requirement_cardinality();


CREATE OR REPLACE FUNCTION validate_route_v1_committed_community()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
  expected_family TEXT;
  expected_root TEXT;
  guard_at TIMESTAMPTZ;
  human_evidence_valid BOOLEAN;
BEGIN
  IF NEW.creation_contract_version <> 'route_v1'
    OR NEW.status <> 'committed' THEN
    RETURN NULL;
  END IF;

  expected_family := NEW.draft -> 'route_request' ->> 'family';
  expected_root := NEW.draft -> 'route_request' ->> 'root_label';

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.committed_community_id;
  IF NOT FOUND
    OR community_record.status <> 'active'
    OR community_record.canonical_route_binding_id IS NULL THEN
    RAISE EXCEPTION 'route-v1 committed intent requires an active canonical community binding';
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = community_record.canonical_route_binding_id
     AND community_id = community_record.community_id;
  IF NOT FOUND
    OR binding_record.family IS DISTINCT FROM expected_family
    OR binding_record.root_label IS DISTINCT FROM expected_root
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR binding_record.verified_evidence_ref IS NULL
    OR NEW.committed_resource_href IS DISTINCT FROM binding_record.href THEN
    RAISE EXCEPTION 'route-v1 committed intent does not match its verified canonical route';
  END IF;

  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  guard_at := clock_timestamp();
  IF evidence_record.evidence_ref IS NULL
    OR snapshot_record.evidence_ref IS NULL
    OR evidence_record.family IS DISTINCT FROM binding_record.family
    OR evidence_record.root_label IS DISTINCT FROM binding_record.root_label
    OR evidence_record.root_label_display IS DISTINCT FROM binding_record.root_label_display
    OR evidence_record.path_segment IS DISTINCT FROM binding_record.path_segment
    OR snapshot_record.family IS DISTINCT FROM binding_record.family
    OR snapshot_record.root_label IS DISTINCT FROM binding_record.root_label
    OR snapshot_record.root_label_display IS DISTINCT FROM binding_record.root_label_display
    OR snapshot_record.path_segment IS DISTINCT FROM binding_record.path_segment
    OR snapshot_record.href IS DISTINCT FROM binding_record.href
    OR snapshot_record.expires_at <= guard_at
    OR (evidence_record.expires_at IS NOT NULL AND evidence_record.expires_at <= guard_at)
  THEN
    RAISE EXCEPTION 'route-v1 committed intent requires live canonical route evidence';
  END IF;

  SELECT (
    COUNT(DISTINCT claim.claim_id) = 1
    AND COUNT(DISTINCT receipt.evidence_receipt_id) = 1
    AND COUNT(DISTINCT assertion.assertion_id) = 2
    AND COUNT(DISTINCT assertion.assertion_id) FILTER (
      WHERE assertion.claim_id = 'human.personhood'
        AND assertion.assertion_value = '{"personhood": true}'::jsonb
        AND assertion.assurance = 'provider_attested'
    ) = 1
    AND COUNT(DISTINCT assertion.assertion_id) FILTER (
      WHERE assertion.claim_id = 'credential.subject_unique'
        AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
        AND assertion.assurance = 'provider_attested'
    ) = 1
    AND BOOL_AND(
      claim.community_id = NEW.committed_community_id
      AND claim.verification_requirement_hash = NEW.verification_requirement_hash
      AND receipt.proof_session_id = claim.proof_session_id
      AND receipt.evidence_receipt_id = claim.evidence_receipt_id
      AND receipt.user_id = NEW.actor_id
      AND receipt.subject_key_id = claim.subject_key_id
      AND receipt.evidence_kind = 'very.oauth.id-token-userinfo.v1'
      AND (receipt.expires_at IS NULL OR receipt.expires_at > guard_at)
      AND assertion.user_id = NEW.actor_id
      AND assertion.subject_key_id = claim.subject_key_id
      AND assertion.evidence_receipt_id = claim.evidence_receipt_id
      AND (assertion.expires_at IS NULL OR assertion.expires_at > guard_at)
      AND assertion_binding.user_id = NEW.actor_id
      AND assertion_binding.binding_mode = 'same_subject'
      AND assertion_binding.subject_key_id = claim.subject_key_id
      AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
      AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
      AND active_binding.user_id = NEW.actor_id
      AND active_binding.subject_key_id = claim.subject_key_id
      AND active_binding.binding_event_id = receipt.subject_binding_event_id
      AND active_binding.binding_epoch = receipt.subject_binding_epoch
    )
  ) INTO human_evidence_valid
    FROM community_creation_subject_claims AS claim
    JOIN evidence_receipts AS receipt
      ON receipt.evidence_receipt_id = claim.evidence_receipt_id
    JOIN assertions AS assertion
      ON assertion.evidence_receipt_id = claim.evidence_receipt_id
    JOIN assertion_bindings AS assertion_binding
      ON assertion_binding.binding_group_id = assertion.binding_group_id
    JOIN active_subject_key_bindings AS active_binding
      ON active_binding.subject_key_id = claim.subject_key_id
   WHERE claim.intent_id = NEW.intent_id
     AND claim.actor_id = NEW.actor_id;
  IF human_evidence_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'route-v1 committed intent requires live human creation evidence';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_creation_route_v1_commit_guard
AFTER INSERT OR UPDATE ON community_creation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_route_v1_committed_community();

-- The namespace terminal is one authority chain.  Every deferred check below
-- compares the immutable ceremony attempt, session, completion attempt,
-- snapshot, result, and route evidence against one wall-clock observation and
-- the same evidence fence.

CREATE OR REPLACE FUNCTION validate_namespace_ownership_terminal_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
  route_record community_route_ownership_evidence%ROWTYPE;
  coherence_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_sessions' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE namespace_session_id = session_record.namespace_session_id;
  ELSE
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.ceremony_intent_id;
    IF result_record.namespace_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = result_record.namespace_session_id;
  END IF;

  IF session_record.status = 'pending' THEN
    IF result_record.ceremony_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'pending namespace ownership session cannot have a ceremony result';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.namespace_session_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
    OR (
      session_record.status = 'completed'
      AND result_record.outcome_status IS DISTINCT FROM 'satisfied'
    )
    OR (
      session_record.status IN ('failed', 'expired')
      AND result_record.outcome_status IS DISTINCT FROM session_record.status
    )
  THEN
    RAISE EXCEPTION 'terminal namespace ownership session/result correlation is incomplete';
  END IF;

  IF session_record.status = 'completed' THEN
    SELECT * INTO attempt_record
      FROM community_creation_ceremony_attempts
     WHERE ceremony_intent_id = result_record.ceremony_intent_id;
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = result_record.completion_attempt_id;
    SELECT * INTO snapshot_record
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = result_record.evidence_ref
       AND namespace_session_id = result_record.namespace_session_id
       AND completion_attempt_id = result_record.completion_attempt_id;
    SELECT * INTO route_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = result_record.evidence_ref;

    IF attempt_record.ceremony_intent_id IS NULL
      OR completion_record.completion_attempt_id IS NULL
      OR snapshot_record.evidence_ref IS NULL
      OR route_record.evidence_ref IS NULL
      OR result_record.completion_attempt_id IS NULL
      OR result_record.evidence_ref IS NULL
      OR result_record.evidence_digest IS NULL
      OR result_record.provider_identity_digest IS NULL
      OR result_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
      OR result_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR result_record.intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR result_record.generation IS DISTINCT FROM session_record.generation
      OR result_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR result_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR result_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR result_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR attempt_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR attempt_record.intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR attempt_record.requirement_kind IS DISTINCT FROM session_record.requirement_kind
      OR attempt_record.generation IS DISTINCT FROM session_record.generation
      OR attempt_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR attempt_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR attempt_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR attempt_record.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
      OR attempt_record.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
      OR attempt_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR attempt_record.route_family IS DISTINCT FROM session_record.route_family
      OR attempt_record.route_root_label IS DISTINCT FROM session_record.route_root_label
      OR attempt_record.route_root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR attempt_record.route_path_segment IS DISTINCT FROM session_record.route_path_segment
      OR completion_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
      OR completion_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR completion_record.state IS DISTINCT FROM 'consumed'
      OR completion_record.consumption_kind IS DISTINCT FROM 'verified'
      OR completion_record.evidence_ref IS DISTINCT FROM result_record.evidence_ref
      OR completion_record.fence_token IS DISTINCT FROM snapshot_record.fence_token
      OR snapshot_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR snapshot_record.creation_intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR snapshot_record.ceremony_intent_id IS DISTINCT FROM session_record.ceremony_intent_id
      OR snapshot_record.generation IS DISTINCT FROM session_record.generation
      OR snapshot_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR snapshot_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR snapshot_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR snapshot_record.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
      OR snapshot_record.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
      OR snapshot_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR snapshot_record.protocol_version IS DISTINCT FROM session_record.protocol_version
      OR snapshot_record.environment IS DISTINCT FROM session_record.environment
      OR snapshot_record.family IS DISTINCT FROM session_record.route_family
      OR snapshot_record.root_label IS DISTINCT FROM session_record.route_root_label
      OR snapshot_record.root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR snapshot_record.path_segment IS DISTINCT FROM session_record.route_path_segment
      OR snapshot_record.href IS DISTINCT FROM session_record.route_href
      OR snapshot_record.upstream_session_ref IS DISTINCT FROM session_record.upstream_session_ref
      OR snapshot_record.fence_token IS DISTINCT FROM completion_record.fence_token
      OR snapshot_record.evidence_digest IS DISTINCT FROM result_record.evidence_digest
      OR snapshot_record.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
      OR snapshot_record.observed_at > coherence_at
      OR snapshot_record.expires_at <= coherence_at
      OR route_record.creation_ceremony_intent_id IS DISTINCT FROM result_record.ceremony_intent_id
      OR route_record.verified_by_actor_id IS DISTINCT FROM session_record.actor_id
      OR route_record.family IS DISTINCT FROM session_record.route_family
      OR route_record.root_label IS DISTINCT FROM session_record.route_root_label
      OR route_record.root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR route_record.path_segment IS DISTINCT FROM session_record.route_path_segment
      OR route_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR route_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR route_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR route_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR route_record.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
      OR route_record.evidence_digest IS DISTINCT FROM result_record.evidence_digest
      OR route_record.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
      OR route_record.binding_generation IS DISTINCT FROM session_record.generation
      OR route_record.verified_at IS DISTINCT FROM result_record.satisfied_at
      OR (
        route_record.expires_at IS NOT NULL
        AND route_record.expires_at IS DISTINCT FROM snapshot_record.expires_at
      )
    THEN
      RAISE EXCEPTION 'namespace ownership terminal evidence chain is incoherent';
    END IF;
  ELSE
    IF result_record.evidence_ref IS NOT NULL
      OR result_record.evidence_digest IS NOT NULL
      OR result_record.provider_identity_digest IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM namespace_ownership_evidence_snapshots
         WHERE namespace_session_id = session_record.namespace_session_id
      )
      OR EXISTS (
        SELECT 1 FROM community_route_ownership_evidence
         WHERE creation_ceremony_intent_id = result_record.ceremony_intent_id
      )
    THEN
      RAISE EXCEPTION 'failed or expired namespace ownership has no evidence snapshot';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = attempt_record.intent_id
     AND requirement_kind = attempt_record.requirement_kind
   FOR SHARE;
  IF result_record.completion_attempt_id IS NOT NULL THEN
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = result_record.completion_attempt_id;
  END IF;

  IF attempt_record.ceremony_intent_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR attempt_record.requirement_kind <> 'namespace_ownership'
    OR result_record.outcome_status <> 'satisfied'
    OR state_record.status <> 'satisfied'
    OR state_record.generation IS DISTINCT FROM attempt_record.generation
    OR state_record.current_ceremony_intent_id IS DISTINCT FROM NEW.creation_ceremony_intent_id
    OR NEW.verified_by_actor_id IS DISTINCT FROM attempt_record.actor_id
    OR NEW.family IS DISTINCT FROM attempt_record.route_family
    OR NEW.root_label IS DISTINCT FROM attempt_record.route_root_label
    OR NEW.root_label_display IS DISTINCT FROM attempt_record.route_root_label_display
    OR NEW.path_segment IS DISTINCT FROM attempt_record.route_path_segment
    OR NEW.requirement_hash IS DISTINCT FROM attempt_record.requirement_hash
    OR NEW.provider_id IS DISTINCT FROM attempt_record.provider_id
    OR NEW.provider_binding_hash IS DISTINCT FROM attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version IS DISTINCT FROM attempt_record.provider_configuration_version
    OR NEW.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
    OR NEW.evidence_ref IS DISTINCT FROM result_record.evidence_ref
    OR NEW.evidence_digest IS DISTINCT FROM result_record.evidence_digest
    OR NEW.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
    OR NEW.binding_generation IS DISTINCT FROM attempt_record.generation
    OR NEW.verified_at IS DISTINCT FROM result_record.satisfied_at
    OR completion_record.completion_attempt_id IS NULL
    OR completion_record.namespace_session_id IS DISTINCT FROM result_record.namespace_session_id
    OR completion_record.actor_id IS DISTINCT FROM result_record.actor_id
    OR completion_record.state IS DISTINCT FROM 'consumed'
    OR completion_record.consumption_kind IS DISTINCT FROM 'verified'
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
  END IF;

  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
     AND namespace_session_id = result_record.namespace_session_id
     AND completion_attempt_id = result_record.completion_attempt_id;
  IF snapshot_record.evidence_ref IS NULL
    OR snapshot_record.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR snapshot_record.provider_identity_digest IS DISTINCT FROM NEW.provider_identity_digest
    OR snapshot_record.actor_id IS DISTINCT FROM result_record.actor_id
    OR snapshot_record.creation_intent_id IS DISTINCT FROM result_record.intent_id
    OR snapshot_record.ceremony_intent_id IS DISTINCT FROM result_record.ceremony_intent_id
    OR snapshot_record.generation IS DISTINCT FROM NEW.binding_generation
    OR snapshot_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR snapshot_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR snapshot_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR snapshot_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
    OR snapshot_record.family IS DISTINCT FROM NEW.family
    OR snapshot_record.root_label IS DISTINCT FROM NEW.root_label
    OR snapshot_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR snapshot_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR (
      NEW.expires_at IS NOT NULL
      AND snapshot_record.expires_at IS DISTINCT FROM NEW.expires_at
    )
  THEN
    RAISE EXCEPTION 'route ownership evidence requires its matching namespace snapshot';
  END IF;

  RETURN NEW;
END;
$$;
