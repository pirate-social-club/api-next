import { sha256Hex } from "../gates-v2/sha256.ts";

export type HandleFamilyV1 = "hns" | "spaces";
export type HandleFulfillmentKindV1 =
  | "hosted_persona_v1"
  | "delegated_zone_v1"
  | "spaces_native_v1";
export type HandleAllocationKindV1 = "first_come_v1" | "direct_grant_v1" | "auction_v1";

export type HandleFreePricingV1 = Readonly<{
  kind: "free_v1";
  pricing_id: string;
  pricing_revision: number;
  pricing_hash: string;
  atomic_amount: "0";
}>;

export type HandleQualificationPolicyRefV1 =
  | Readonly<{
      kind: "none_v1";
      policy_id: string;
      policy_revision: number;
      policy_hash: string;
    }>
  | Readonly<{
      kind: "curated_policy_v1";
      policy_id: string;
      policy_revision: number;
      policy_hash: string;
      provider_binding_hash: string;
    }>;

export type HandleLabelScopeV2 =
  | Readonly<{
      kind: "exact_label_v2";
      label_grammar_id: "hns_ascii_ldh_1_63_v1";
      reserved_labels_id: string;
      reserved_labels_revision: number;
      reserved_labels_hash: string;
      handle_label: string;
    }>
  | Readonly<{
      kind: "label_rule_v2";
      label_grammar_id: "hns_ascii_ldh_1_63_v1";
      reserved_labels_id: string;
      reserved_labels_revision: number;
      reserved_labels_hash: string;
      availability: Readonly<{
        kind: "length_band_v1";
        min_label_length: number;
        max_label_length: number;
      }>;
    }>;

export type HandleHashResultV1 = Readonly<{
  bytes: number;
  preimage: string;
  sha256: string;
}>;

const encoded = (preimage: readonly unknown[]): HandleHashResultV1 => {
  const json = JSON.stringify(preimage);
  return {
    bytes: new TextEncoder().encode(json).byteLength,
    preimage: json,
    sha256: sha256Hex(json),
  };
};

const positiveRevision = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const nonNegativeGeneration = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const digest = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);
const identifier = (value: string): boolean =>
  value.length > 0 &&
  value === value.trim() &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const requireIdentifier = (value: string, name: string): void => {
  if (!identifier(value)) throw new TypeError(`Invalid ${name}`);
};
const requireRevision = (value: number, name: string): void => {
  if (!positiveRevision(value)) throw new TypeError(`Invalid ${name}`);
};
const requireDigest = (value: string, name: string): void => {
  if (!digest(value)) throw new TypeError(`Invalid ${name}`);
};

export function isCanonicalHnsHandleLabelV2(label: string): boolean {
  const byteLength = new TextEncoder().encode(label).byteLength;
  return (
    byteLength >= 1 &&
    byteLength <= 63 &&
    !label.startsWith("xn--") &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(label)
  );
}

const isCanonicalHnsRootLabel = (label: string): boolean => {
  const byteLength = new TextEncoder().encode(label).byteLength;
  return byteLength >= 1 && byteLength <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(label);
};

export function assertCanonicalHnsHandleLabelV2(label: string): void {
  if (!isCanonicalHnsHandleLabelV2(label)) throw new TypeError("invalid_handle");
}

export function handleFreePricingRevisionHash(input: {
  pricing_id: string;
  pricing_revision: number;
}): HandleHashResultV1 {
  requireIdentifier(input.pricing_id, "pricing id");
  requireRevision(input.pricing_revision, "pricing revision");
  return encoded([
    "pirate-handle-free-pricing-v1",
    input.pricing_id,
    input.pricing_revision,
    "free_v1",
    "0",
  ]);
}

export function handleAccountDirectoryBindingHash(input: {
  binding_version: string;
}): HandleHashResultV1 {
  requireIdentifier(input.binding_version, "account-directory binding version");
  return encoded([
    "pirate-handle-account-directory-binding-v1",
    "account_directory_v1",
    input.binding_version,
  ]);
}

