import {
  type CommunityCreationRequirementsV1,
  type CreationRequirementProgressV1,
  decodeCommunityCreationRequirementsV1,
  decodeCreationRequirementProgressV1,
} from "@pirate/contracts";
import {
  type CreationRequirementProgress,
  creationRequirementProgressInvariant,
} from "@pirate/domain";

export type CreationRequirementStateMap = Readonly<{
  readonly human_identity: CreationRequirementProgress;
  readonly namespace_ownership: CreationRequirementProgress;
}>;

function assertValidInternalProgress(state: CreationRequirementProgress): void {
  if (creationRequirementProgressInvariant(state) !== null) {
    throw new Error("Invalid internal community creation requirement progress");
  }
}

/**
 * Projects internal requirement authority into its closed public shape.
 *
 * Constructing the object field-by-field is deliberate: provider binding
 * fingerprints and future internal evidence fields must never cross the wire.
 */
export function publicCreationRequirementProgress(
  state: CreationRequirementProgress,
): CreationRequirementProgressV1 {
  assertValidInternalProgress(state);
  return decodeCreationRequirementProgressV1({
    requirement: state.requirement,
    status: state.status,
    requirement_hash: state.requirement_hash,
    provider_id: state.provider_id,
    generation: state.generation,
    ceremony_intent_id: state.ceremony_intent_id,
    satisfied_at: state.satisfied_at,
  });
}

export function publicCommunityCreationRequirements(
  states: CreationRequirementStateMap,
): CommunityCreationRequirementsV1 {
  return decodeCommunityCreationRequirementsV1({
    human_identity: publicCreationRequirementProgress(states.human_identity),
    namespace_ownership: publicCreationRequirementProgress(states.namespace_ownership),
  });
}
