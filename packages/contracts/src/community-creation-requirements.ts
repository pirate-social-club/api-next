import { Schema } from "effect";

export const CreationVerificationRequirementV1 = Schema.Literals([
  "human_identity",
  "namespace_ownership",
]);
export type CreationVerificationRequirementV1 = Schema.Schema.Type<
  typeof CreationVerificationRequirementV1
>;

export const CreationRequirementStatusV1 = Schema.Literals([
  "unmet",
  "pending",
  "satisfied",
  "failed",
  "expired",
]);
export type CreationRequirementStatusV1 = Schema.Schema.Type<typeof CreationRequirementStatusV1>;

const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected lowercase SHA-256 hexadecimal",
  ),
);

const CanonicalNonEmptyString = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && value.trim() === value
      ? undefined
      : "Expected a non-empty string without edge whitespace",
  ),
);

const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

const NonNegativeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a non-negative safe integer",
  ),
);

export const CreationRequirementProgressV1 = Schema.Struct({
  requirement: CreationVerificationRequirementV1,
  status: CreationRequirementStatusV1,
  requirement_hash: Sha256Hex,
  provider_id: CanonicalNonEmptyString,
  generation: NonNegativeInteger,
  ceremony_intent_id: Schema.NullOr(CanonicalNonEmptyString),
  satisfied_at: Schema.NullOr(CanonicalIsoInstant),
}).check(
  Schema.makeFilter((progress) => {
    if (progress.status === "unmet") {
      return progress.ceremony_intent_id === null && progress.satisfied_at === null
        ? undefined
        : "Unmet requirements cannot expose ceremony or satisfaction state";
    }
    if (progress.generation === 0 || progress.ceremony_intent_id === null) {
      return "Started requirements require a positive generation and ceremony id";
    }
    if (progress.status === "satisfied") {
      return progress.satisfied_at === null
        ? "Satisfied requirements require a canonical satisfaction instant"
        : undefined;
    }
    return progress.satisfied_at === null
      ? undefined
      : "Non-satisfied requirements cannot expose a satisfaction instant";
  }),
);
export type CreationRequirementProgressV1 = Schema.Schema.Type<
  typeof CreationRequirementProgressV1
>;

export const CommunityCreationRequirementsV1 = Schema.Struct({
  human_identity: CreationRequirementProgressV1,
  namespace_ownership: CreationRequirementProgressV1,
}).check(
  Schema.makeFilter((requirements) =>
    requirements.human_identity.requirement === "human_identity" &&
    requirements.namespace_ownership.requirement === "namespace_ownership"
      ? undefined
      : "Creation requirement entries must match their keyed requirement",
  ),
);
export type CommunityCreationRequirementsV1 = Schema.Schema.Type<
  typeof CommunityCreationRequirementsV1
>;

/** Effect Struct strips excess keys by default; wire decoders must use this strict boundary. */
export const CommunityCreationRequirementContractParseOptions = {
  onExcessProperty: "error",
} as const;

export const decodeCreationRequirementProgressV1 = Schema.decodeUnknownSync(
  CreationRequirementProgressV1,
  CommunityCreationRequirementContractParseOptions,
);

export const decodeCommunityCreationRequirementsV1 = Schema.decodeUnknownSync(
  CommunityCreationRequirementsV1,
  CommunityCreationRequirementContractParseOptions,
);
