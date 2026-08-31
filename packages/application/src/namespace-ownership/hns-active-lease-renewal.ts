import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Schema } from "effect";
import {
  NamespaceOwnershipRoute,
  type NamespaceOwnershipRoute as NamespaceOwnershipRouteValue,
} from "./adapter.ts";
import {
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  deriveHnsEvidenceLease,
  type HnsControlObservationRequestV1,
  type HnsEvidenceLeasePolicy,
  type HnsOwnerTargetObservationV2,
  type HnsOwnerTargetVerifiedObservationV2,
  hnsControlIdentityDigest,
  mapHnsControlObservationToTargetV2,
} from "./hns-control-observer.ts";
import {
  type HnsControlObserverRetainedSnapshotV1,
  isHnsControlObserverSnapshotReference,
} from "./hns-control-observer-store.ts";
import {
  decodeStrictHnsJsonBytes,
  HnsOwnerResponseDecodeError,
  sha256Utf8,
} from "./hns-evidence.ts";

export const HNS_ACTIVE_LEASE_RENEWAL_REQUIREMENT_VERSION =
  "pirate-hns-active-lease-renewal-requirement-v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_REQUEST_VERSION =
  "pirate-hns-active-lease-renewal-request-v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION =
  "pirate-hns-active-lease-renewal-response-v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_EVIDENCE_VERSION =
  "pirate-hns-active-lease-renewal-evidence-v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_RESULT_VERSION =
  "pirate-hns-active-lease-renewal-result-v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_RESULT_V2_VERSION =
  "pirate-hns-active-lease-renewal-result-v2" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION = "hns-active-lease-renewal-v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_ID = "hns.owner.v1" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_REQUEST_MAX_BYTES = 32_768 as const;
export const HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_MAX_BYTES = 1_048_576 as const;
// The inner observer reference is bounded at 424 bytes by hns-control-observer;
// this renewal field carries its hash-pinned outer composite, bounded at 512.
export const HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_EVIDENCE_MAX_BYTES = 512 as const;
export const HNS_ACTIVE_LEASE_RENEWAL_DIAGNOSTIC_MAX_BYTES = 512 as const;

const exactParseOptions = { onExcessProperty: "error" } as const;
const sourceValues = ["hns_parent_chain_txt", "owner_authoritative_dns_txt"] as const;
const rejectionValues = [
  "root_absent",
  "root_inactive",
  "txt_absent",
  "txt_value_mismatch",
  "expiry_horizon_insufficient",
] as const;
const unavailableValues = [
  "chain_transport_unavailable",
  "chain_unsynchronized",
  "chain_view_stale",
  "chain_view_changed",
  "chain_response_invalid",
  "authoritative_dns_timeout",
  "authoritative_dns_servfail",
  "authoritative_dns_insecure",
  "authoritative_dns_inconclusive",
  "authority_inventory_unavailable",
  "observer_capacity",
  "observer_internal_error",
] as const;

export type HnsActiveLeaseRenewalRejectionReason = (typeof rejectionValues)[number];
export type HnsActiveLeaseRenewalUnavailableReason = (typeof unavailableValues)[number];

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSafeText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function boundedString(maxBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value && isSafeText(value) && utf8Length(value) <= maxBytes
        ? undefined
        : `Expected ${label} to be a bounded canonical UTF-8 value`,
    ),
  );
}

const Identifier = boundedString(256, "identifier");
const EvidenceReference = boundedString(512, "evidence_ref");
const ConfigurationReference = boundedString(512, "provider_configuration_reference");
const ConfigurationVersion = boundedString(256, "provider_configuration_version");
const Environment = boundedString(256, "environment");
const PrincipalId = boundedString(256, "principal_id");
const RootLabel = boundedString(63, "root_label").check(
  Schema.makeFilter((value) =>
    validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
  ),
);
const RootDisplay = boundedString(255, "root_label_display");
const PathSegment = boundedString(512, "path_segment");
const ProviderEvidenceReference = boundedString(
  HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_EVIDENCE_MAX_BYTES,
  "provider_evidence_ref",
).check(
  Schema.makeFilter((value) =>
    /^hns-observer-v1:sha256:[0-9a-f]{64}:[^\s\p{Cc}]+$/u.test(value)
      ? undefined
      : "Expected a composite immutable observer evidence reference",
  ),
);
const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC ISO instant";
  }),
);
const NonNegativeSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a non-negative safe integer",
  ),
);
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);
const RetryAfterSeconds = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 && value <= 3_600
      ? undefined
      : "Expected a retry hint from 1 through 3600 seconds",
  ),
);

const ConfigurationSchema = Schema.Struct({
  kind: Schema.Literals(["managed", "dynamic"]),
  reference: ConfigurationReference,
  version: ConfigurationVersion,
  digest: Sha256Hex,
});

const HnsRouteSchema = NamespaceOwnershipRoute.check(
  Schema.makeFilter((route) =>
    route.family === "hns" && route.app_host === null
      ? undefined
      : "Expected a canonical ownership-only HNS route",
  ),
);

const PersistedControlIdentitySchema = Schema.Struct({
  ownership_source: Schema.Literals(sourceValues),
  txt_name: boundedString(255, "txt_name"),
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
});
const ResolvedControlIdentitySchema = Schema.Struct({
  ownership_source: Schema.Literals(sourceValues),
  txt_name: boundedString(255, "txt_name"),
  expected_txt_value: boundedString(16_448, "expected_txt_value"),
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
});

const RequirementSchema = Schema.Struct({
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  expected_verified_evidence_ref: EvidenceReference,
  expected_evidence_digest: Sha256Hex,
  expected_control_identity_digest: Sha256Hex,
  expected_chain_authority_digest: Sha256Hex,
  prior_provider_evidence_ref: ProviderEvidenceReference,
  principal_id: PrincipalId,
  provider_id: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration: ConfigurationSchema,
  protocol_version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION),
  environment: Environment,
  route: HnsRouteSchema,
});

const RequestSchema = Schema.Struct({
  version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_REQUEST_VERSION),
  operation_kind: Schema.Literal("active_lease_renewal"),
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  expected_verified_evidence_ref: EvidenceReference,
  expected_evidence_digest: Sha256Hex,
  expected_control_identity_digest: Sha256Hex,
  expected_chain_authority_digest: Sha256Hex,
  prior_provider_evidence_ref: ProviderEvidenceReference,
  attempt_number: PositiveSafeInteger,
  evidence_ref: EvidenceReference,
  requirement_hash: Sha256Hex,
  request_hash: Sha256Hex,
  provider_id: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration: ConfigurationSchema,
  protocol_version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION),
  environment: Environment,
  route: HnsRouteSchema,
});

const VerifiedObservationSchema = Schema.Struct({
  ownership_source: Schema.Literals(sourceValues),
  txt_name: boundedString(255, "txt_name"),
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: boundedString(256, "chain_network"),
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  observed_at: CanonicalIsoInstant,
  expires_at: CanonicalIsoInstant,
  observer_result_sha256: Sha256Hex,
  provider_evidence_ref: ProviderEvidenceReference,
});

const VerifiedResponseSchema = Schema.Struct({
  version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION),
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  request_hash: Sha256Hex,
  status: Schema.Literal("verified"),
  observation: VerifiedObservationSchema,
});

