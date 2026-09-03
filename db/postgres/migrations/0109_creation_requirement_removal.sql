-- Creator-requirement removal amendment (spec 012, 2026-09-03): a new
-- optional_route_v2 creation intent carries no creator requirement and its
-- creator verification authority columns are absent. Intents that already
-- hold requirement rows keep them and remain governed by the pre-amendment
-- checks; the join-side member-policy human verification is unchanged.

ALTER TABLE community_creation_intents
  DROP CONSTRAINT community_creation_intents_verification_requirement_hash_check,
  ALTER COLUMN verification_requirement_hash DROP NOT NULL,
  ALTER COLUMN verification_provider_id DROP NOT NULL,
  ALTER COLUMN provider_configuration_kind DROP NOT NULL,
  ALTER COLUMN provider_configuration_ref DROP NOT NULL,
  ALTER COLUMN provider_configuration_version DROP NOT NULL;

ALTER TABLE community_creation_intents
  DROP CONSTRAINT community_creation_intents_identifiers_not_blank,
  ADD CONSTRAINT community_creation_intents_identifiers_not_blank CHECK (
    btrim(intent_id) <> ''
    AND intent_id = btrim(intent_id)
    AND btrim(actor_id) <> ''
    AND actor_id = btrim(actor_id)
    AND btrim(create_idempotency_key) <> ''
    AND create_idempotency_key = btrim(create_idempotency_key)
    AND (
      verification_provider_id IS NULL
      OR (
        btrim(verification_provider_id) <> ''
        AND verification_provider_id = btrim(verification_provider_id)
      )
    )
    AND (
      provider_configuration_ref IS NULL
      OR (
        btrim(provider_configuration_ref) <> ''
        AND provider_configuration_ref = btrim(provider_configuration_ref)
      )
    )
    AND (
      provider_configuration_version IS NULL
      OR (
        btrim(provider_configuration_version) <> ''
        AND provider_configuration_version = btrim(provider_configuration_version)
      )
    )
  );

COMMENT ON COLUMN community_creation_intents.verification_requirement_hash IS
  'Creator verification authority. NULL for optional_route_v2 intents created after the 2026-09-03 creator-requirement removal amendment; route-v1 and grandfathered intents retain their immutable value.';

ALTER TABLE community_creation_intents
  ADD CONSTRAINT community_creation_intents_creator_authority_shape CHECK (
    (
      verification_requirement_hash IS NULL
      AND verification_provider_id IS NULL
      AND provider_configuration_kind IS NULL
      AND provider_configuration_ref IS NULL
      AND provider_configuration_version IS NULL
    )
    OR (
      verification_requirement_hash ~ '^[0-9a-f]{64}$'
      AND btrim(verification_provider_id) <> ''
      AND provider_configuration_kind IN ('managed', 'dynamic')
      AND btrim(provider_configuration_ref) <> ''
      AND btrim(provider_configuration_version) <> ''
    )
  );

CREATE OR REPLACE FUNCTION validate_creation_requirement_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_intent_id TEXT;
  contract_version TEXT;
  requirement_hash TEXT;
  human_count BIGINT;
  namespace_count BIGINT;
BEGIN
  checked_intent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.intent_id ELSE NEW.intent_id END;

  SELECT creation_contract_version, verification_requirement_hash
    INTO contract_version, requirement_hash
    FROM community_creation_intents
   WHERE intent_id = checked_intent_id;

  IF NOT FOUND OR contract_version = 'legacy_slug_v1' THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE requirement_kind = 'human_identity'),
    COUNT(*) FILTER (WHERE requirement_kind = 'namespace_ownership')
    INTO human_count, namespace_count
    FROM community_creation_requirement_states
   WHERE intent_id = checked_intent_id;

  IF contract_version = 'route_v1'
    AND (human_count <> 1 OR namespace_count <> 1) THEN
    RAISE EXCEPTION 'route-v1 community creation requires one human and one namespace requirement row';
  END IF;

  IF contract_version = 'optional_route_v2' THEN
    -- The cardinality is keyed on the creator authority columns, not row
    -- presence: a requirement-free intent can never gain a requirement row
    -- and an authority-bearing intent can never lose one.
    IF requirement_hash IS NULL AND human_count <> 0 THEN
      RAISE EXCEPTION 'requirement-free optional-route-v2 community creation must carry no human requirement row';
    END IF;
    IF requirement_hash IS NOT NULL AND human_count <> 1 THEN
      RAISE EXCEPTION 'authority-bearing optional-route-v2 community creation requires exactly one human requirement row';
    END IF;
    IF namespace_count <> 0 THEN
      RAISE EXCEPTION 'optional-route-v2 community creation allows no namespace requirement row';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER route_v1_creation_intent_requirement_cardinality ON community_creation_intents;
