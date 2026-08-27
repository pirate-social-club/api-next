import { sha256Hex } from "../gates-v2/sha256.ts";

export const PLATFORM_PIRATE_LABEL_POLICY_ID = "pirate_ascii_ldh_3_32_v1" as const;
export const PLATFORM_PIRATE_RESERVED_LABELS_ID = "pirate_platform_reserved_labels_v1" as const;
export const PLATFORM_PIRATE_CONFUSABILITY_POLICY_ID = "pirate_ascii_skeleton_v1" as const;

export const PLATFORM_PIRATE_RESERVED_LABELS_V1 = [
  "abuse",
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "blog",
  "cdn",
  "dev",
  "docs",
  "gateway",
  "help",
  "hns",
  "login",
  "logout",
  "mail",
  "mod",
  "moderator",
  "new",
  "official",
  "pirate",
  "root",
  "security",
  "settings",
  "staff",
  "staging",
  "status",
  "support",
  "system",
  "www",
] as const;

export const PLATFORM_PIRATE_RESERVED_PREFIXES_V1 = ["new-"] as const;
export const PLATFORM_PIRATE_CONFUSABILITY_MAPPINGS_V1 = [
  ["0", "o"],
  ["1", "l"],
  ["3", "e"],
  ["4", "a"],
  ["5", "s"],
  ["7", "t"],
] as const;

export type PlatformPirateHashV1 = Readonly<{
  bytes: number;
  preimage: string;
  sha256: string;
}>;

export type PlatformPirateLabelPolicyV1 = Readonly<{
  label_policy_id: typeof PLATFORM_PIRATE_LABEL_POLICY_ID;
  label_policy_revision: 1;
  label_policy_hash: string;
  reserved_labels_id: typeof PLATFORM_PIRATE_RESERVED_LABELS_ID;
  reserved_labels_revision: 1;
  reserved_labels_hash: string;
  confusability_policy_id: typeof PLATFORM_PIRATE_CONFUSABILITY_POLICY_ID;
  confusability_policy_revision: 1;
  confusability_policy_hash: string;
}>;

const encoded = (value: readonly unknown[]): PlatformPirateHashV1 => {
  const preimage = JSON.stringify(value);
  return {
    bytes: new TextEncoder().encode(preimage).byteLength,
    preimage,
    sha256: sha256Hex(preimage),
  };
};

export function platformPirateReservedLabelsV1Hash(): PlatformPirateHashV1 {
  return encoded([
    "pirate-platform-reserved-labels-v1",
    1,
    PLATFORM_PIRATE_RESERVED_LABELS_V1,
    PLATFORM_PIRATE_RESERVED_PREFIXES_V1,
  ]);
}

export function platformPirateConfusabilityPolicyV1Hash(): PlatformPirateHashV1 {
  return encoded([
    "pirate-platform-confusability-v1",
    1,
    "remove-hyphen",
    PLATFORM_PIRATE_CONFUSABILITY_MAPPINGS_V1,
  ]);
}

export function platformPirateLabelPolicyV1(): PlatformPirateLabelPolicyV1 {
  const reserved = platformPirateReservedLabelsV1Hash();
  const confusability = platformPirateConfusabilityPolicyV1Hash();
  const policy = encoded([
    "pirate-platform-label-policy-v1",
    PLATFORM_PIRATE_LABEL_POLICY_ID,
    1,
    PLATFORM_PIRATE_RESERVED_LABELS_ID,
    1,
    reserved.sha256,
    PLATFORM_PIRATE_CONFUSABILITY_POLICY_ID,
    1,
    confusability.sha256,
  ]);
  return {
    label_policy_id: PLATFORM_PIRATE_LABEL_POLICY_ID,
    label_policy_revision: 1,
    label_policy_hash: policy.sha256,
    reserved_labels_id: PLATFORM_PIRATE_RESERVED_LABELS_ID,
    reserved_labels_revision: 1,
    reserved_labels_hash: reserved.sha256,
    confusability_policy_id: PLATFORM_PIRATE_CONFUSABILITY_POLICY_ID,
    confusability_policy_revision: 1,
    confusability_policy_hash: confusability.sha256,
  };
}

export function platformPirateLabelPolicyV1Hash(): PlatformPirateHashV1 {
  const policy = platformPirateLabelPolicyV1();
  return encoded([
    "pirate-platform-label-policy-v1",
    policy.label_policy_id,
    policy.label_policy_revision,
    policy.reserved_labels_id,
    policy.reserved_labels_revision,
    policy.reserved_labels_hash,
    policy.confusability_policy_id,
    policy.confusability_policy_revision,
    policy.confusability_policy_hash,
  ]);
}

export function isPlatformPirateLabelV1(value: string): boolean {
  const bytes = new TextEncoder().encode(value).byteLength;
  return (
    bytes >= 3 &&
    bytes <= 32 &&
    !value.startsWith("xn--") &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

export function isGeneratedPlatformPiratePlaceholderV1(value: string): boolean {
  return /^new-[0-9a-f]{20}$/u.test(value);
}

export function platformPirateConfusabilityKeyV1(value: string): string {
  const substitutions = new Map<string, string>(PLATFORM_PIRATE_CONFUSABILITY_MAPPINGS_V1);
  return [...value]
    .filter((character) => character !== "-")
    .map((character) => substitutions.get(character) ?? character)
    .join("");
}

export function isReservedPlatformPirateLabelV1(value: string): boolean {
  return (
    PLATFORM_PIRATE_RESERVED_LABELS_V1.some((label) => label === value) ||
    PLATFORM_PIRATE_RESERVED_PREFIXES_V1.some((prefix) => value.startsWith(prefix))
  );
}

export function platformPirateHandleStateV1Hash(input: {
  platform_handle_id: string;
  owner_persona_id: string;
  generation: number;
  handle_label: string;
  state: "active" | "redirect" | "retired";
  cleanup_rename_consumed: boolean;
  redirect_to_label: string | null;
}): PlatformPirateHashV1 {
  return encoded([
    "pirate-platform-handle-state-v1",
    input.platform_handle_id,
    input.owner_persona_id,
    input.generation,
    input.handle_label,
    input.state,
    input.cleanup_rename_consumed,
    input.redirect_to_label,
  ]);
}

export function platformPirateRenameRequestV1Hash(input: {
  actor_account_id: string;
  persona_id: string;
  platform_handle_id: string;
  expected_state_hash: string;
  desired_label: string;
  label_policy_hash: string;
  idempotency_key: string;
}): PlatformPirateHashV1 {
  return encoded([
    "pirate-platform-handle-rename-request-v1",
    "/platform-pirate-handles/rename",
    input.actor_account_id,
    input.persona_id,
    input.platform_handle_id,
    input.expected_state_hash,
    input.desired_label,
    input.label_policy_hash,
    input.idempotency_key,
  ]);
}

export function platformPirateRenameTransitionV1Hash(input: {
  platform_handle_id: string;
  owner_persona_id: string;
  previous_generation: number;
  previous_label: string;
  next_generation: number;
  next_label: string;
  previous_next_state: "redirect";
  previous_redirect_to_label: string;
  rename_request_hash: string;
}): PlatformPirateHashV1 {
  return encoded([
    "pirate-platform-handle-rename-transition-v1",
    input.platform_handle_id,
    input.owner_persona_id,
    input.previous_generation,
    input.previous_label,
    input.next_generation,
    input.next_label,
    input.previous_next_state,
    input.previous_redirect_to_label,
    input.rename_request_hash,
  ]);
}