const RejectedResponseSchema = Schema.Struct({
  version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION),
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  request_hash: Sha256Hex,
  status: Schema.Literal("rejected"),
  reason_code: Schema.Literals(rejectionValues),
  provider_evidence_ref: ProviderEvidenceReference,
  observer_result_sha256: Sha256Hex,
});

const UnavailableResponseSchema = Schema.Struct({
  version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION),
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  request_hash: Sha256Hex,
  status: Schema.Literal("unavailable"),
  reason_code: Schema.Literals(unavailableValues),
  retry_after_seconds: Schema.NullOr(RetryAfterSeconds),
  diagnostic_ref: Schema.NullOr(
    boundedString(HNS_ACTIVE_LEASE_RENEWAL_DIAGNOSTIC_MAX_BYTES, "diagnostic_ref"),
  ),
});

const EvidenceSchema = Schema.Struct({
  version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_EVIDENCE_VERSION),
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  principal_kind: Schema.Literal("system"),
  principal_id: PrincipalId,
  requirement_hash: Sha256Hex,
  expected_binding_generation: PositiveSafeInteger,
  binding_generation: PositiveSafeInteger,
  expected_verified_evidence_ref: EvidenceReference,
  expected_evidence_digest: Sha256Hex,
  expected_control_identity_digest: Sha256Hex,
  expected_chain_authority_digest: Sha256Hex,
  prior_provider_evidence_ref: ProviderEvidenceReference,
  request_hash: Sha256Hex,
  provider_id: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration_kind: Schema.Literals(["managed", "dynamic"]),
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: ConfigurationVersion,
  provider_configuration_digest: Sha256Hex,
  protocol_version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION),
  environment: Environment,
  family: Schema.Literal("hns"),
  root_label: RootLabel,
  root_label_display: RootDisplay,
  path_segment: PathSegment,
  ownership_source: Schema.Literals(sourceValues),
  txt_name: boundedString(255, "txt_name"),
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: boundedString(256, "chain_network"),
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  observed_at: CanonicalIsoInstant,
  expires_at: CanonicalIsoInstant,
  evidence_ref: EvidenceReference,
  provider_evidence_ref: ProviderEvidenceReference,
  observer_result_sha256: Sha256Hex,
  provider_response_sha256: Sha256Hex,
  evidence_digest: Sha256Hex,
});

const ResultSchema = Schema.Struct({
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  idempotency_key: Identifier,
  request_hash: Sha256Hex,
  outcome_status: Schema.Literals([
    "verified",
    "root_absent",
    "root_inactive",
    "txt_absent",
    "txt_value_mismatch",
    "control_identity_changed",
    "chain_authority_changed",
    "expiry_horizon_insufficient",
    "lease_expired_before_commit",
    "stale_cas",
  ]),
  evidence_ref_or_null: Schema.NullOr(EvidenceReference),
  evidence_digest_or_null: Schema.NullOr(Sha256Hex),
  provider_response_sha256_or_null: Schema.NullOr(Sha256Hex),
  ownership_status_or_null: Schema.NullOr(
    Schema.Literals(["verified", "revoked", "disputed", "expired"]),
  ),
  route_lifecycle_status_or_null: Schema.NullOr(Schema.Literals(["active", "suspended"])),
});

const ResultV2Schema = Schema.Struct({
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  idempotency_key: Identifier,
  request_hash: Sha256Hex,
  outcome_status: Schema.Literals([
    "verified",
    "root_absent",
    "root_inactive",
    "txt_absent",
    "txt_value_mismatch",
    "control_identity_changed",
    "chain_authority_changed",
    "expiry_horizon_insufficient",
    "renewal_evidence_ineligible",
    "lease_expired_before_commit",
    "stale_cas",
  ]),
  evidence_ref_or_null: Schema.NullOr(EvidenceReference),
  evidence_digest_or_null: Schema.NullOr(Sha256Hex),
  provider_response_sha256_or_null: Schema.NullOr(Sha256Hex),
  ownership_status_or_null: Schema.NullOr(
    Schema.Literals(["verified", "revoked", "disputed", "expired"]),
  ),
  route_lifecycle_status_or_null: Schema.NullOr(Schema.Literals(["active", "suspended"])),
});

function assertResultMatrix(value: Schema.Schema.Type<typeof ResultSchema>): void {
  if (value.outcome_status === "verified") {
    if (
      value.evidence_ref_or_null === null ||
      value.evidence_digest_or_null === null ||
      value.provider_response_sha256_or_null === null ||
      value.ownership_status_or_null !== "verified" ||
      value.route_lifecycle_status_or_null !== "active"
    ) {
      throw new TypeError("Verified renewal result must carry verified evidence and status");
    }
    return;
  }
  const semanticNegative = new Set([
    "root_absent",
    "root_inactive",
    "txt_absent",
    "txt_value_mismatch",
    "control_identity_changed",
    "chain_authority_changed",
    "expiry_horizon_insufficient",
  ]);
  if (semanticNegative.has(value.outcome_status)) {
    const expectedStatus =
      value.outcome_status === "root_absent" || value.outcome_status === "root_inactive"
        ? "revoked"
        : value.outcome_status === "expiry_horizon_insufficient"
          ? "expired"
          : "disputed";
    if (
      value.evidence_ref_or_null !== null ||
      value.evidence_digest_or_null !== null ||
      value.provider_response_sha256_or_null === null ||
      value.ownership_status_or_null !== expectedStatus ||
      value.route_lifecycle_status_or_null !== "suspended"
    ) {
      throw new TypeError("Semantic negative renewal result has an invalid status matrix");
    }
    return;
  }
  if (
    value.evidence_ref_or_null !== null ||
    value.evidence_digest_or_null !== null ||
    value.ownership_status_or_null !== null ||
    value.route_lifecycle_status_or_null !== null
  ) {
    throw new TypeError("Local renewal result must not carry evidence or lifecycle status");
  }
}

function assertResultV2Matrix(value: Schema.Schema.Type<typeof ResultV2Schema>): void {
  if (value.outcome_status === "renewal_evidence_ineligible") {
    if (
      value.evidence_ref_or_null !== null ||
      value.evidence_digest_or_null !== null ||
      value.provider_response_sha256_or_null !== null ||
      value.ownership_status_or_null !== null ||
      value.route_lifecycle_status_or_null !== null
    ) {
      throw new TypeError("Ineligible renewal result must not carry mutation authority");
    }
    return;
  }
  assertResultMatrix(
    decodeSchema(ResultSchema, value, "HNS active-renewal result-v2 matrix is invalid"),
  );
}

export type HnsActiveLeaseRenewalAuthorityV1 = Schema.Schema.Type<typeof RequirementSchema>;
export type HnsActiveLeaseRenewalProviderConfiguration = Schema.Schema.Type<
  typeof ConfigurationSchema
>;
export type HnsActiveLeaseRenewalRoute = Extract<
  NamespaceOwnershipRouteValue,
  { readonly family: "hns" }
>;
export type HnsOwnerActiveLeaseRenewalRequestV1 = Schema.Schema.Type<typeof RequestSchema>;
export type HnsOwnerActiveLeaseRenewalVerifiedObservationV1 = Schema.Schema.Type<
  typeof VerifiedObservationSchema