export function handleAccountAllowlistPolicyRequestV1Hash(input: {
  actor_account_id: string;
  community_id: string;
  subject_account_id: string;
  expected_account_directory_binding_version: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) requireIdentifier(value, name);
  return encoded([
    "pirate-handle-account-allowlist-policy-request-v1",
    "/communities/:communityId/handle-qualification-policies",
    input.actor_account_id,
    input.community_id,
    input.subject_account_id,
    "account_directory_v1",
    input.expected_account_directory_binding_version,
    input.idempotency_key,
  ]);
}

export function handleDirectGrantRecipientTokenRequestHash(input: {
  actor_account_id: string;
  community_id: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) requireIdentifier(value, name);
  return encoded([
    "pirate-handle-direct-grant-recipient-token-request-v1",
    "/communities/:communityId/handle-direct-grant-recipient-tokens",
    input.actor_account_id,
    input.community_id,
    input.idempotency_key,
  ]);
}

export function handleAccountAllowlistPolicyRequestV2Hash(input: {
  actor_account_id: string;
  community_id: string;
  resolved_subject_account_id: string;
  expected_account_directory_binding_version: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) requireIdentifier(value, name);
  return encoded([
    "pirate-handle-account-allowlist-policy-request-v2",
    "/communities/:communityId/handle-qualification-policies",
    input.actor_account_id,
    input.community_id,
    input.resolved_subject_account_id,
    "account_directory_v1",
    input.expected_account_directory_binding_version,
    input.idempotency_key,
  ]);
}

export function handleAccountAllowlistPolicyHash(input: {
  policy_id: string;
  policy_revision: number;
  requirement_id: string;
  requirement_revision: number;
  subject_account_id: string;
  binding_version: string;
  binding_hash: string;
}): HandleHashResultV1 {
  requireIdentifier(input.policy_id, "policy id");
  requireRevision(input.policy_revision, "policy revision");
  requireIdentifier(input.requirement_id, "requirement id");
  requireRevision(input.requirement_revision, "requirement revision");
  requireIdentifier(input.subject_account_id, "subject account id");
  requireIdentifier(input.binding_version, "binding version");
  requireDigest(input.binding_hash, "binding hash");
  return encoded([
    "pirate-handle-account-allowlist-policy-v1",
    input.policy_id,
    input.policy_revision,
    [
      "account_allowlist_v1",
      input.requirement_id,
      input.requirement_revision,
      input.subject_account_id,
    ],
    ["account_directory_v1", input.binding_version, input.binding_hash],
  ]);
}

export function handleQualificationPolicyPreimage(
  qualification: HandleQualificationPolicyRefV1,
): readonly unknown[] {
  requireIdentifier(qualification.policy_id, "policy id");
  requireRevision(qualification.policy_revision, "policy revision");
  requireDigest(qualification.policy_hash, "policy hash");
  if (qualification.kind === "none_v1") {
    return [
      qualification.kind,
      qualification.policy_id,
      qualification.policy_revision,
      qualification.policy_hash,
    ];
  }
  requireDigest(qualification.provider_binding_hash, "provider binding hash");
  return [
    qualification.kind,
    qualification.policy_id,
    qualification.policy_revision,
    qualification.policy_hash,
    qualification.provider_binding_hash,
  ];
}

export function handleDirectGrantQualificationHash(input: {
  policy_id: string;
  policy_revision: number;
  policy_hash: string;
  provider_binding_hash: string;
}): HandleHashResultV1 {
  return encoded(handleQualificationPolicyPreimage({ kind: "curated_policy_v1", ...input }));
}