DROP TRIGGER route_v1_creation_requirement_cardinality ON community_creation_requirement_states;
DROP FUNCTION validate_route_v1_creation_requirement_cardinality();

CREATE CONSTRAINT TRIGGER creation_intent_requirement_cardinality
AFTER INSERT OR UPDATE ON community_creation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_creation_requirement_cardinality();

CREATE CONSTRAINT TRIGGER creation_requirement_cardinality
AFTER INSERT OR UPDATE OR DELETE ON community_creation_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_creation_requirement_cardinality();

CREATE OR REPLACE FUNCTION validate_optional_route_v2_committed_community()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  human_count BIGINT;
  membership_count BIGINT;
  authority_count BIGINT;
  claim_count BIGINT;
BEGIN
  IF NEW.creation_contract_version <> 'optional_route_v2'
    OR NEW.status <> 'committed' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.committed_community_id;
  IF community_record.community_id IS NULL
    OR community_record.status <> 'active'
    OR community_record.route_authority_version <> 'optional_route_v2'
    OR community_record.created_by_user_id <> NEW.actor_id
    OR community_record.canonical_route_binding_id IS NOT NULL
    OR NEW.committed_resource_href <> '/c/' || community_record.community_id THEN
    RAISE EXCEPTION 'optional-route-v2 commit requires an active unrouted generated-id community';
  END IF;

  SELECT COUNT(*) INTO human_count
    FROM community_creation_requirement_states
   WHERE intent_id = NEW.intent_id
     AND actor_id = NEW.actor_id
     AND requirement_kind = 'human_identity'
     AND status = 'satisfied';
  SELECT COUNT(*) INTO membership_count
    FROM community_memberships
   WHERE community_id = community_record.community_id
     AND user_id = NEW.actor_id
     AND status = 'member';
  SELECT COUNT(*) INTO authority_count
    FROM community_route_authority_grants
   WHERE community_id = community_record.community_id
     AND principal_user_id = NEW.actor_id
     AND authority = 'manage_routes'
     AND source_kind = 'creator_owner'
     AND status = 'active';

  IF human_count = 0 THEN
    -- Requirement-free intent created after the 2026-09-03 amendment: no
    -- creator ceremony exists, so no satisfied requirement or subject claim
    -- can or must exist, and the creator authority columns are absent.
    IF NEW.verification_requirement_hash IS NOT NULL THEN
      RAISE EXCEPTION 'requirement-free optional-route-v2 intent must not carry creator verification authority';
    END IF;
    IF membership_count <> 1 OR authority_count <> 1 THEN
      RAISE EXCEPTION 'optional-route-v2 commit lacks membership or route authority state';
    END IF;
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO claim_count
    FROM community_creation_subject_claims AS claim
    JOIN evidence_receipts AS receipt
      ON receipt.evidence_receipt_id = claim.evidence_receipt_id
     AND receipt.proof_session_id = claim.proof_session_id
     AND receipt.user_id = NEW.actor_id
    JOIN active_subject_key_bindings AS active_binding
      ON active_binding.subject_key_id = claim.subject_key_id
     AND active_binding.user_id = NEW.actor_id
     AND active_binding.binding_event_id = receipt.subject_binding_event_id
     AND active_binding.binding_epoch = receipt.subject_binding_epoch
   WHERE claim.intent_id = NEW.intent_id
     AND claim.community_id = community_record.community_id
     AND claim.actor_id = NEW.actor_id
     AND claim.verification_requirement_hash = NEW.verification_requirement_hash
     AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp());

  IF human_count <> 1
    OR membership_count <> 1
    OR authority_count <> 1
    OR claim_count <> 1 THEN
    RAISE EXCEPTION 'optional-route-v2 commit lacks human, membership, quota, or route authority state';
  END IF;

  RETURN NULL;
END;
$$;