>;
export type HnsOwnerActiveLeaseRenewalResponseVerifiedV1 = Schema.Schema.Type<
  typeof VerifiedResponseSchema
>;
export type HnsOwnerActiveLeaseRenewalResponseRejectedV1 = Schema.Schema.Type<
  typeof RejectedResponseSchema
>;
export type HnsOwnerActiveLeaseRenewalResponseUnavailableV1 = Schema.Schema.Type<
  typeof UnavailableResponseSchema
>;
export type HnsOwnerActiveLeaseRenewalResponseV1 =
  | HnsOwnerActiveLeaseRenewalResponseVerifiedV1
  | HnsOwnerActiveLeaseRenewalResponseRejectedV1
  | HnsOwnerActiveLeaseRenewalResponseUnavailableV1;

export type HnsActiveLeaseRenewalPersistedControlIdentityV1 = Readonly<{
  readonly ownership_source: (typeof sourceValues)[number];
  readonly txt_name: string;
  readonly expected_txt_value_sha256: Sha256HexValue;
  readonly control_identity_digest: Sha256HexValue;
  readonly chain_authority_digest: Sha256HexValue;
}>;

export type HnsActiveLeaseRenewalResolvedControlIdentityV1 =
  HnsActiveLeaseRenewalPersistedControlIdentityV1 &
    Readonly<{
      readonly expected_txt_value: string;
    }>;

export type HnsActiveLeaseRenewalDecodedRequest = Readonly<{
  readonly request_bytes: Uint8Array;
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly request_sha256: Sha256HexValue;
}>;

export type HnsActiveLeaseRenewalDecodedResponse = Readonly<{
  readonly response_bytes: Uint8Array;
  readonly response: HnsOwnerActiveLeaseRenewalResponseV1;
  readonly response_sha256: Sha256HexValue;
}>;

export type HnsActiveLeaseRenewalPriorSnapshotInput = Readonly<{
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly snapshot: HnsControlObserverRetainedSnapshotV1;
}>;

export type HnsActiveLeaseRenewalResponseValidationContext = Readonly<{
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly authority: HnsActiveLeaseRenewalAuthorityV1;
  readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
  readonly policy: HnsEvidenceLeasePolicy;
}>;

export class HnsActiveLeaseRenewalDecodeError extends HnsOwnerResponseDecodeError {
  constructor(message: string) {
    super(message);
    this.name = "HnsActiveLeaseRenewalDecodeError";
  }
}

function decodeSchema<T>(schema: Schema.ConstraintDecoder<T>, value: unknown, message: string): T {
  const decoded = Schema.decodeUnknownOption(schema, exactParseOptions)(value);
  if (Option.isNone(decoded)) throw new HnsActiveLeaseRenewalDecodeError(message);
  return decoded.value;
}

function assertObjectOrder(value: unknown, expected: ReadonlyArray<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS renewal JSON must be an object");
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS renewal JSON members are reordered");
  }
}

const configKeys = ["kind", "reference", "version", "digest"] as const;
const routeKeys = [
  "family",
  "root_label",
  "root_label_display",
  "path_segment",
  "href",
  "app_host",
] as const;
const requestKeys = [
  "version",
  "operation_kind",
  "active_lease_renewal_id",
  "active_lease_renewal_attempt_id",
  "community_id",
  "route_binding_id",
  "expected_binding_generation",
  "expected_verified_evidence_ref",
  "expected_evidence_digest",
  "expected_control_identity_digest",
  "expected_chain_authority_digest",
  "prior_provider_evidence_ref",
  "attempt_number",
  "evidence_ref",
  "requirement_hash",
  "request_hash",
  "provider_id",
  "provider_binding_hash",
  "provider_configuration",
  "protocol_version",
  "environment",
  "route",
] as const;
const responseKeys = [
  "version",
  "active_lease_renewal_id",
  "active_lease_renewal_attempt_id",
  "request_hash",
  "status",
] as const;
const verifiedObservationKeys = [
  "ownership_source",
  "txt_name",
  "expected_txt_value_sha256",
  "control_identity_digest",
  "chain_authority_digest",
  "root_exists",
  "root_control_verified",
  "expiry_horizon_sufficient",
  "chain_network",
  "chain_anchor_height",
  "chain_anchor_block_hash",
  "chain_anchor_median_time",
  "expiry_height",
  "observed_at",
  "expires_at",
  "observer_result_sha256",
  "provider_evidence_ref",
] as const;
const rejectedKeys = [
  ...responseKeys,
  "reason_code",
  "provider_evidence_ref",
  "observer_result_sha256",
];
const unavailableKeys = [...responseKeys, "reason_code", "retry_after_seconds", "diagnostic_ref"];

function assertNestedRequestOrder(value: HnsOwnerActiveLeaseRenewalRequestV1): void {
  assertObjectOrder(value.provider_configuration, configKeys);
  assertObjectOrder(value.route, routeKeys);
  if (value.route.href !== `/c/${value.route.path_segment}`) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS renewal route href is not canonical");
  }
}

function assertRoute(route: NamespaceOwnershipRouteValue): void {
  const decoded = decodeSchema(HnsRouteSchema, route, "HNS active renewal route is not canonical");
  if (decoded.href !== `/c/${decoded.path_segment}` || decoded.app_host !== null) {
    throw new TypeError("HNS active renewal route must be canonical and ownership-only");
  }
}

function orderedJson(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function assertAuthority(value: HnsActiveLeaseRenewalAuthorityV1): void {
  decodeSchema(RequirementSchema, value, "HNS active-renewal authority failed its strict schema");
  assertRoute(value.route);
}

function assertRequest(value: HnsOwnerActiveLeaseRenewalRequestV1): void {
  decodeSchema(RequestSchema, value, "HNS active-renewal request failed its strict schema");
  assertRoute(value.route);
}

function sha256Bytes(value: Uint8Array): Promise<Sha256HexValue> {
  return crypto.subtle.digest("SHA-256", new Uint8Array(value)).then((digest) => {
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return Schema.decodeUnknownSync(Sha256Hex)(hex);
  });
}

export function hnsActiveLeaseRenewalRequirementPreimage(
  input: HnsActiveLeaseRenewalAuthorityV1,
): string {
  assertAuthority(input);
  return orderedJson([
    HNS_ACTIVE_LEASE_RENEWAL_REQUIREMENT_VERSION,
    input.community_id,
    input.route_binding_id,
    input.expected_binding_generation,
    input.expected_verified_evidence_ref,
    input.expected_evidence_digest,
    input.expected_control_identity_digest,
    input.expected_chain_authority_digest,
    input.prior_provider_evidence_ref,
    "system",
    input.principal_id,
    input.provider_id,
    input.provider_binding_hash,
    input.provider_configuration.kind,
    input.provider_configuration.reference,
    input.provider_configuration.version,
    input.provider_configuration.digest,
    HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION,
    input.environment,
    "hns",
    input.route.root_label,
    input.route.root_label_display,
    input.route.path_segment,
  ]);
}

export function hnsActiveLeaseRenewalRequirementHash(
  input: HnsActiveLeaseRenewalAuthorityV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsActiveLeaseRenewalRequirementPreimage(input));
}