export function handleSaleNamespaceActivationHash(input: {
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  community_id: string;
  family: "hns";
  canonical_root: string;
  namespace_authority_reference: string;
  namespace_authority_generation: number;
  dns_zone_activation_id: string;
  dns_zone_activation_generation: number;
}): HandleHashResultV1 {
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireIdentifier(input.community_id, "community id");
  if (!isCanonicalHnsRootLabel(input.canonical_root)) {
    throw new TypeError("Invalid canonical HNS root");
  }
  requireIdentifier(input.namespace_authority_reference, "namespace authority reference");
  requireRevision(input.namespace_authority_generation, "namespace authority generation");
  requireIdentifier(input.dns_zone_activation_id, "DNS-zone activation id");
  requireRevision(input.dns_zone_activation_generation, "DNS-zone activation generation");
  return encoded([
    "pirate-handle-sale-namespace-activation-v1",
    input.sale_namespace_activation_id,
    input.sale_namespace_activation_generation,
    input.community_id,
    input.family,
    input.canonical_root,
    [
      "verified_namespace_v1",
      input.namespace_authority_reference,
      input.namespace_authority_generation,
    ],
    [
      "hns_dns_zone_activation_v1",
      input.dns_zone_activation_id,
      input.dns_zone_activation_generation,
    ],
    ["dedicated_root_replace_v1", true],
  ]);
}

export function handleLabelScopeV2Preimage(scope: HandleLabelScopeV2): readonly unknown[] {
  if (scope.label_grammar_id !== "hns_ascii_ldh_1_63_v1") {
    throw new TypeError("Unsupported handle grammar");
  }
  requireIdentifier(scope.reserved_labels_id, "reserved-label document id");
  requireRevision(scope.reserved_labels_revision, "reserved-label revision");
  requireDigest(scope.reserved_labels_hash, "reserved-label hash");
  if (scope.kind === "exact_label_v2") {
    assertCanonicalHnsHandleLabelV2(scope.handle_label);
    return [
      scope.kind,
      scope.label_grammar_id,
      scope.reserved_labels_id,
      scope.reserved_labels_revision,
      scope.reserved_labels_hash,
      scope.handle_label,
    ];
  }
  const { min_label_length: minimum, max_label_length: maximum } = scope.availability;
  if (
    scope.availability.kind !== "length_band_v1" ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 8 ||
    maximum > 32 ||
    minimum > maximum
  ) {
    throw new TypeError("Invalid free broad handle availability band");
  }
  return [
    scope.kind,
    scope.label_grammar_id,
    scope.reserved_labels_id,
    scope.reserved_labels_revision,
    scope.reserved_labels_hash,
    [scope.availability.kind, minimum, maximum],
  ];
}

export function resolvedHandleAccountCap(input: {
  label_scope_kind: HandleLabelScopeV2["kind"];
  allocation_kind: HandleAllocationKindV1;
  requested_cap?: number | null;
}): number | null {
  if (input.label_scope_kind === "exact_label_v2" && input.allocation_kind === "direct_grant_v1") {
    if (input.requested_cap !== undefined && input.requested_cap !== null) {
      throw new TypeError("Exact direct grants require an unlimited account cap");
    }
    return null;
  }
  if (input.label_scope_kind === "label_rule_v2" && input.allocation_kind === "first_come_v1") {
    const resolved = input.requested_cap === undefined ? 1 : input.requested_cap;
    if (resolved !== null && (!Number.isSafeInteger(resolved) || resolved < 1)) {
      throw new TypeError("Invalid handle account cap");
    }
    return resolved;
  }
  throw new TypeError("Unsupported handle allocation");
}

export function assertHandleOfferingCombinationV2(input: {
  label_scope: HandleLabelScopeV2;
  allocation_kind: HandleAllocationKindV1;
  fulfillment_kind: HandleFulfillmentKindV1;
  qualification_kind: HandleQualificationPolicyRefV1["kind"];
  pricing_kind: string;
  atomic_amount: string;
}): void {
  handleLabelScopeV2Preimage(input.label_scope);
  if (
    input.fulfillment_kind !== "hosted_persona_v1" ||
    input.pricing_kind !== "free_v1" ||
    input.atomic_amount !== "0" ||
    (input.label_scope.kind === "label_rule_v2" &&
      (input.allocation_kind !== "first_come_v1" || input.qualification_kind !== "none_v1")) ||
    (input.label_scope.kind === "exact_label_v2" &&
      (input.allocation_kind !== "direct_grant_v1" ||
        input.qualification_kind !== "curated_policy_v1"))
  ) {
    throw new TypeError("Unsupported handle offering combination");
  }
}

