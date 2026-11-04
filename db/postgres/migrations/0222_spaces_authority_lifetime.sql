-- Spec 012 §5.3.13.3–4: separate owner-command proof age from continuous chain readiness.
CREATE OR REPLACE FUNCTION spaces_sale_namespace_readiness_facts_v1(
  input_network TEXT,
  input_canonical_root TEXT,
  input_community_id TEXT,
  input_namespace_authority_reference TEXT,
  input_namespace_authority_generation BIGINT,
  input_operator_assignment_id TEXT,
  input_operator_assignment_generation BIGINT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE (
  namespace_authority_current BOOLEAN,
  owner_challenge_current BOOLEAN,
  anchor_covers_root_outpoint BOOLEAN,
  publication_verified BOOLEAN,
  delegation_observed BOOLEAN,
  operator_capability_observed BOOLEAN,
  commitment_history_verified BOOLEAN,
  driver_enabled BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH evidence AS (
    SELECT candidate.*
      FROM spaces_namespace_authority_evidence AS candidate
     WHERE candidate.namespace_authority_reference = input_namespace_authority_reference
       AND candidate.namespace_authority_generation = input_namespace_authority_generation
       AND candidate.network = input_network
       AND candidate.canonical_root = input_canonical_root
       AND candidate.namespace_authority_generation = (
         SELECT max(latest.namespace_authority_generation)
           FROM spaces_namespace_authority_evidence AS latest
          WHERE latest.namespace_authority_reference = candidate.namespace_authority_reference
       )
  ),
  latest_observation AS (
    SELECT observation.*
      FROM spaces_root_observations AS observation
     WHERE observation.network = input_network
       AND observation.canonical_root = input_canonical_root
     ORDER BY observation.observation_generation DESC
     LIMIT 1
  ),
  observation AS (
    SELECT latest_observation.*
      FROM latest_observation
     WHERE latest_observation.fresh_until > database_now
  ),
  assignment AS (
    SELECT revision.*
      FROM spaces_operator_assignment_current AS current_assignment
      JOIN spaces_operator_assignment_revisions AS revision
        ON revision.operator_assignment_id = current_assignment.operator_assignment_id
       AND revision.operator_assignment_generation = current_assignment.current_generation
     WHERE current_assignment.operator_assignment_id = input_operator_assignment_id
       AND current_assignment.current_generation = input_operator_assignment_generation
       AND revision.status = 'active'
       AND revision.network = input_network
       AND revision.canonical_root = input_canonical_root
  ),
  capability AS (
    SELECT observation.*
      FROM spaces_operator_capability_observations AS observation
     WHERE observation.operator_assignment_id = input_operator_assignment_id
       AND observation.operator_assignment_generation = input_operator_assignment_generation
     ORDER BY observation.observation_generation DESC
     LIMIT 1
  )
  SELECT
    COALESCE((
      SELECT evidence.community_id = input_community_id
             AND EXISTS (
               SELECT 1 FROM communities AS community
                WHERE community.community_id = input_community_id
                  AND community.status = 'active'
             )
             AND NOT EXISTS (
               SELECT 1 FROM observation
                WHERE observation.root_state = 'unresolved'
                   OR observation.anchor_state = 'stale'
             )
        FROM evidence
    ), FALSE),
    COALESCE((
      SELECT NOT EXISTS (
               SELECT 1 FROM observation
                WHERE observation.root_state = 'resolved'
                  AND (observation.root_key_hex <> evidence.root_key_hex
                    OR observation.root_outpoint <> evidence.root_outpoint)
             )
        FROM evidence
    ), FALSE),
    COALESCE((
      SELECT observation.root_state = 'resolved'
             AND observation.anchor_state = 'covers_root_outpoint'
        FROM observation
    ), FALSE),
    COALESCE((
      SELECT observation.publication_state = 'verified'
        FROM observation
    ), FALSE),
    COALESCE((
      SELECT observation.delegation_address = assignment.delegation_address
        FROM observation, assignment
    ), FALSE),
    COALESCE((
      SELECT capability.capability_state = 'observed'
             AND capability.fresh_until > database_now
        FROM capability, assignment
    ), FALSE),
    COALESCE((
      SELECT observation.commitment_history_state = 'verified'
        FROM observation
    ), FALSE),
    EXISTS (
      SELECT 1
        FROM spaces_issuance_driver_root_enablements AS enablement
        JOIN handle_issuance_driver_revisions AS driver
          ON driver.family = enablement.driver_family
         AND driver.driver_id = enablement.driver_id
         AND driver.driver_version = enablement.driver_version
       WHERE enablement.network = input_network
         AND enablement.canonical_root = input_canonical_root
         AND enablement.status = 'enabled'
         AND driver.fulfillment_kind = 'spaces_native_v1'
         AND driver.status <> 'retired'
    )
$$;

-- A short-lived owner signature authorizes a new activation command. Its
-- expiry does not end a completed activation while current independent chain
-- observations continue to match the signed key and outpoint.
CREATE FUNCTION guard_spaces_activation_owner_proof_fresh_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.family = 'spaces' AND NEW.status IN ('pending', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM spaces_namespace_authority_evidence AS evidence
       WHERE evidence.namespace_authority_reference = NEW.spaces_namespace_authority_reference
         AND evidence.namespace_authority_generation = NEW.spaces_namespace_authority_generation
         AND evidence.network = NEW.spaces_network
         AND evidence.canonical_root = NEW.canonical_root
         AND evidence.community_id = NEW.community_id
         AND evidence.controlling_account_id = NEW.actor_account_id
         AND evidence.fresh_until > clock_timestamp()
    ) THEN
    RAISE EXCEPTION 'Spaces activation command requires a fresh owner proof';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_activation_owner_proof_fresh_guard
BEFORE INSERT ON community_handle_sale_namespace_activation_revisions
FOR EACH ROW EXECUTE FUNCTION guard_spaces_activation_owner_proof_fresh_v1();