function requestHashValues(input: HnsOwnerActiveLeaseRenewalRequestV1): readonly unknown[] {
  return [
    HNS_ACTIVE_LEASE_RENEWAL_REQUEST_VERSION,
    input.active_lease_renewal_id,
    input.active_lease_renewal_attempt_id,
    input.community_id,
    input.route_binding_id,
    input.expected_binding_generation,
    input.expected_verified_evidence_ref,
    input.expected_evidence_digest,
    input.expected_control_identity_digest,
    input.expected_chain_authority_digest,
    input.prior_provider_evidence_ref,
    input.attempt_number,
    input.evidence_ref,
    input.requirement_hash,
    input.provider_id,
    input.provider_binding_hash,
    input.provider_configuration.kind,
    input.provider_configuration.reference,
    input.provider_configuration.version,
    input.provider_configuration.digest,
    HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION,
    input.environment,
    "hns",
    input.route.root_label,
    input.route.root_label_display,
    input.route.path_segment,
  ];
}

export function hnsActiveLeaseRenewalRequestPreimage(
  input: HnsOwnerActiveLeaseRenewalRequestV1,
): string {
  assertRequest(input);
  return orderedJson(requestHashValues(input));
}

export function hnsActiveLeaseRenewalRequestHash(
  input: HnsOwnerActiveLeaseRenewalRequestV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsActiveLeaseRenewalRequestPreimage(input));
}

function assertRequestMatchesAuthority(
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  authority: HnsActiveLeaseRenewalAuthorityV1,
  requirementHash: Sha256HexValue,
): void {
  if (
    request.requirement_hash !== requirementHash ||
    request.community_id !== authority.community_id ||
    request.route_binding_id !== authority.route_binding_id ||
    request.expected_binding_generation !== authority.expected_binding_generation ||
    request.expected_verified_evidence_ref !== authority.expected_verified_evidence_ref ||
    request.expected_evidence_digest !== authority.expected_evidence_digest ||
    request.expected_control_identity_digest !== authority.expected_control_identity_digest ||
    request.expected_chain_authority_digest !== authority.expected_chain_authority_digest ||
    request.prior_provider_evidence_ref !== authority.prior_provider_evidence_ref ||
    request.provider_id !== authority.provider_id ||
    request.provider_binding_hash !== authority.provider_binding_hash ||
    request.provider_configuration.kind !== authority.provider_configuration.kind ||
    request.provider_configuration.reference !== authority.provider_configuration.reference ||
    request.provider_configuration.version !== authority.provider_configuration.version ||
    request.provider_configuration.digest !== authority.provider_configuration.digest ||
    request.protocol_version !== authority.protocol_version ||
    request.environment !== authority.environment ||
    request.route.root_label !== authority.route.root_label ||
    request.route.root_label_display !== authority.route.root_label_display ||
    request.route.path_segment !== authority.route.path_segment ||
    request.route.href !== authority.route.href
  ) {
    throw new TypeError("HNS active-renewal request does not match locked authority");
  }
}

export async function encodeHnsActiveLeaseRenewalRequest(
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  authority: HnsActiveLeaseRenewalAuthorityV1,
): Promise<Uint8Array> {
  assertRequest(request);
  assertAuthority(authority);
  const requirementHash = await hnsActiveLeaseRenewalRequirementHash(authority);
  assertRequestMatchesAuthority(request, authority, requirementHash);
  const requestHash = await hnsActiveLeaseRenewalRequestHash(request);
  if (request.request_hash !== requestHash) {
    throw new TypeError("HNS active-renewal request hash is not self-consistent");
  }
  assertObjectOrder(request, requestKeys);
  assertNestedRequestOrder(request);
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  if (bytes.byteLength > HNS_ACTIVE_LEASE_RENEWAL_REQUEST_MAX_BYTES) {
    throw new TypeError("HNS active-renewal request exceeds the byte bound");
  }
  return bytes;
}

export async function decodeHnsActiveLeaseRenewalRequestBytes(
  value: unknown,
): Promise<HnsActiveLeaseRenewalDecodedRequest> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS active-renewal request has invalid bytes");
  }
  const bytes = new Uint8Array(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(bytes, HNS_ACTIVE_LEASE_RENEWAL_REQUEST_MAX_BYTES);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsActiveLeaseRenewalDecodeError(error.message);
    }
    throw error;
  }
  assertObjectOrder(json, requestKeys);
  const request = decodeSchema(RequestSchema, json, "HNS active-renewal request failed its schema");
  assertNestedRequestOrder(request);
  const request_sha256 = await hnsActiveLeaseRenewalRequestHash(request);
  if (request.request_hash !== request_sha256) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS active-renewal request hash mismatch");
  }
  return { request_bytes: bytes, request, request_sha256 };
}

function providerEvidenceCrossPin(
  providerEvidenceRef: string,
  observerResultSha256: Sha256HexValue,
): void {
  decodeSchema(
    ProviderEvidenceReference,
    providerEvidenceRef,
    "HNS renewal provider evidence reference is not canonical",
  );
  const prefix = `hns-observer-v1:sha256:${observerResultSha256}:`;
  if (!providerEvidenceRef.startsWith(prefix)) {
    throw new TypeError("HNS renewal provider evidence reference does not cross-pin the result");
  }
}

export function hnsActiveLeaseRenewalPriorSnapshotReference(providerEvidenceRef: string): Readonly<{
  readonly observer_result_sha256: Sha256HexValue;
  readonly snapshot_reference: string;
}> {
  const match = /^hns-observer-v1:sha256:([0-9a-f]{64}):(.+)$/u.exec(providerEvidenceRef);
  const observerResultSha256 = match?.[1];
  const snapshotReference = match?.[2];
  if (
    observerResultSha256 === undefined ||
    snapshotReference === undefined ||
    !isHnsControlObserverSnapshotReference(snapshotReference)
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal prior provider evidence reference is invalid",
    );
  }
  return {
    observer_result_sha256: Schema.decodeUnknownSync(Sha256Hex)(observerResultSha256),
    snapshot_reference: snapshotReference,
  };
}

export async function resolveHnsActiveLeaseRenewalControlIdentity(
  input: HnsActiveLeaseRenewalPriorSnapshotInput,
): Promise<HnsActiveLeaseRenewalResolvedControlIdentityV1> {
  assertRequest(input.request);
  if ((await hnsActiveLeaseRenewalRequestHash(input.request)) !== input.request.request_hash) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS renewal request hash is not self-consistent");
  }
  const reference = hnsActiveLeaseRenewalPriorSnapshotReference(
    input.request.prior_provider_evidence_ref,
  );
  if (
    input.snapshot.snapshot_reference !== reference.snapshot_reference ||
    input.snapshot.result_sha256 !== reference.observer_result_sha256
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal prior snapshot does not match its provider evidence reference",
    );
  }
  const priorRequest = await decodeHnsControlObservationRequestBytes(input.snapshot.request_bytes);
  const priorResult = await decodeHnsControlObservationResultBytes(
    input.snapshot.result_bytes,
    priorRequest.request,
  );
  if (
    priorResult.result_sha256 !== input.snapshot.result_sha256 ||
    priorResult.result.status !== "verified" ||
    priorResult.result.provider_evidence_ref !== input.snapshot.snapshot_reference
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal prior snapshot is not immutable verified evidence",
    );
  }
  const request = priorRequest.request;
  const result = priorResult.result;
  if (
    request.provider_id !== input.request.provider_id ||
    request.provider_configuration_reference !== input.request.provider_configuration.reference ||
    request.provider_configuration_version !== input.request.provider_configuration.version ||
    request.provider_configuration_digest !== input.request.provider_configuration.digest ||
    request.environment !== input.request.environment ||
    request.root_label !== input.request.route.root_label ||
    !request.expected_txt_value.startsWith("pirate-verification=") ||
    request.expected_txt_value.length === "pirate-verification=".length
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal prior snapshot does not match request configuration authority",
    );
  }
  if (
    result.control_identity_digest !== input.request.expected_control_identity_digest ||
    result.chain_authority_digest !== input.request.expected_chain_authority_digest
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal prior snapshot disagrees with expected control authority",
    );
  }
  return {
    ownership_source: request.ownership_source,
    txt_name: request.txt_name,
    expected_txt_value: request.expected_txt_value,
    expected_txt_value_sha256: result.expected_txt_value_sha256,
    control_identity_digest: result.control_identity_digest,
    chain_authority_digest: result.chain_authority_digest,
  };
}