export function handleOfferingRevisionV1Hash(input: {
  offering_id: string;
  offering_revision: number;
  community_id: string;
  family: HandleFamilyV1;
  namespace_root: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  label_scope_preimage: readonly unknown[];
  qualification_policy: HandleQualificationPolicyRefV1;
  pricing: HandleFreePricingV1;
  issuance_driver_id: string;
  issuance_driver_version: string;
  quote_ttl_seconds: number;
  reservation_ttl_seconds: number;
}): HandleHashResultV1 {
  requireIdentifier(input.offering_id, "offering id");
  requireRevision(input.offering_revision, "offering revision");
  requireIdentifier(input.community_id, "community id");
  requireIdentifier(input.namespace_root, "namespace root");
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireIdentifier(input.issuance_driver_id, "issuance driver id");
  requireIdentifier(input.issuance_driver_version, "issuance driver version");
  const pricing = handleFreePricingRevisionHash(input.pricing);
  if (pricing.sha256 !== input.pricing.pricing_hash) throw new TypeError("Stale pricing hash");
  return encoded([
    "pirate-handle-offering-revision-v1",
    input.offering_id,
    input.offering_revision,
    input.community_id,
    input.family,
    input.namespace_root,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    input.label_scope_preimage,
    handleQualificationPolicyPreimage(input.qualification_policy),
    [
      input.pricing.kind,
      input.pricing.pricing_id,
      input.pricing.pricing_revision,
      input.pricing.pricing_hash,
      input.pricing.atomic_amount,
    ],
    [input.family, input.issuance_driver_id, input.issuance_driver_version],
    input.quote_ttl_seconds,
    input.reservation_ttl_seconds,
  ]);
}

export function handleOfferingRevisionV2Hash(input: {
  offering_id: string;
  offering_revision: number;
  community_id: string;
  family: HandleFamilyV1;
  namespace_root: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  label_scope: HandleLabelScopeV2;
  allocation_kind: HandleAllocationKindV1;
  max_active_grants_per_account: number | null;
  fulfillment_kind: HandleFulfillmentKindV1;
  qualification_policy: HandleQualificationPolicyRefV1;
  pricing: HandleFreePricingV1;
  issuance_driver_id: string;
  issuance_driver_version: string;
  quote_ttl_seconds: number;
  reservation_ttl_seconds: number;
}): HandleHashResultV1 {
  requireIdentifier(input.offering_id, "offering id");
  requireRevision(input.offering_revision, "offering revision");
  requireIdentifier(input.community_id, "community id");
  requireIdentifier(input.namespace_root, "namespace root");
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireIdentifier(input.issuance_driver_id, "issuance driver id");
  requireIdentifier(input.issuance_driver_version, "issuance driver version");
  if (
    input.max_active_grants_per_account !== null &&
    (!Number.isSafeInteger(input.max_active_grants_per_account) ||
      input.max_active_grants_per_account < 1)
  ) {
    throw new TypeError("Invalid handle account cap");
  }
  if (
    !Number.isSafeInteger(input.quote_ttl_seconds) ||
    input.quote_ttl_seconds < 30 ||
    input.quote_ttl_seconds > 900 ||
    !Number.isSafeInteger(input.reservation_ttl_seconds) ||
    input.reservation_ttl_seconds < 30 ||
    input.reservation_ttl_seconds > 300
  ) {
    throw new TypeError("Invalid handle TTL");
  }
  const pricing = handleFreePricingRevisionHash(input.pricing);
  if (pricing.sha256 !== input.pricing.pricing_hash) throw new TypeError("Stale pricing hash");
  return encoded([
    "pirate-handle-offering-revision-v2",
    input.offering_id,
    input.offering_revision,
    input.community_id,
    input.family,
    input.namespace_root,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    handleLabelScopeV2Preimage(input.label_scope),
    [input.allocation_kind],
    ["account_cap_v1", input.max_active_grants_per_account],
    [input.fulfillment_kind],
    handleQualificationPolicyPreimage(input.qualification_policy),
    [
      input.pricing.kind,
      input.pricing.pricing_id,
      input.pricing.pricing_revision,
      input.pricing.pricing_hash,
      input.pricing.atomic_amount,
    ],
    [input.family, input.issuance_driver_id, input.issuance_driver_version],
    input.quote_ttl_seconds,
    input.reservation_ttl_seconds,
  ]);
}

