/**
 * Pure application-side route-revalidation authority and digest helpers.
 *
 * The arrays in this module are the byte-level ABI from spec 012 §§4.3–4.4.
 * They intentionally do not reuse the namespace-ownership creation types:
 * route revalidation has its own authority, session, attempt, evidence, and
 * terminal-result domains.
 *
 * Callers must provide values that were already strict-schema decoded at the
 * application boundary. This pure slice hashes typed values; it is not a wire
 * decoder and deliberately does not parse provider JSON.
 */

export const HNS_ROUTE_REVALIDATION_AUTHORITY_VERSION =
  "pirate-hns-route-revalidation-authority-v1" as const;
export const HNS_ROUTE_REVALIDATION_REQUIREMENT_PREIMAGE_VERSION =
  "pirate-hns-route-revalidation-requirement-v1" as const;
export const HNS_ROUTE_REVALIDATION_REQUEST_PREIMAGE_VERSION =
  "pirate-hns-route-revalidation-request-v1" as const;
export const HNS_ROUTE_REVALIDATION_COMPLETION_PREIMAGE_VERSION =
  "pirate-hns-route-revalidation-completion-request-v1" as const;
export const HNS_ROUTE_REVALIDATION_EVIDENCE_VERSION =
  "pirate-hns-route-revalidation-evidence-v1" as const;
export const HNS_ROUTE_REVALIDATION_RESULT_VERSION =
  "pirate-hns-route-revalidation-result-v1" as const;
export const HNS_ROUTE_REVALIDATION_PROVIDER_IDENTITY_VERSION =
  "pirate-hns-provider-identity-v1" as const;

export const HNS_ROUTE_REVALIDATION_PROVIDER_ID = "hns.owner.v1" as const;
export const HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION = "hns-txt-v1" as const;

export type HnsRouteRevalidationProviderConfigurationKind = "managed" | "dynamic";

export type HnsRouteRevalidationProviderConfiguration = Readonly<{
  readonly kind: HnsRouteRevalidationProviderConfigurationKind;
  readonly reference: string;
  readonly version: string;
}>;

export type HnsRouteRevalidationRoute = Readonly<{
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly href: string;
  readonly app_host: null;
}>;

/** The target-owned, creation-free authority captured before provider work. */
export type HnsRouteRevalidationAuthorityV1 = Readonly<{
  readonly version: typeof HNS_ROUTE_REVALIDATION_AUTHORITY_VERSION;
  readonly route_revalidation_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly principal_kind: "system";
  readonly principal_id: string;
  readonly expected_binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly requirement_hash: string;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration_kind: HnsRouteRevalidationProviderConfigurationKind;
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly protocol_version: typeof HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION;
  readonly environment: string;
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
}>;

/** Strict provider-start body for a route-revalidation operation. */
export type HnsOwnerRouteRevalidationStartWireV1 = Readonly<{
  readonly operation_kind: "route_revalidation";
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly principal_kind: "system";
  readonly principal_id: string;
  readonly requirement_hash: string;
  readonly start_request_hash: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration: HnsRouteRevalidationProviderConfiguration;
  readonly protocol_version: typeof HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION;
  readonly environment: string;
  readonly route: HnsRouteRevalidationRoute;
}>;

export type HnsRouteRevalidationCompletionHashInput = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly route_revalidation_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly evidence_ref: string;
  readonly fence_token: number;
}>;

export type HnsRouteRevalidationProviderIdentityInput = Readonly<{
  readonly provider_id: string;
  readonly provider_configuration_kind: HnsRouteRevalidationProviderConfigurationKind;
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly protocol_version: typeof HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION;
  readonly root_label: string;
}>;

export type HnsRouteRevalidationOwnershipSource =
  | "hns_parent_chain_txt"
  | "owner_authoritative_dns_txt";