function assertVerifiedObservation(
  observation: HnsOwnerTargetVerifiedObservationV2,
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  identity: HnsActiveLeaseRenewalResolvedControlIdentityV1,
): void {
  if (observation.observation_contract_version !== "pirate-hns-target-observation-v2") {
    throw new TypeError("HNS renewal requires target-observer v2 provenance");
  }
  if (
    observation.ownership_source !== identity.ownership_source ||
    observation.challenge_name !== identity.txt_name ||
    observation.challenge_value !== identity.expected_txt_value ||
    observation.expected_txt_value_sha256 !== identity.expected_txt_value_sha256
  ) {
    throw new TypeError("HNS target observation does not match persisted control identity");
  }
  providerEvidenceCrossPin(observation.provider_evidence_ref, observation.observer_result_sha256);
  if (observation.provider_evidence_ref === request.prior_provider_evidence_ref) {
    throw new TypeError("HNS renewal must persist a new provider evidence reference");
  }
}

function assertControlIdentity(
  identity: HnsActiveLeaseRenewalResolvedControlIdentityV1,
  request: HnsOwnerActiveLeaseRenewalRequestV1,
): Promise<void> {
  decodeSchema(
    ResolvedControlIdentitySchema,
    identity,
    "Resolved HNS control identity is not strict",
  );
  const expectedTxt = sha256Utf8(identity.expected_txt_value);
  return expectedTxt.then(async (expectedTxtValueSha256) => {
    if (identity.expected_txt_value_sha256 !== expectedTxtValueSha256) {
      throw new TypeError("Persisted HNS control identity TXT hash is not recomputable");
    }
    const expectedControlDigest = await hnsControlIdentityDigest({
      ownership_source: identity.ownership_source,
      txt_name: identity.txt_name,
      expected_txt_value: identity.expected_txt_value,
      root_label: request.route.root_label,
      chain_authority_digest: identity.chain_authority_digest,
    });
    if (identity.control_identity_digest !== expectedControlDigest) {
      throw new TypeError("Persisted HNS control identity digest is not recomputable");
    }
    if (identity.control_identity_digest !== request.expected_control_identity_digest) {
      throw new TypeError("Persisted HNS control identity does not match renewal authority");
    }
    if (identity.chain_authority_digest !== request.expected_chain_authority_digest) {
      throw new TypeError("Persisted HNS chain authority does not match renewal authority");
    }
  });
}

export type HnsActiveLeaseRenewalObservationInput = Readonly<{
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly authority: HnsActiveLeaseRenewalAuthorityV1;
  readonly control_identity: HnsActiveLeaseRenewalResolvedControlIdentityV1;
  readonly observer_request: HnsControlObservationRequestV1;
  readonly observer_result_bytes: Uint8Array;
  readonly upstream_session_ref: string;
  readonly policy: HnsEvidenceLeasePolicy;
}>;

export async function mapHnsActiveLeaseRenewalObservation(
  input: HnsActiveLeaseRenewalObservationInput,
): Promise<HnsOwnerActiveLeaseRenewalResponseV1> {
  assertRequest(input.request);
  assertAuthority(input.authority);
  assertRoute(input.request.route);
  const requirementHash = await hnsActiveLeaseRenewalRequirementHash(input.authority);
  assertRequestMatchesAuthority(input.request, input.authority, requirementHash);
  const requestHash = await hnsActiveLeaseRenewalRequestHash(input.request);
  if (input.request.request_hash !== requestHash) {
    throw new TypeError("HNS active-renewal request hash is not self-consistent");
  }
  return mapHnsActiveLeaseRenewalObservationForRequest(input);
}

export async function mapHnsActiveLeaseRenewalObservationForRequest(
  input: Omit<HnsActiveLeaseRenewalObservationInput, "authority">,
): Promise<HnsOwnerActiveLeaseRenewalResponseV1> {
  assertRequest(input.request);
  assertRoute(input.request.route);
  const requestHash = await hnsActiveLeaseRenewalRequestHash(input.request);
  if (input.request.request_hash !== requestHash) {
    throw new TypeError("HNS active-renewal request hash is not self-consistent");
  }
  await assertControlIdentity(input.control_identity, input.request);
  if (
    input.observer_request.provider_id !== input.request.provider_id ||
    input.observer_request.provider_configuration_reference !==
      input.request.provider_configuration.reference ||
    input.observer_request.provider_configuration_version !==
      input.request.provider_configuration.version ||
    input.observer_request.provider_configuration_digest !==
      input.request.provider_configuration.digest ||
    input.observer_request.environment !== input.request.environment ||
    input.observer_request.root_label !== input.request.route.root_label ||
    input.observer_request.ownership_source !== input.control_identity.ownership_source ||
    input.observer_request.txt_name !== input.control_identity.txt_name ||
    input.observer_request.expected_txt_value !== input.control_identity.expected_txt_value
  ) {
    throw new TypeError("HNS observer request does not match the full renewal authority");
  }
  const targetObservation = await mapHnsControlObservationToTargetV2({
    request: input.observer_request,
    result_bytes: input.observer_result_bytes,
    upstream_session_ref: input.upstream_session_ref,
    policy: input.policy,
  });
  return mapTargetObservationToHnsActiveLeaseRenewalResponse(
    input.request,
    targetObservation,
    input.control_identity,
  );
}