export type HandleEligibilitySnapshotV1 = Readonly<{
  decision: "passed";
  policy_revision: number;
  policy_hash: string;
  evidence_use_ids: readonly string[];
  evaluated_at: string;
}>;

const eligibilityPreimage = (eligibility: HandleEligibilitySnapshotV1): readonly unknown[] => {
  requireRevision(eligibility.policy_revision, "eligibility policy revision");
  requireDigest(eligibility.policy_hash, "eligibility policy hash");
  for (const evidenceId of eligibility.evidence_use_ids) {
    requireIdentifier(evidenceId, "evidence-use id");
  }
  requireIdentifier(eligibility.evaluated_at, "eligibility evaluation instant");
  return [
    eligibility.decision,
    eligibility.policy_revision,
    eligibility.policy_hash,
    eligibility.evidence_use_ids,
    eligibility.evaluated_at,
  ];
};

export function handleQuoteV2Hash(input: {
  quote_id: string;
  offering_id: string;
  offering_revision: number;
  offering_hash: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  fulfillment_kind: HandleFulfillmentKindV1;
  owner_persona_id: string;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  pricing: HandleFreePricingV1;
  eligibility: HandleEligibilitySnapshotV1;
  quoted_at: string;
  expires_at: string;
}): HandleHashResultV1 {
  requireIdentifier(input.quote_id, "quote id");
  requireIdentifier(input.offering_id, "offering id");
  requireRevision(input.offering_revision, "offering revision");
  requireDigest(input.offering_hash, "offering hash");
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireIdentifier(input.owner_persona_id, "owner persona id");
  requireIdentifier(input.namespace_root, "namespace root");
  assertCanonicalHnsHandleLabelV2(input.handle_label);
  requireIdentifier(input.quoted_at, "quote instant");
  requireIdentifier(input.expires_at, "quote expiry");
  return encoded([
    "pirate-handle-quote-v2",
    input.quote_id,
    input.offering_id,
    input.offering_revision,
    input.offering_hash,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    [input.fulfillment_kind],
    input.owner_persona_id,
    [input.family, input.namespace_root, input.handle_label],
    [
      input.pricing.kind,
      input.pricing.pricing_id,
      input.pricing.pricing_revision,
      input.pricing.pricing_hash,
      input.pricing.atomic_amount,
    ],
    eligibilityPreimage(input.eligibility),
    input.quoted_at,
    input.expires_at,
  ]);
}

export function handleReservationV2Hash(input: {
  reservation_id: string;
  quote_id: string;
  quote_hash: string;
  offering_id: string;
  offering_hash: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  fulfillment_kind: HandleFulfillmentKindV1;
  owner_persona_id: string;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  reserved_at: string;
  expires_at: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string" && name !== "family" && name !== "fulfillment_kind") {
      requireIdentifier(value, name);
    }
  }
  requireDigest(input.quote_hash, "quote hash");
  requireDigest(input.offering_hash, "offering hash");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  assertCanonicalHnsHandleLabelV2(input.handle_label);
  return encoded([
    "pirate-handle-reservation-v2",
    input.reservation_id,
    input.quote_id,
    input.quote_hash,
    input.offering_id,
    input.offering_hash,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    [input.fulfillment_kind],
    input.owner_persona_id,
    [input.family, input.namespace_root, input.handle_label],
    input.reserved_at,
    input.expires_at,
  ]);
}