/** Immutable revalidation evidence envelope from spec 012 §4.3. */
export type HnsRouteRevalidationEvidenceEnvelopeV1 = Readonly<{
  readonly version: typeof HNS_ROUTE_REVALIDATION_EVIDENCE_VERSION;
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly route_revalidation_attempt_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly principal_kind: "system";
  readonly principal_id: string;
  readonly requirement_hash: string;
  readonly expected_binding_generation: number;
  readonly binding_generation: number;
  readonly expected_verified_evidence_ref: string | null;
  readonly start_request_hash: string;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly provider_configuration_kind: HnsRouteRevalidationProviderConfigurationKind;
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly protocol_version: typeof HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION;
  readonly environment: string;
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly upstream_session_ref: string;
  readonly ownership_source: HnsRouteRevalidationOwnershipSource;
  readonly challenge_name: string;
  readonly challenge_value_sha256: string;
  readonly root_exists: true;
  readonly root_control_verified: true;
  readonly expiry_horizon_sufficient: true;
  readonly chain_network: string;
  readonly chain_anchor_height: number;
  readonly chain_anchor_block_hash: string;
  readonly chain_anchor_median_time: number;
  readonly expiry_height: number;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly evidence_ref: string;
  readonly provider_evidence_ref: string;
  readonly observation_sha256: string;
  readonly provider_identity_digest: string;
  readonly evidence_digest: string;
}>;

export type HnsRouteRevalidationTerminalOutcomeV1 =
  | "verified"
  | "missing_root"
  | "control_failed"
  | "challenge_mismatch"
  | "insufficient_expiry"
  | "disputed"
  | "revoked"
  | "database_time_expired"
  | "session_expired"
  | "stale_cas";

export type HnsRouteRevalidationResultHashInput = Readonly<{
  readonly route_revalidation_id: string;
  readonly revalidation_session_id: string;
  readonly route_revalidation_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly idempotency_key: string;
  readonly completion_request_hash: string;
  readonly outcome_status: HnsRouteRevalidationTerminalOutcomeV1;
  readonly evidence_ref_or_null: string | null;
  readonly evidence_digest_or_null: string | null;
  readonly provider_identity_digest_or_null: string | null;
  readonly ownership_status_or_null: string | null;
  readonly route_lifecycle_status_or_null: string | null;
}>;

type OrderedArrayValue = string | number | boolean | null;

function rejectCreationAuthority(value: unknown, path = "input"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      rejectCreationAuthority(member, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    if (key === "creation_intent_id" || key === "ceremony_intent_id") {
      throw new TypeError(`Route revalidation is creation-free; forbidden ${path}.${key}`);
    }
    rejectCreationAuthority(member, `${path}.${key}`);
  }
}

function assertAuthorityInput(value: unknown): asserts value is Record<string, unknown> {
  rejectCreationAuthority(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Route-revalidation hash input must be an object");
  }
}