function mapTargetObservationToHnsActiveLeaseRenewalResponse(
  request: HnsOwnerActiveLeaseRenewalRequestV1,
  observation: HnsOwnerTargetObservationV2,
  identity: HnsActiveLeaseRenewalResolvedControlIdentityV1,
): HnsOwnerActiveLeaseRenewalResponseV1 {
  assertRequest(request);
  if (observation.observation_contract_version !== "pirate-hns-target-observation-v2") {
    throw new TypeError("HNS renewal requires target-observer v2 provenance");
  }
  if (observation.status === "unavailable") {
    return {
      version: HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION,
      active_lease_renewal_id: request.active_lease_renewal_id,
      active_lease_renewal_attempt_id: request.active_lease_renewal_attempt_id,
      request_hash: request.request_hash,
      status: "unavailable",
      reason_code: observation.reason_code,
      retry_after_seconds: observation.retry_after_seconds,
      diagnostic_ref: observation.diagnostic_ref,
    };
  }
  providerEvidenceCrossPin(observation.provider_evidence_ref, observation.observer_result_sha256);
  if (observation.provider_evidence_ref === request.prior_provider_evidence_ref) {
    throw new TypeError("HNS renewal must not reuse prior provider evidence");
  }
  if (observation.status === "verified") {
    assertVerifiedObservation(observation, request, identity);
    return {
      version: HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION,
      active_lease_renewal_id: request.active_lease_renewal_id,
      active_lease_renewal_attempt_id: request.active_lease_renewal_attempt_id,
      request_hash: request.request_hash,
      status: "verified",
      observation: {
        ownership_source: observation.ownership_source,
        txt_name: observation.challenge_name,
        expected_txt_value_sha256: observation.expected_txt_value_sha256,
        control_identity_digest: observation.control_identity_digest,
        chain_authority_digest: observation.chain_authority_digest,
        root_exists: true,
        root_control_verified: true,
        expiry_horizon_sufficient: true,
        chain_network: observation.chain_network,
        chain_anchor_height: observation.chain_anchor_height,
        chain_anchor_block_hash: observation.chain_anchor_block_hash,
        chain_anchor_median_time: observation.chain_anchor_median_time,
        expiry_height: observation.expiry_height,
        observed_at: observation.observed_at,
        expires_at: observation.expires_at,
        observer_result_sha256: observation.observer_result_sha256,
        provider_evidence_ref: observation.provider_evidence_ref,
      },
    };
  }
  return {
    version: HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_VERSION,
    active_lease_renewal_id: request.active_lease_renewal_id,
    active_lease_renewal_attempt_id: request.active_lease_renewal_attempt_id,
    request_hash: request.request_hash,
    status: "rejected",
    reason_code: observation.reason_code,
    provider_evidence_ref: observation.provider_evidence_ref,
    observer_result_sha256: observation.observer_result_sha256,
  };
}

function responseKeysFor(value: unknown): ReadonlyArray<string> {
  const status =
    value !== null && typeof value === "object" && !Array.isArray(value) && "status" in value
      ? (value as { readonly status?: unknown }).status
      : undefined;
  if (status === "verified") return [...responseKeys, "observation"];
  if (status === "rejected") return rejectedKeys;
  return unavailableKeys;
}

function assertResponse(value: HnsOwnerActiveLeaseRenewalResponseV1): void {
  const response =
    value.status === "verified"
      ? decodeSchema(
          VerifiedResponseSchema,
          value,
          "HNS renewal verified response failed its schema",
        )
      : value.status === "rejected"
        ? decodeSchema(
            RejectedResponseSchema,
            value,
            "HNS renewal rejected response failed its schema",
          )
        : decodeSchema(
            UnavailableResponseSchema,
            value,
            "HNS renewal unavailable response failed its schema",
          );
  assertObjectOrder(response, responseKeysFor(response));
  if (response.status === "verified") {
    assertObjectOrder(response.observation, verifiedObservationKeys);
    if (
      Date.parse(response.observation.expires_at) <= Date.parse(response.observation.observed_at)
    ) {
      throw new TypeError("HNS renewal observation must expire after observation");
    }
    providerEvidenceCrossPin(
      response.observation.provider_evidence_ref,
      response.observation.observer_result_sha256,
    );
  } else if (response.status === "rejected") {
    providerEvidenceCrossPin(response.provider_evidence_ref, response.observer_result_sha256);
  }
}

export function encodeHnsActiveLeaseRenewalResponse(
  response: HnsOwnerActiveLeaseRenewalResponseV1,
): Uint8Array {
  assertResponse(response);
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  if (bytes.byteLength > HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_MAX_BYTES) {
    throw new TypeError("HNS active-renewal response exceeds the byte bound");
  }
  return bytes;
}

async function assertResponseValidationContext(
  response: HnsOwnerActiveLeaseRenewalResponseV1,
  context: HnsActiveLeaseRenewalResponseValidationContext,
): Promise<void> {
  decodeSchema(
    PersistedControlIdentitySchema,
    context.control_identity,
    "Persisted HNS control identity is not strict",
  );
  assertRequest(context.request);
  assertAuthority(context.authority);
  const requirementHash = await hnsActiveLeaseRenewalRequirementHash(context.authority);
  assertRequestMatchesAuthority(context.request, context.authority, requirementHash);
  const requestHash = await hnsActiveLeaseRenewalRequestHash(context.request);
  if (context.request.request_hash !== requestHash) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS renewal request hash is not self-consistent");
  }
  const expectedTxtName =
    context.control_identity.ownership_source === "hns_parent_chain_txt"
      ? context.request.route.root_label
      : `_pirate.${context.request.route.root_label}`;
  if (
    context.control_identity.control_identity_digest !==
      context.request.expected_control_identity_digest ||
    context.control_identity.chain_authority_digest !==
      context.request.expected_chain_authority_digest ||
    context.control_identity.txt_name !== expectedTxtName
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "Persisted HNS control identity does not match renewal request authority",
    );
  }
  if (
    response.active_lease_renewal_id !== context.request.active_lease_renewal_id ||
    response.active_lease_renewal_attempt_id !== context.request.active_lease_renewal_attempt_id ||
    response.request_hash !== context.request.request_hash
  ) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal response does not echo request authority",
    );
  }
  if (response.status === "unavailable") return;
  providerEvidenceCrossPin(
    response.status === "verified"
      ? response.observation.provider_evidence_ref
      : response.provider_evidence_ref,
    response.status === "verified"
      ? response.observation.observer_result_sha256
      : response.observer_result_sha256,
  );
  const providerEvidenceRef =
    response.status === "verified"
      ? response.observation.provider_evidence_ref
      : response.provider_evidence_ref;
  if (providerEvidenceRef === context.request.prior_provider_evidence_ref) {
    throw new HnsActiveLeaseRenewalDecodeError(
      "HNS renewal response reuses prior provider evidence",
    );
  }
  if (response.status === "verified") {
    if (
      response.observation.ownership_source !== context.control_identity.ownership_source ||
      response.observation.txt_name !== context.control_identity.txt_name ||
      response.observation.expected_txt_value_sha256 !==
        context.control_identity.expected_txt_value_sha256
    ) {
      throw new HnsActiveLeaseRenewalDecodeError(
        "HNS renewal response source/name/TXT hash disagrees with persisted identity",
      );
    }
    const lease = deriveHnsEvidenceLease(response.observation, context.policy);
    if (
      response.observation.observed_at !== lease.observed_at ||
      response.observation.expires_at !== lease.expires_at
    ) {
      throw new HnsActiveLeaseRenewalDecodeError(
        "HNS renewal response lease timestamps are not chain-derived",
      );
    }
  }
}

