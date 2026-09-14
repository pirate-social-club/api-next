import { canonicalJson } from "../canonical-json.ts";
import { CURATED_HUMAN_MEMBERSHIP_POLICY } from "../gates-v2/human-membership-evaluator.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";
import {
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "./gate-policy-compiler.ts";

export function communityJoinActionPayloadPreimage(communityId: string): string {
  return canonicalJson({ action_kind: "community_join", community_id: communityId, version: 1 });
}

export function communityJoinActionPayloadHash(communityId: string): string {
  return sha256Hex(communityJoinActionPayloadPreimage(communityId));
}

export function communityJoinIntentBindingPreimage(
  input: Readonly<{
    readonly actorId: string;
    readonly communityId: string;
  }>,
): string {
  return canonicalJson({
    actor_id: input.actorId,
    community_id: input.communityId,
    policy_hash: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
    policy_key: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
    policy_version_id: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
    provider_binding: {
      evaluator_id: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
      issuer: VERY_WEB_ISSUER,
      issuer_rp_scope: VERY_WEB_RP_SCOPE,
      method: VERY_WEB_METHOD,
      protocol_version: VERY_WEB_PROTOCOL_VERSION,
      provider_configuration_kind: "dynamic",
      provider_configuration_ref: VERY_WEB_CONFIGURATION_REFERENCE,
      provider_configuration_version: VERY_WEB_CONFIGURATION_VERSION,
      provider_id: VERY_WEB_PROVIDER_ID,
      request_mode: "dynamic",
      scope_kind: "issuer_rp_scope",
    },
    verification_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    version: 1,
  });
}

export function communityJoinIntentBindingHash(
  input: Readonly<{
    readonly actorId: string;
    readonly communityId: string;
  }>,
): string {
  return sha256Hex(communityJoinIntentBindingPreimage(input));
}

/**
 * Stable identity for the joiner's nationality child ceremony. A join action
 * intent expires with its Palm ceremony, but the nationality requirement must
 * survive eligibility refetches, so its identity derives from the exact
 * actor, community, and normalized requirement it serves. A changed allowlist
 * derives a new id and cannot reuse the previous state.
 */
export function communityJoinNationalityIntentId(
  input: Readonly<{
    readonly actorId: string;
    readonly communityId: string;
    readonly requirementHash: string;
  }>,
): string {
  if (
    !validIdentityPart(input.actorId) ||
    !validIdentityPart(input.communityId) ||
    !/^[0-9a-f]{64}$/u.test(input.requirementHash)
  ) {
    throw new TypeError("Invalid community join nationality intent identity");
  }
  return `community-join-nationality_${sha256Hex(
    canonicalJson({
      actor_id: input.actorId,
      community_id: input.communityId,
      requirement_hash: input.requirementHash,
      version: "community-join-nationality-intent-v1",
    }),
  )}`;
}

function validIdentityPart(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}
