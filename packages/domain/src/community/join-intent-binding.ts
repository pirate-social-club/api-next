import { CURATED_HUMAN_MEMBERSHIP_POLICY } from "../gates-v2/human-membership-evaluator.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";
import {
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_METHOD,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
} from "./gate-policy-compiler.ts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

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
      issuer: VERY_OAUTH_ISSUER,
      issuer_rp_scope: VERY_OAUTH_RP_SCOPE,
      method: VERY_OAUTH_METHOD,
      protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
      provider_configuration_kind: "dynamic",
      provider_configuration_ref: VERY_OAUTH_CONFIGURATION_REFERENCE,
      provider_configuration_version: VERY_OAUTH_CONFIGURATION_VERSION,
      provider_id: VERY_OAUTH_PROVIDER_ID,
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