function orderedJson(values: readonly OrderedArrayValue[]): string {
  return JSON.stringify(values);
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

/** SHA-256 over the exact UTF-8 bytes supplied by the caller. */
export function sha256RouteRevalidationBytes(value: Uint8Array): Promise<string> {
  return sha256Hex(new Uint8Array(value));
}

/** SHA-256 over UTF-8 encoding without normalization or reserialization. */
export function sha256RouteRevalidationUtf8(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

export function hnsRouteRevalidationRequirementPreimage(
  authority: HnsRouteRevalidationAuthorityV1,
): string {
  assertAuthorityInput(authority);
  if (authority.provider_id !== HNS_ROUTE_REVALIDATION_PROVIDER_ID) {
    throw new TypeError("Invalid HNS route-revalidation authority provider_id");
  }
  if (
    authority.version !== HNS_ROUTE_REVALIDATION_AUTHORITY_VERSION ||
    authority.principal_kind !== "system" ||
    authority.family !== "hns" ||
    authority.protocol_version !== HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION
  ) {
    throw new TypeError("Invalid HNS route-revalidation authority");
  }
  return orderedJson([
    HNS_ROUTE_REVALIDATION_REQUIREMENT_PREIMAGE_VERSION,
    authority.community_id,
    authority.route_binding_id,
    authority.expected_binding_generation,
    authority.expected_verified_evidence_ref,
    "system",
    authority.principal_id,
    authority.provider_id,
    authority.provider_binding_hash,
    authority.provider_configuration_kind,
    authority.provider_configuration_reference,
    authority.provider_configuration_version,
    authority.protocol_version,
    authority.environment,
    "hns",
    authority.root_label,
    authority.root_label_display,
    authority.path_segment,
  ]);
}

export function hnsRouteRevalidationRequirementHash(
  authority: HnsRouteRevalidationAuthorityV1,
): Promise<string> {
  return sha256RouteRevalidationUtf8(hnsRouteRevalidationRequirementPreimage(authority));
}

export function hnsRouteRevalidationStartPreimage(
  input: HnsOwnerRouteRevalidationStartWireV1,
): string {
  assertAuthorityInput(input);
  if (
    input.operation_kind !== "route_revalidation" ||
    input.principal_kind !== "system" ||
    input.route.family !== "hns" ||
    input.route.app_host !== null ||
    input.protocol_version !== HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION
  ) {
    throw new TypeError("Invalid HNS route-revalidation start wire");
  }
  return orderedJson([
    HNS_ROUTE_REVALIDATION_REQUEST_PREIMAGE_VERSION,
    input.route_revalidation_id,
    input.revalidation_session_id,
    input.route_binding_id,
    input.community_id,
    input.expected_binding_generation,
    input.expected_verified_evidence_ref,
    "system",
    input.principal_id,
    input.requirement_hash,
    HNS_ROUTE_REVALIDATION_PROVIDER_ID,
    input.provider_binding_hash,
    input.provider_configuration.kind,
    input.provider_configuration.reference,
    input.provider_configuration.version,
    input.protocol_version,
    input.environment,
    "hns",
    input.route.root_label,
    input.route.root_label_display,
    input.route.path_segment,
  ]);
}

export function hnsRouteRevalidationStartHash(
  input: HnsOwnerRouteRevalidationStartWireV1,
): Promise<string> {
  return sha256RouteRevalidationUtf8(hnsRouteRevalidationStartPreimage(input));
}

export function hnsRouteRevalidationCompletionPreimage(
  input: HnsRouteRevalidationCompletionHashInput,
): string {
  assertAuthorityInput(input);
  return orderedJson([
    HNS_ROUTE_REVALIDATION_COMPLETION_PREIMAGE_VERSION,
    input.route_revalidation_id,
    input.revalidation_session_id,
    input.route_revalidation_attempt_id,
    input.route_binding_id,
    input.expected_binding_generation,
    input.expected_verified_evidence_ref,
    input.attempt_number,
    input.idempotency_key,
    input.evidence_ref,
    input.fence_token,
    "poll_result",
  ]);
}

export function hnsRouteRevalidationCompletionHash(
  input: HnsRouteRevalidationCompletionHashInput,
): Promise<string> {
  return sha256RouteRevalidationUtf8(hnsRouteRevalidationCompletionPreimage(input));
}

export function hnsRouteRevalidationChallengeValueSha256(value: string): Promise<string> {
  return sha256RouteRevalidationUtf8(value);
}

export function hnsRouteRevalidationObservationSha256(value: Uint8Array): Promise<string> {
  return sha256RouteRevalidationBytes(value);
}

export function hnsRouteRevalidationProviderIdentityPreimage(
  input: HnsRouteRevalidationProviderIdentityInput,
): string {
  assertAuthorityInput(input);
  if (
    input.provider_id !== HNS_ROUTE_REVALIDATION_PROVIDER_ID ||
    input.protocol_version !== HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION
  ) {
    throw new TypeError("Invalid HNS route-revalidation provider identity");
  }
  return orderedJson([
    HNS_ROUTE_REVALIDATION_PROVIDER_IDENTITY_VERSION,
    input.provider_id,
    input.provider_configuration_kind,
    input.provider_configuration_reference,
    input.provider_configuration_version,
    input.protocol_version,
    "hns",
    input.root_label,
  ]);
}

export function hnsRouteRevalidationProviderIdentityDigest(
  input: HnsRouteRevalidationProviderIdentityInput,
): Promise<string> {
  return sha256RouteRevalidationUtf8(hnsRouteRevalidationProviderIdentityPreimage(input));
}

export function hnsRouteRevalidationEvidencePreimage(
  evidence: HnsRouteRevalidationEvidenceEnvelopeV1,
): string {
  assertAuthorityInput(evidence);
  if (
    evidence.version !== HNS_ROUTE_REVALIDATION_EVIDENCE_VERSION ||
    evidence.principal_kind !== "system" ||
    evidence.family !== "hns" ||
    evidence.protocol_version !== HNS_ROUTE_REVALIDATION_PROTOCOL_VERSION ||
    evidence.root_exists !== true ||
    evidence.root_control_verified !== true ||
    evidence.expiry_horizon_sufficient !== true
  ) {
    throw new TypeError("Invalid HNS route-revalidation evidence envelope");
  }
  return orderedJson([
    HNS_ROUTE_REVALIDATION_EVIDENCE_VERSION,
    evidence.route_revalidation_id,
    evidence.revalidation_session_id,
    evidence.route_revalidation_attempt_id,
    evidence.community_id,
    evidence.route_binding_id,
    "system",
    evidence.principal_id,
    evidence.requirement_hash,
    evidence.expected_binding_generation,
    evidence.binding_generation,
    evidence.expected_verified_evidence_ref,
    evidence.start_request_hash,
    evidence.provider_id,
    evidence.provider_binding_hash,
    evidence.provider_configuration_kind,
    evidence.provider_configuration_reference,
    evidence.provider_configuration_version,
    evidence.protocol_version,
    evidence.environment,
    "hns",
    evidence.root_label,
    evidence.root_label_display,
    evidence.path_segment,
    evidence.upstream_session_ref,
    evidence.ownership_source,
    evidence.challenge_name,
    evidence.challenge_value_sha256,
    true,
    true,
    true,
    evidence.chain_network,
    evidence.chain_anchor_height,
    evidence.chain_anchor_block_hash,
    evidence.chain_anchor_median_time,
    evidence.expiry_height,
    evidence.observed_at,
    evidence.expires_at,
    evidence.evidence_ref,
    evidence.provider_evidence_ref,
    evidence.observation_sha256,
    evidence.provider_identity_digest,
  ]);
}

export function hnsRouteRevalidationEvidenceHash(
  evidence: HnsRouteRevalidationEvidenceEnvelopeV1,
): Promise<string> {
  return sha256RouteRevalidationUtf8(hnsRouteRevalidationEvidencePreimage(evidence));
}

export function hnsRouteRevalidationResultPreimage(
  input: HnsRouteRevalidationResultHashInput,
): string {
  assertAuthorityInput(input);
  return orderedJson([
    HNS_ROUTE_REVALIDATION_RESULT_VERSION,
    input.route_revalidation_id,
    input.revalidation_session_id,
    input.route_revalidation_attempt_id,
    input.route_binding_id,
    input.expected_binding_generation,
    input.idempotency_key,
    input.completion_request_hash,
    input.outcome_status,
    input.evidence_ref_or_null,
    input.evidence_digest_or_null,
    input.provider_identity_digest_or_null,
    input.ownership_status_or_null,
    input.route_lifecycle_status_or_null,
  ]);
}

export function hnsRouteRevalidationResultHash(
  input: HnsRouteRevalidationResultHashInput,
): Promise<string> {
  return sha256RouteRevalidationUtf8(hnsRouteRevalidationResultPreimage(input));
}

// Descriptive aliases keep the eight authorities easy to discover at call sites.
export const hnsRouteRevalidationRequestHash = hnsRouteRevalidationStartHash;
export const hnsRouteRevalidationEvidenceDigest = hnsRouteRevalidationEvidenceHash;
export const hnsRouteRevalidationTerminalResultHash = hnsRouteRevalidationResultHash;