export async function decodeHnsActiveLeaseRenewalResponseBytes(
  value: unknown,
  context: HnsActiveLeaseRenewalResponseValidationContext,
): Promise<HnsActiveLeaseRenewalDecodedResponse> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new HnsActiveLeaseRenewalDecodeError("HNS active-renewal response has invalid bytes");
  }
  const bytes = new Uint8Array(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(bytes, HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_MAX_BYTES);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsActiveLeaseRenewalDecodeError(error.message);
    }
    throw error;
  }
  assertObjectOrder(json, responseKeysFor(json));
  const status = (json as { readonly status?: unknown }).status;
  const response =
    status === "verified"
      ? decodeSchema(
          VerifiedResponseSchema,
          json,
          "HNS renewal verified response failed its schema",
        )
      : status === "rejected"
        ? decodeSchema(
            RejectedResponseSchema,
            json,
            "HNS renewal rejected response failed its schema",
          )
        : decodeSchema(
            UnavailableResponseSchema,
            json,
            "HNS renewal unavailable response failed its schema",
          );
  assertResponse(response);
  await assertResponseValidationContext(response, context);
  return { response_bytes: bytes, response, response_sha256: await sha256Bytes(bytes) };
}

export type HnsActiveLeaseRenewalEvidenceEnvelopeV1 = Readonly<{
  readonly version: typeof HNS_ACTIVE_LEASE_RENEWAL_EVIDENCE_VERSION;
  readonly active_lease_renewal_id: string;
  readonly active_lease_renewal_attempt_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly principal_kind: "system";
  readonly principal_id: string;
  readonly requirement_hash: Sha256HexValue;
  readonly expected_binding_generation: number;
  readonly binding_generation: number;
  readonly expected_verified_evidence_ref: string;
  readonly expected_evidence_digest: Sha256HexValue;
  readonly expected_control_identity_digest: Sha256HexValue;
  readonly expected_chain_authority_digest: Sha256HexValue;
  readonly prior_provider_evidence_ref: string;
  readonly request_hash: Sha256HexValue;
  readonly provider_id: typeof HNS_ACTIVE_LEASE_RENEWAL_PROVIDER_ID;
  readonly provider_binding_hash: Sha256HexValue;
  readonly provider_configuration_kind: "managed" | "dynamic";
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly protocol_version: typeof HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION;
  readonly environment: string;
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly ownership_source: (typeof sourceValues)[number];
  readonly txt_name: string;
  readonly expected_txt_value_sha256: Sha256HexValue;
  readonly control_identity_digest: Sha256HexValue;
  readonly chain_authority_digest: Sha256HexValue;
  readonly root_exists: true;
  readonly root_control_verified: true;
  readonly expiry_horizon_sufficient: true;
  readonly chain_network: string;
  readonly chain_anchor_height: number;
  readonly chain_anchor_block_hash: Sha256HexValue;
  readonly chain_anchor_median_time: number;
  readonly expiry_height: number;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly evidence_ref: string;
  readonly provider_evidence_ref: string;
  readonly observer_result_sha256: Sha256HexValue;
  readonly provider_response_sha256: Sha256HexValue;
  readonly evidence_digest: Sha256HexValue;
}>;

function evidenceValues(value: HnsActiveLeaseRenewalEvidenceEnvelopeV1): readonly unknown[] {
  return [
    HNS_ACTIVE_LEASE_RENEWAL_EVIDENCE_VERSION,
    value.active_lease_renewal_id,
    value.active_lease_renewal_attempt_id,
    value.community_id,
    value.route_binding_id,
    "system",
    value.principal_id,
    value.requirement_hash,
    value.expected_binding_generation,
    value.binding_generation,
    value.expected_verified_evidence_ref,
    value.expected_evidence_digest,
    value.expected_control_identity_digest,
    value.expected_chain_authority_digest,
    value.prior_provider_evidence_ref,
    value.request_hash,
    value.provider_id,
    value.provider_binding_hash,
    value.provider_configuration_kind,
    value.provider_configuration_reference,
    value.provider_configuration_version,
    value.provider_configuration_digest,
    HNS_ACTIVE_LEASE_RENEWAL_PROTOCOL_VERSION,
    value.environment,
    "hns",
    value.root_label,
    value.root_label_display,
    value.path_segment,
    value.ownership_source,
    value.txt_name,
    value.expected_txt_value_sha256,
    value.control_identity_digest,
    value.chain_authority_digest,
    true,
    true,
    true,
    value.chain_network,
    value.chain_anchor_height,
    value.chain_anchor_block_hash,
    value.chain_anchor_median_time,
    value.expiry_height,
    value.observed_at,
    value.expires_at,
    value.evidence_ref,
    value.provider_evidence_ref,
    value.observer_result_sha256,
    value.provider_response_sha256,
  ];
}

export function hnsActiveLeaseRenewalEvidencePreimage(
  value: HnsActiveLeaseRenewalEvidenceEnvelopeV1,
): string {
  const decoded = decodeSchema(
    EvidenceSchema,
    value,
    "HNS active-renewal evidence failed its strict schema",
  );
  if (
    decoded.binding_generation !== decoded.expected_binding_generation + 1 ||
    Date.parse(decoded.expires_at) <= Date.parse(decoded.observed_at)
  ) {
    throw new TypeError("Invalid HNS active-renewal evidence envelope");
  }
  return orderedJson(evidenceValues(decoded));
}

export function hnsActiveLeaseRenewalEvidenceHash(
  value: HnsActiveLeaseRenewalEvidenceEnvelopeV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsActiveLeaseRenewalEvidencePreimage(value));
}

export type HnsActiveLeaseRenewalEvidenceBuildInput = Readonly<{
  readonly request: HnsOwnerActiveLeaseRenewalRequestV1;
  readonly authority: HnsActiveLeaseRenewalAuthorityV1;
  readonly control_identity: HnsActiveLeaseRenewalPersistedControlIdentityV1;
  readonly principal_id: string;
  readonly binding_generation: number;
  readonly policy: HnsEvidenceLeasePolicy;
  readonly provider_response_bytes: Uint8Array;
}>;