export function handleGrantFinalizeV2Hash(input: {
  claim_id: string;
  reservation_id: string;
  reservation_hash: string;
  offering_id: string;
  offering_hash: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  fulfillment_kind: HandleFulfillmentKindV1;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  owner_persona_id: string;
  issuance_operation_id: string;
  claim_request_hash: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string" && name !== "family" && name !== "fulfillment_kind") {
      requireIdentifier(value, name);
    }
  }
  requireDigest(input.reservation_hash, "reservation hash");
  requireDigest(input.offering_hash, "offering hash");
  requireDigest(input.claim_request_hash, "claim request hash");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  assertCanonicalHnsHandleLabelV2(input.handle_label);
  return encoded([
    "pirate-handle-grant-finalize-v2",
    input.claim_id,
    input.reservation_id,
    input.reservation_hash,
    input.offering_id,
    input.offering_hash,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    [input.fulfillment_kind],
    [input.family, input.namespace_root, input.handle_label],
    input.owner_persona_id,
    input.issuance_operation_id,
    input.claim_request_hash,
  ]);
}

export function handleGrantFinalizeV1Hash(input: {
  claim_id: string;
  reservation_id: string;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  owner_persona_id: string;
  issuance_operation_id: string;
  claim_request_hash: string;
}): HandleHashResultV1 {
  requireIdentifier(input.claim_id, "claim id");
  requireIdentifier(input.reservation_id, "reservation id");
  requireIdentifier(input.namespace_root, "namespace root");
  assertCanonicalHnsHandleLabelV2(input.handle_label);
  requireIdentifier(input.owner_persona_id, "owner persona id");
  requireIdentifier(input.issuance_operation_id, "issuance operation id");
  requireDigest(input.claim_request_hash, "claim request hash");
  return encoded([
    "pirate-handle-grant-finalize-v1",
    input.claim_id,
    input.reservation_id,
    input.family,
    input.namespace_root,
    input.handle_label,
    input.owner_persona_id,
    input.issuance_operation_id,
    input.claim_request_hash,
  ]);
}

export function handlePersonaPublicIdentityHash(input: {
  persona_id: string;
  public_linkage_generation: number;
}): HandleHashResultV1 {
  requireIdentifier(input.persona_id, "persona id");
  if (!nonNegativeGeneration(input.public_linkage_generation)) {
    throw new TypeError("Invalid public-linkage generation");
  }
  return encoded([
    "pirate-handle-persona-public-identity-v1",
    input.persona_id,
    input.public_linkage_generation,
  ]);
}

export function handlePersonaLinkConfirmationRequestHash(input: {
  actor_account_id: string;
  persona_id: string;
  offering_id: string;
  target_community_id: string;
  family: HandleFamilyV1;
  namespace_root: string;
  persona_public_identity_digest: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string" && name !== "family") requireIdentifier(value, name);
  }
  requireDigest(input.persona_public_identity_digest, "persona identity digest");
  return encoded([
    "pirate-handle-persona-link-confirmation-v1",
    "/handle-persona-link-confirmations",
    input.actor_account_id,
    input.persona_id,
    input.offering_id,
    input.target_community_id,
    input.family,
    input.namespace_root,
    input.persona_public_identity_digest,
    true,
    input.idempotency_key,
  ]);
}

export function handleQuoteRequestHash(input: {
  actor_account_id: string;
  persona_id: string;
  offering_id: string;
  desired_label: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) requireIdentifier(value, name);
  return encoded([
    "pirate-handle-quote-request-v1",
    "/handle-quotes",
    input.actor_account_id,
    input.persona_id,
    input.offering_id,
    input.desired_label,
    input.idempotency_key,
  ]);
}

