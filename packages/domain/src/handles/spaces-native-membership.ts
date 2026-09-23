import { sha256Hex } from "../gates-v2/sha256.ts";
import {
  type HandleAllocationKindV1,
  type HandleFulfillmentKindV1,
  type HandleHashResultV1,
  type HandleLabelScopeV2,
  type HandleQualificationPolicyRefV1,
  handleLabelScopeV2Preimage,
  handleQualificationPolicyPreimage,
} from "./sales-v2.ts";

/**
 * Members-only Spaces qualification (spec 012 §5.3.13.12). The platform
 * creates and versions one global policy outside the seller policy command.
 * Its private record has exactly one `community_membership_v1` requirement
 * and one versioned `membership_source_v1` binding; its public reference keeps
 * the five-member `curated_policy_v1` shape so the HNS offering wire is
 * unchanged. Each hash is SHA-256 of the compact UTF-8 JSON array.
 */

const encoded = (preimage: readonly unknown[]): HandleHashResultV1 => {
  const json = JSON.stringify(preimage);
  return {
    bytes: new TextEncoder().encode(json).byteLength,
    preimage: json,
    sha256: sha256Hex(json),
  };
};

const requireIdentifier = (value: string, name: string): void => {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
};
const requireRevision = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}`);
};
const requireDigest = (value: string, name: string): void => {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`Invalid ${name}`);
};

/** The versioned local Spec 016 active-membership predicate. */
export function handleSpacesMembershipSourceHash(input: {
  source_revision: number;
}): HandleHashResultV1 {
  requireRevision(input.source_revision, "membership source revision");
  return encoded([
    "pirate-handle-spaces-membership-source-v1",
    "spec-016-active-membership-v1",
    input.source_revision,
  ]);
}

/**
 * The platform-global members-only policy: exactly one
 * `community_membership_v1` requirement and one versioned membership source.
 * It names no account or community; the offering binds its own community.
 */
export function handleSpacesMembershipPolicyHash(input: {
  policy_id: string;
  policy_revision: number;
  requirement_id: string;
  requirement_revision: number;
  source_revision: number;
  source_hash: string;
}): HandleHashResultV1 {
  requireIdentifier(input.policy_id, "membership policy id");
  requireRevision(input.policy_revision, "membership policy revision");
  requireIdentifier(input.requirement_id, "membership requirement id");
  requireRevision(input.requirement_revision, "membership requirement revision");
  requireDigest(input.source_hash, "membership source hash");
  if (
    handleSpacesMembershipSourceHash({ source_revision: input.source_revision }).sha256 !==
    input.source_hash
  ) {
    throw new TypeError("Stale membership source hash");
  }
  return encoded([
    "pirate-handle-spaces-membership-policy-v1",
    input.policy_id,
    input.policy_revision,
    ["community_membership_v1", input.requirement_id, input.requirement_revision],
    ["membership_source_v1", input.source_revision, input.source_hash],
  ]);
}

export type SpacesMembershipPolicyV1 = Readonly<{
  policy_id: string;
  policy_revision: number;
  requirement_id: string;
  requirement_revision: number;
  source_revision: number;
}>;

/**
 * Compiles the platform members-only policy into the public five-member
 * `curated_policy_v1` reference an offering pins. The historical
 * `provider_binding_hash` member carries the membership source hash; it binds
 * the local evaluator and authorizes no provider call. A policy built against
 * any other source revision than the current one is stale and refused.
 */
export function compileSpacesMembershipQualificationV1(
  policy: SpacesMembershipPolicyV1,
  currentSourceRevision: number,
): Extract<HandleQualificationPolicyRefV1, { kind: "curated_policy_v1" }> {
  requireRevision(currentSourceRevision, "current membership source revision");
  if (policy.source_revision !== currentSourceRevision) {
    throw new TypeError("Stale membership source revision");
  }
  const source = handleSpacesMembershipSourceHash({ source_revision: policy.source_revision });
  const compiled = handleSpacesMembershipPolicyHash({ ...policy, source_hash: source.sha256 });
  return {
    kind: "curated_policy_v1",
    policy_id: policy.policy_id,
    policy_revision: policy.policy_revision,
    policy_hash: compiled.sha256,
    provider_binding_hash: source.sha256,
  };
}

/**
 * Offering compiler guard for this release: a Spaces offering is free,
 * first-come, rule-scoped under `spaces_subspace_label_v1`, fulfilled by
 * `spaces_native_v1`, and pins exactly the current members-only policy. A
 * `none_v1` policy, any other curated reference, a stale source, and every
 * exact-label or direct-grant combination are refused.
 */
export function assertSpacesOfferingCombinationV1(input: {
  label_scope: HandleLabelScopeV2;
  allocation_kind: HandleAllocationKindV1;
  fulfillment_kind: HandleFulfillmentKindV1;
  qualification_policy: HandleQualificationPolicyRefV1;
  membership_policy: SpacesMembershipPolicyV1;
  current_membership_source_revision: number;
  pricing_kind: string;
  atomic_amount: string;
}): void {
  handleLabelScopeV2Preimage(input.label_scope, "spaces");
  if (
    input.label_scope.kind !== "label_rule_v2" ||
    input.allocation_kind !== "first_come_v1" ||
    input.fulfillment_kind !== "spaces_native_v1" ||
    input.pricing_kind !== "free_v1" ||
    input.atomic_amount !== "0"
  ) {
    throw new TypeError("Unsupported Spaces offering combination");
  }
  const expected = compileSpacesMembershipQualificationV1(
    input.membership_policy,
    input.current_membership_source_revision,
  );
  if (
    JSON.stringify(handleQualificationPolicyPreimage(input.qualification_policy)) !==
    JSON.stringify(handleQualificationPolicyPreimage(expected))
  ) {
    throw new TypeError("Spaces offerings require the current members-only policy");
  }
}