export async function buildHnsActiveLeaseRenewalEvidence(
  input: HnsActiveLeaseRenewalEvidenceBuildInput,
): Promise<HnsActiveLeaseRenewalEvidenceEnvelopeV1> {
  assertRequest(input.request);
  assertAuthority(input.authority);
  if (input.binding_generation !== input.request.expected_binding_generation + 1) {
    throw new TypeError("HNS renewal evidence must advance the binding generation once");
  }
  const requirementHash = await hnsActiveLeaseRenewalRequirementHash(input.authority);
  assertRequestMatchesAuthority(input.request, input.authority, requirementHash);
  if (input.principal_id !== input.authority.principal_id) {
    throw new TypeError("HNS renewal evidence principal does not match authority");
  }
  const decodedResponse = await decodeHnsActiveLeaseRenewalResponseBytes(
    input.provider_response_bytes,
    {
      request: input.request,
      authority: input.authority,
      control_identity: input.control_identity,
      policy: input.policy,
    },
  );
  if (decodedResponse.response.status !== "verified") {
    throw new TypeError("HNS renewal evidence requires a verified provider response");
  }
  if (
    classifyHnsActiveLeaseRenewalResponse(
      decodedResponse.response,
      input.request.expected_control_identity_digest,
      input.request.expected_chain_authority_digest,
    ) !== "verified"
  ) {
    throw new TypeError("HNS renewal evidence requires unchanged control and authority digests");
  }
  const providerResponseSha256 = await sha256Bytes(input.provider_response_bytes);
  const observation = decodedResponse.response.observation;
  const envelopeWithoutDigest = {
    version: HNS_ACTIVE_LEASE_RENEWAL_EVIDENCE_VERSION,
    active_lease_renewal_id: input.request.active_lease_renewal_id,
    active_lease_renewal_attempt_id: input.request.active_lease_renewal_attempt_id,
    community_id: input.request.community_id,
    route_binding_id: input.request.route_binding_id,
    principal_kind: "system" as const,
    principal_id: input.principal_id,
    requirement_hash: input.request.requirement_hash,
    expected_binding_generation: input.request.expected_binding_generation,
    binding_generation: input.binding_generation,
    expected_verified_evidence_ref: input.request.expected_verified_evidence_ref,
    expected_evidence_digest: input.request.expected_evidence_digest,
    expected_control_identity_digest: input.request.expected_control_identity_digest,
    expected_chain_authority_digest: input.request.expected_chain_authority_digest,
    prior_provider_evidence_ref: input.request.prior_provider_evidence_ref,
    request_hash: input.request.request_hash,
    provider_id: input.request.provider_id,
    provider_binding_hash: input.request.provider_binding_hash,
    provider_configuration_kind: input.request.provider_configuration.kind,
    provider_configuration_reference: input.request.provider_configuration.reference,
    provider_configuration_version: input.request.provider_configuration.version,
    provider_configuration_digest: input.request.provider_configuration.digest,
    protocol_version: input.request.protocol_version,
    environment: input.request.environment,
    family: "hns" as const,
    root_label: input.request.route.root_label,
    root_label_display: input.request.route.root_label_display,
    path_segment: input.request.route.path_segment,
    ownership_source: observation.ownership_source,
    txt_name: observation.txt_name,
    expected_txt_value_sha256: observation.expected_txt_value_sha256,
    control_identity_digest: observation.control_identity_digest,
    chain_authority_digest: observation.chain_authority_digest,
    root_exists: true as const,
    root_control_verified: true as const,
    expiry_horizon_sufficient: true as const,
    chain_network: observation.chain_network,
    chain_anchor_height: observation.chain_anchor_height,
    chain_anchor_block_hash: observation.chain_anchor_block_hash,
    chain_anchor_median_time: observation.chain_anchor_median_time,
    expiry_height: observation.expiry_height,
    observed_at: observation.observed_at,
    expires_at: observation.expires_at,
    evidence_ref: input.request.evidence_ref,
    provider_evidence_ref: observation.provider_evidence_ref,
    observer_result_sha256: observation.observer_result_sha256,
    provider_response_sha256: providerResponseSha256,
  } satisfies Omit<HnsActiveLeaseRenewalEvidenceEnvelopeV1, "evidence_digest">;
  const evidenceDigest = await hnsActiveLeaseRenewalEvidenceHash({
    ...envelopeWithoutDigest,
    evidence_digest: "0".repeat(64) as Sha256HexValue,
  });
  return { ...envelopeWithoutDigest, evidence_digest: evidenceDigest };
}

export type HnsActiveLeaseRenewalOutcomeStatus =
  | "verified"
  | "root_absent"
  | "root_inactive"
  | "txt_absent"
  | "txt_value_mismatch"
  | "control_identity_changed"
  | "chain_authority_changed"
  | "expiry_horizon_insufficient"
  | "lease_expired_before_commit"
  | "stale_cas";

export function classifyHnsActiveLeaseRenewalResponse(
  response: HnsOwnerActiveLeaseRenewalResponseV1,
  expectedControlIdentityDigest: Sha256HexValue,
  expectedChainAuthorityDigest: Sha256HexValue,
): HnsActiveLeaseRenewalOutcomeStatus | null {
  assertResponse(response);
  decodeSchema(
    Sha256Hex,
    expectedControlIdentityDigest,
    "Expected HNS control-identity digest is invalid",
  );
  decodeSchema(
    Sha256Hex,
    expectedChainAuthorityDigest,
    "Expected HNS chain-authority digest is invalid",
  );
  if (response.status === "unavailable") return null;
  if (response.status === "rejected") return response.reason_code;
  if (response.observation.chain_authority_digest !== expectedChainAuthorityDigest) {
    return "chain_authority_changed";
  }
  if (response.observation.control_identity_digest !== expectedControlIdentityDigest) {
    return "control_identity_changed";
  }
  return "verified";
}

export type HnsActiveLeaseRenewalResultHashInput = Readonly<{
  readonly active_lease_renewal_id: string;
  readonly active_lease_renewal_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly idempotency_key: string;
  readonly request_hash: Sha256HexValue;
  readonly outcome_status: HnsActiveLeaseRenewalOutcomeStatus;
  readonly evidence_ref_or_null: string | null;
  readonly evidence_digest_or_null: Sha256HexValue | null;
  readonly provider_response_sha256_or_null: Sha256HexValue | null;
  readonly ownership_status_or_null: string | null;
  readonly route_lifecycle_status_or_null: string | null;
}>;

export type HnsActiveLeaseRenewalResultV2HashInput = Schema.Schema.Type<typeof ResultV2Schema>;

export function hnsActiveLeaseRenewalResultPreimage(
  input: HnsActiveLeaseRenewalResultHashInput,
): string {
  const decoded = decodeSchema(
    ResultSchema,
    input,
    "HNS active-renewal result failed its strict schema",
  );
  assertResultMatrix(decoded);
  return orderedJson([
    HNS_ACTIVE_LEASE_RENEWAL_RESULT_VERSION,
    decoded.active_lease_renewal_id,
    decoded.active_lease_renewal_attempt_id,
    decoded.route_binding_id,
    decoded.expected_binding_generation,
    decoded.idempotency_key,
    decoded.request_hash,
    decoded.outcome_status,
    decoded.evidence_ref_or_null,
    decoded.evidence_digest_or_null,
    decoded.provider_response_sha256_or_null,
    decoded.ownership_status_or_null,
    decoded.route_lifecycle_status_or_null,
  ]);
}

export function hnsActiveLeaseRenewalResultHash(
  input: HnsActiveLeaseRenewalResultHashInput,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsActiveLeaseRenewalResultPreimage(input));
}

export function hnsActiveLeaseRenewalResultV2Preimage(
  input: HnsActiveLeaseRenewalResultV2HashInput,
): string {
  const decoded = decodeSchema(
    ResultV2Schema,
    input,
    "HNS active-renewal result-v2 failed its strict schema",
  );
  assertResultV2Matrix(decoded);
  return orderedJson([
    HNS_ACTIVE_LEASE_RENEWAL_RESULT_V2_VERSION,
    decoded.active_lease_renewal_id,
    decoded.active_lease_renewal_attempt_id,
    decoded.route_binding_id,
    decoded.expected_binding_generation,
    decoded.idempotency_key,
    decoded.request_hash,
    decoded.outcome_status,
    decoded.evidence_ref_or_null,
    decoded.evidence_digest_or_null,
    decoded.provider_response_sha256_or_null,
    decoded.ownership_status_or_null,
    decoded.route_lifecycle_status_or_null,
  ]);
}

export function hnsActiveLeaseRenewalResultV2Hash(
  input: HnsActiveLeaseRenewalResultV2HashInput,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsActiveLeaseRenewalResultV2Preimage(input));
}