export function handleReservationRequestHash(input: {
  actor_account_id: string;
  persona_id: string;
  quote_id: string;
  expected_quote_hash: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) requireIdentifier(value, name);
  requireDigest(input.expected_quote_hash, "expected quote hash");
  return encoded([
    "pirate-handle-reservation-request-v1",
    "/handle-reservations",
    input.actor_account_id,
    input.persona_id,
    input.quote_id,
    input.expected_quote_hash,
    input.idempotency_key,
  ]);
}

export function handleClaimRequestHash(input: {
  actor_account_id: string;
  persona_id: string;
  reservation_id: string;
  expected_reservation_hash: string;
  idempotency_key: string;
}): HandleHashResultV1 {
  for (const [name, value] of Object.entries(input)) requireIdentifier(value, name);
  requireDigest(input.expected_reservation_hash, "expected reservation hash");
  return encoded([
    "pirate-handle-claim-request-v1",
    "/handle-claims",
    input.actor_account_id,
    input.persona_id,
    input.reservation_id,
    input.expected_reservation_hash,
    input.idempotency_key,
  ]);
}

export type EffectiveHandleOfferingV2 = Readonly<{
  offering_id: string;
  label_scope: HandleLabelScopeV2;
}>;

export type HandleOfferingClassificationV2 =
  | Readonly<{ kind: "handle_unavailable" }>
  | Readonly<{ kind: "not_offered" }>
  | Readonly<{ kind: "offered"; offering: EffectiveHandleOfferingV2 }>;

export function classifyEffectiveHandleOfferingV2(input: {
  label: string;
  platform_reserved_labels: ReadonlySet<string>;
  namespace_reserved_labels: ReadonlySet<string>;
  active_offerings: readonly EffectiveHandleOfferingV2[];
}): HandleOfferingClassificationV2 {
  assertCanonicalHnsHandleLabelV2(input.label);
  if (
    input.platform_reserved_labels.has(input.label) ||
    input.namespace_reserved_labels.has(input.label)
  ) {
    return { kind: "handle_unavailable" };
  }
  const exact = input.active_offerings.filter(
    ({ label_scope: scope }) =>
      scope.kind === "exact_label_v2" && scope.handle_label === input.label,
  );
  if (exact.length > 1) throw new TypeError("Ambiguous exact handle offering");
  if (exact[0] !== undefined) return { kind: "offered", offering: exact[0] };
  const broad = input.active_offerings.filter(({ label_scope: scope }) => {
    if (scope.kind !== "label_rule_v2") return false;
    return (
      input.label.length >= scope.availability.min_label_length &&
      input.label.length <= scope.availability.max_label_length
    );
  });
  if (broad.length > 1) throw new TypeError("Ambiguous broad handle offering");
  return broad[0] === undefined ? { kind: "not_offered" } : { kind: "offered", offering: broad[0] };
}

export function assertRequestedOfferingIsEffectiveV2(input: {
  requested_offering_id: string;
  classification: HandleOfferingClassificationV2;
}): void {
  if (
    input.classification.kind !== "offered" ||
    input.classification.offering.offering_id !== input.requested_offering_id
  ) {
    throw new TypeError("offering_not_applicable");
  }
}

export type HandleSaleActivationStatusV1 = "pending" | "active" | "suspended" | "revoked";

export function transitionHandleSaleActivationV1(
  current: HandleSaleActivationStatusV1,
  requested: HandleSaleActivationStatusV1,
): HandleSaleActivationStatusV1 {
  if (current === "revoked") throw new TypeError("Revoked sale activation is terminal");
  if (current === requested) throw new TypeError("Sale activation transition must advance state");
  if (requested === "pending") throw new TypeError("Sale activation cannot return to pending");
  return requested;
}
