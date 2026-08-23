import { CommunityCanonicalRouteV1 } from "@pirate/contracts";
import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Schema } from "effect";
import type {
  HnsEvidenceLeasePolicy,
  HnsOwnerTargetObservationV2,
} from "../namespace-ownership/hns-control-observer.ts";
import {
  deriveHnsEvidenceLease,
  hnsControlIdentityDigest,
} from "../namespace-ownership/hns-control-observer.ts";
import {
  decodeStrictHnsJsonBytes,
  hnsOwnerChallengeName,
  hnsOwnerChallengeValue,
  hnsOwnerChallengeValueSha256,
  hnsProviderIdentityDigest,
  sha256Utf8,
} from "../namespace-ownership/hns-evidence.ts";
import { sha256RouteRevalidationBytes } from "./hashes.ts";

export const HNS_OWNER_RECOVERY_PROTOCOL_VERSION = "hns-owner-recovery-v1" as const;
export const HNS_OWNER_RECOVERY_PROVIDER_ID = "hns.owner.v1" as const;
export const HNS_OWNER_RECOVERY_REQUIREMENT_VERSION =
  "pirate-hns-owner-recovery-requirement-v1" as const;
export const HNS_OWNER_RECOVERY_PUBLIC_START_VERSION =
  "pirate-hns-owner-recovery-public-start-v1" as const;
export const HNS_OWNER_RECOVERY_PROVIDER_START_VERSION =
  "pirate-hns-owner-recovery-provider-start-v1" as const;
export const HNS_OWNER_RECOVERY_POLL_VERSION = "pirate-hns-owner-recovery-poll-v1" as const;
export const HNS_OWNER_RECOVERY_EVIDENCE_VERSION = "pirate-hns-owner-recovery-evidence-v1" as const;
export const HNS_OWNER_RECOVERY_RESULT_VERSION = "pirate-hns-owner-recovery-result-v1" as const;
export const HNS_OWNER_RECOVERY_START_REQUEST_MAX_BYTES = 1_024 as const;
export const HNS_OWNER_RECOVERY_PROVIDER_START_MAX_BYTES = 8_192 as const;
export const HNS_OWNER_RECOVERY_POLL_REQUEST_MAX_BYTES = 2_048 as const;
export const HNS_OWNER_RECOVERY_PROVIDER_POLL_MAX_BYTES = 32_768 as const;
export const HNS_OWNER_RECOVERY_PROVIDER_RESPONSE_MAX_BYTES = 1_048_576 as const;
export const HNS_OWNER_RECOVERY_CHALLENGE_TTL_SECONDS = 3_600 as const;
export const HNS_OWNER_RECOVERY_DEFAULT_RETRY_SECONDS = 5 as const;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function isSafeText(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) return false;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return false;
  }
  return true;
}

function boundedString(maxBytes: number, label: string) {
  return Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value && utf8Length(value) <= maxBytes && isSafeText(value)
        ? undefined
        : `Expected ${label} to be bounded canonical UTF-8`,
    ),
  );
}

const Identifier = boundedString(256, "identifier");
const Reference = boundedString(512, "reference");
const UpstreamReference = boundedString(16_384, "upstream_session_ref");
const ChallengeValue = boundedString(16_448, "challenge_value");
const DiagnosticReference = boundedString(512, "diagnostic_ref");
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);
const NonNegativeSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a non-negative safe integer",
  ),
);
const RetrySeconds = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 3_600
      ? undefined
      : "Expected retry seconds from 1 through 3600",
  ),
);
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC instant";
  }),
);
const RootLabel = boundedString(63, "root_label").check(
  Schema.makeFilter((value) =>
    validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root",
  ),
);
const RootDisplay = boundedString(255, "root_label_display");

const ConfigurationSchema = Schema.Struct({
  kind: Schema.Literals(["managed", "dynamic"]),
  reference: Reference,
  version: Identifier,
  digest: Sha256Hex,
});
const RouteSchema = Schema.Struct({
  family: Schema.Literal("hns"),
  root_label: RootLabel,
  root_label_display: RootDisplay,
  path_segment: boundedString(255, "path_segment"),
  href: boundedString(512, "href"),
  app_host: Schema.Null,
});
const RecoveryAuthorityKindSchema = Schema.Literals([
  "database_time_expiry_transition",
  "route_revalidation_terminal",
  "active_lease_renewal_terminal",
  "owner_recovery_terminal",
]);
const OwnershipSourceSchema = Schema.Literals([
  "hns_parent_chain_txt",
  "owner_authoritative_dns_txt",
]);

const AuthoritySchema = Schema.Struct({
  actor_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  recovery_authority_kind: RecoveryAuthorityKindSchema,
  recovery_authority_reference: Reference,
  provider_id: Schema.Literal(HNS_OWNER_RECOVERY_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration: ConfigurationSchema,
  protocol_version: Schema.Literal(HNS_OWNER_RECOVERY_PROTOCOL_VERSION),
  environment: Identifier,
  route: RouteSchema,
});
const StartRequestSchema = Schema.Struct({
  expected_generation: PositiveSafeInteger,
  idempotency_key: Identifier,
});
const ProviderStartSchema = Schema.Struct({
  version: Schema.Literal(HNS_OWNER_RECOVERY_PROVIDER_START_VERSION),
  operation_kind: Schema.Literal("same_root_recovery"),
  route_recovery_id: Identifier,
  session_id: Identifier,
  actor_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  recovery_authority_kind: RecoveryAuthorityKindSchema,
  recovery_authority_reference: Reference,
  requirement_hash: Sha256Hex,
  provider_start_hash: Sha256Hex,
  provider_id: Schema.Literal(HNS_OWNER_RECOVERY_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration: ConfigurationSchema,
  protocol_version: Schema.Literal(HNS_OWNER_RECOVERY_PROTOCOL_VERSION),
  environment: Identifier,
  challenge_expires_at: CanonicalInstant,
  route: RouteSchema,
});
const PersistedSessionSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  operation_mode: Schema.Literal("same_root_recovery"),
  actor_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  recovery_authority_kind: RecoveryAuthorityKindSchema,
  recovery_authority_reference: Reference,
  requirement_hash: Sha256Hex,
  public_start_hash: Sha256Hex,
  provider_start_hash: Sha256Hex,
  provider_id: Schema.Literal(HNS_OWNER_RECOVERY_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration: ConfigurationSchema,
  protocol_version: Schema.Literal(HNS_OWNER_RECOVERY_PROTOCOL_VERSION),
  environment: Identifier,
  route: RouteSchema,
  upstream_session_ref: UpstreamReference,
  ownership_source: OwnershipSourceSchema,
  challenge_name: boundedString(255, "challenge_name"),
  challenge_value: ChallengeValue,
  challenge_expires_at: CanonicalInstant,
  status: Schema.Literal("pending"),
  started_at: CanonicalInstant,
});
const PollRequestSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  expected_generation: PositiveSafeInteger,
  idempotency_key: Identifier,
  channel: Schema.Literal("poll_result"),
});
const PublicStartHashInputSchema = Schema.Struct({
  actor_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  idempotency_key: Identifier,
  requirement_hash: Sha256Hex,
});
const ResultHashInputSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  recovery_attempt_id: Identifier,
  route_binding_id: Identifier,
  expected_binding_generation: PositiveSafeInteger,
  idempotency_key: Identifier,
  poll_hash: Sha256Hex,
  outcome_status: Schema.Literals([
    "verified",
    "root_absent",
    "root_inactive",
    "expiry_horizon_insufficient",
    "session_expired",
    "stale_cas",
  ]),
  evidence_ref_or_null: Schema.NullOr(Reference),
  evidence_digest_or_null: Schema.NullOr(Sha256Hex),
  provider_response_sha256_or_null: Schema.NullOr(Sha256Hex),
  ownership_status_or_null: Schema.NullOr(Schema.Literals(["verified", "revoked", "expired"])),
  route_lifecycle_status_or_null: Schema.NullOr(Schema.Literals(["active", "suspended"])),
});
const EvidenceBodySchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  recovery_attempt_id: Identifier,
  actor_id: Identifier,
  community_id: Identifier,
  route_binding_id: Identifier,
  requirement_hash: Sha256Hex,
  public_start_hash: Sha256Hex,
  provider_start_hash: Sha256Hex,
  poll_hash: Sha256Hex,
  expected_binding_generation: PositiveSafeInteger,
  binding_generation: PositiveSafeInteger,
  recovery_authority_kind: RecoveryAuthorityKindSchema,
  recovery_authority_reference: Reference,
  provider_id: Schema.Literal(HNS_OWNER_RECOVERY_PROVIDER_ID),
  provider_binding_hash: Sha256Hex,
  provider_configuration_kind: Schema.Literals(["managed", "dynamic"]),
  provider_configuration_reference: Reference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: Sha256Hex,
  protocol_version: Schema.Literal(HNS_OWNER_RECOVERY_PROTOCOL_VERSION),
  environment: Identifier,
  family: Schema.Literal("hns"),
  root_label: RootLabel,
  root_label_display: RootDisplay,
  path_segment: boundedString(255, "path_segment"),
  challenge_expires_at: CanonicalInstant,
  ownership_source: OwnershipSourceSchema,
  challenge_name: boundedString(255, "challenge_name"),
  challenge_value_sha256: Sha256Hex,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: Identifier,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  observed_at: CanonicalInstant,
  expires_at: CanonicalInstant,
  evidence_ref: Reference,
  provider_evidence_ref: Reference,
  observer_result_sha256: Sha256Hex,
  provider_response_sha256: Sha256Hex,
  provider_identity_digest: Sha256Hex,
});
const ProviderPollSchema = Schema.Struct({
  operation_kind: Schema.Literal("same_root_recovery"),
  protocol_version: Schema.Literal(HNS_OWNER_RECOVERY_PROTOCOL_VERSION),
  session: PersistedSessionSchema,
  payload: Schema.Struct({}),
});
const ProviderStartOutcomeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    upstream_session_ref: UpstreamReference,
    ownership_source: OwnershipSourceSchema,
    challenge_name: boundedString(255, "challenge_name"),
    challenge_value: ChallengeValue,
    expires_at: CanonicalInstant,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.Literals(["unavailable", "misconfigured", "invalid_response"]),
  }),
]);

const TargetVerifiedSchema = Schema.Struct({
  status: Schema.Literal("verified"),
  observation_contract_version: Schema.Literal("pirate-hns-target-observation-v2"),
  provider_evidence_ref: Reference,
  upstream_session_ref: UpstreamReference,
  ownership_source: OwnershipSourceSchema,
  challenge_name: boundedString(255, "challenge_name"),
  challenge_value: ChallengeValue,
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
  observer_result_sha256: Sha256Hex,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: Identifier,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  observed_at: CanonicalInstant,
  expires_at: CanonicalInstant,
});
const TargetRejectedSchema = Schema.Struct({
  status: Schema.Literal("rejected"),
  observation_contract_version: Schema.Literal("pirate-hns-target-observation-v2"),
  reason_code: Schema.Literals(["root_absent", "root_inactive", "expiry_horizon_insufficient"]),
  observer_result_sha256: Sha256Hex,
  provider_evidence_ref: Reference,
});
const TargetPendingSchema = Schema.Struct({
  status: Schema.Literal("pending"),
  observation_contract_version: Schema.Literal("pirate-hns-target-observation-v2"),
  reason_code: Schema.Literals(["txt_absent", "txt_value_mismatch"]),
  observer_result_sha256: Sha256Hex,
  provider_evidence_ref: Reference,
});
const TargetUnavailableSchema = Schema.Struct({
  status: Schema.Literal("unavailable"),
  observation_contract_version: Schema.Literal("pirate-hns-target-observation-v2"),
  reason_code: Schema.Literals([
    "chain_transport_unavailable",
    "chain_unsynchronized",
    "chain_view_stale",
    "chain_view_changed",
    "chain_response_invalid",
    "authoritative_dns_timeout",
    "authoritative_dns_servfail",
    "authoritative_dns_insecure",
    "authoritative_dns_inconclusive",
    "observer_capacity",
    "observer_internal_error",
  ]),
  retry_after_seconds: Schema.NullOr(RetrySeconds),
  diagnostic_ref: Schema.NullOr(DiagnosticReference),
});
const PublicStartResponseSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  generation: PositiveSafeInteger,
  channel: Schema.Literal("poll_result"),
  status: Schema.Literal("pending"),
  expires_at: CanonicalInstant,
  challenge: Schema.Struct({
    ownership_source: OwnershipSourceSchema,
    challenge_name: boundedString(255, "challenge_name"),
    challenge_value: ChallengeValue,
    expires_at: CanonicalInstant,
  }),
  replayed: Schema.Boolean,
});
const PublicPollPendingSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  generation: PositiveSafeInteger,
  status: Schema.Literals(["pending", "unavailable"]),
  replayed: Schema.Literal(false),
  retry_after_seconds: RetrySeconds,
  result_hash: Schema.Null,
});
const PublicPollRejectedSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  generation: PositiveSafeInteger,
  status: Schema.Literal("rejected"),
  reason_code: Schema.Literals(["root_unavailable", "expiry_insufficient"]),
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});
const PublicPollVerifiedSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  generation: PositiveSafeInteger,
  status: Schema.Literal("verified"),
  canonical_route: RouteSchema,
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});
const PublicPollExpiredSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  generation: PositiveSafeInteger,
  status: Schema.Literal("expired"),
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});

const providerStartKeys = [
  "version",
  "operation_kind",
  "route_recovery_id",
  "session_id",
  "actor_id",
  "community_id",
  "route_binding_id",
  "expected_binding_generation",
  "recovery_authority_kind",
  "recovery_authority_reference",
  "requirement_hash",
  "provider_start_hash",
  "provider_id",
  "provider_binding_hash",
  "provider_configuration",
  "protocol_version",
  "environment",
  "challenge_expires_at",
  "route",
] as const;
const persistedSessionKeys = [
  "route_recovery_id",
  "session_id",
  "operation_mode",
  "actor_id",
  "community_id",
  "route_binding_id",
  "expected_binding_generation",
  "recovery_authority_kind",
  "recovery_authority_reference",
  "requirement_hash",
  "public_start_hash",
  "provider_start_hash",
  "provider_id",
  "provider_binding_hash",
  "provider_configuration",
  "protocol_version",
  "environment",
  "route",
  "upstream_session_ref",
  "ownership_source",
  "challenge_name",
  "challenge_value",
  "challenge_expires_at",
  "status",
  "started_at",
] as const;
const verifiedKeys = [
  "status",
  "observation_contract_version",
  "provider_evidence_ref",
  "upstream_session_ref",
  "ownership_source",
  "challenge_name",
  "challenge_value",
  "expected_txt_value_sha256",
  "control_identity_digest",
  "chain_authority_digest",
  "observer_result_sha256",
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
] as const;

export type HnsOwnerRecoveryProviderConfiguration = Schema.Schema.Type<typeof ConfigurationSchema>;
export type HnsOwnerRecoveryRoute = Schema.Schema.Type<typeof RouteSchema>;
export type HnsOwnerRecoveryAuthorityV1 = Schema.Schema.Type<typeof AuthoritySchema>;
export type HnsOwnerRecoveryStartRequestV1 = Schema.Schema.Type<typeof StartRequestSchema>;
export type HnsOwnerSameRootRecoveryProviderStartV1 = Schema.Schema.Type<
  typeof ProviderStartSchema
>;
export type HnsOwnerRecoveryPersistedSessionV1 = Schema.Schema.Type<typeof PersistedSessionSchema>;
export type HnsOwnerRecoveryPersistedSessionAuthority = Readonly<{
  readonly expected_route_recovery_id: string;
  readonly expected_session_id: string;
  readonly start_idempotency_key: string;
  readonly expected_public_start_hash: Sha256HexValue;
  readonly expected_upstream_session_ref: string;
  readonly expected_ownership_source: Schema.Schema.Type<typeof OwnershipSourceSchema>;
  readonly expected_challenge_expires_at: string;
}>;
export type HnsOwnerRecoveryPollRequestV1 = Schema.Schema.Type<typeof PollRequestSchema>;
export type HnsOwnerSameRootRecoveryProviderPollV1 = Schema.Schema.Type<typeof ProviderPollSchema>;
export type HnsOwnerRecoveryTargetResponseV2 = HnsOwnerTargetObservationV2;
export type HnsOwnerRecoveryOutcomeStatus =
  | "verified"
  | "root_absent"
  | "root_inactive"
  | "expiry_horizon_insufficient"
  | "session_expired"
  | "stale_cas";

export type HnsOwnerRecoveryEvidenceEnvelopeV1 = Readonly<{
  readonly version: typeof HNS_OWNER_RECOVERY_EVIDENCE_VERSION;
  readonly route_recovery_id: string;
  readonly session_id: string;
  readonly recovery_attempt_id: string;
  readonly actor_id: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly requirement_hash: Sha256HexValue;
  readonly public_start_hash: Sha256HexValue;
  readonly provider_start_hash: Sha256HexValue;
  readonly poll_hash: Sha256HexValue;
  readonly expected_binding_generation: number;
  readonly binding_generation: number;
  readonly recovery_authority_kind: Schema.Schema.Type<typeof RecoveryAuthorityKindSchema>;
  readonly recovery_authority_reference: string;
  readonly provider_id: typeof HNS_OWNER_RECOVERY_PROVIDER_ID;
  readonly provider_binding_hash: Sha256HexValue;
  readonly provider_configuration_kind: "managed" | "dynamic";
  readonly provider_configuration_reference: string;
  readonly provider_configuration_version: string;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly protocol_version: typeof HNS_OWNER_RECOVERY_PROTOCOL_VERSION;
  readonly environment: string;
  readonly family: "hns";
  readonly root_label: string;
  readonly root_label_display: string;
  readonly path_segment: string;
  readonly challenge_expires_at: string;
  readonly ownership_source: Schema.Schema.Type<typeof OwnershipSourceSchema>;
  readonly challenge_name: string;
  readonly challenge_value_sha256: Sha256HexValue;
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
  readonly provider_identity_digest: Sha256HexValue;
  readonly evidence_digest: Sha256HexValue;
}>;

export type HnsOwnerRecoveryResultHashInput = Readonly<{
  readonly route_recovery_id: string;
  readonly session_id: string;
  readonly recovery_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly idempotency_key: string;
  readonly poll_hash: Sha256HexValue;
  readonly outcome_status: HnsOwnerRecoveryOutcomeStatus;
  readonly evidence_ref_or_null: string | null;
  readonly evidence_digest_or_null: Sha256HexValue | null;
  readonly provider_response_sha256_or_null: Sha256HexValue | null;
  readonly ownership_status_or_null: "verified" | "revoked" | "expired" | null;
  readonly route_lifecycle_status_or_null: "active" | "suspended" | null;
}>;

export type HnsOwnerRecoveryPollOutcome =
  | Readonly<{ readonly kind: "pending"; readonly retry_after_seconds: 5 }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly retry_after_seconds: number;
      readonly reason_code: string;
      readonly diagnostic_ref: string | null;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly outcome_status: "root_absent" | "root_inactive" | "expiry_horizon_insufficient";
      readonly provider_response_sha256: Sha256HexValue;
    }>
  | Readonly<{
      readonly kind: "verified";
      readonly observation: Schema.Schema.Type<typeof TargetVerifiedSchema>;
      readonly provider_response_sha256: Sha256HexValue;
    }>;

export class HnsOwnerRecoveryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HnsOwnerRecoveryDecodeError";
  }
}

function decodeSchema<T>(schema: Schema.ConstraintDecoder<T>, value: unknown, message: string): T {
  const decoded = Schema.decodeUnknownOption(schema, exactParseOptions)(value);
  if (Option.isNone(decoded)) throw new HnsOwnerRecoveryDecodeError(message);
  return decoded.value;
}

function assertOrder(value: unknown, keys: ReadonlyArray<string>, message: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HnsOwnerRecoveryDecodeError(message);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new HnsOwnerRecoveryDecodeError(message);
  }
}

function assertRoute(route: HnsOwnerRecoveryRoute): void {
  decodeSchema(RouteSchema, route, "HNS owner-recovery route is not canonical");
  const canonical = Schema.decodeUnknownOption(CommunityCanonicalRouteV1, exactParseOptions)(route);
  if (Option.isNone(canonical) || canonical.value.family !== "hns" || route.app_host !== null) {
    throw new HnsOwnerRecoveryDecodeError("HNS owner-recovery route is not canonical");
  }
}

function assertAuthority(authority: HnsOwnerRecoveryAuthorityV1): void {
  decodeSchema(AuthoritySchema, authority, "HNS owner-recovery authority is not strict");
  assertRoute(authority.route);
}

function targetKeys(value: HnsOwnerRecoveryTargetResponseV2): ReadonlyArray<string> {
  if (value.status === "verified") return verifiedKeys;
  if (value.status === "rejected" || value.status === "pending") {
    return [
      "status",
      "observation_contract_version",
      "reason_code",
      "observer_result_sha256",
      "provider_evidence_ref",
    ];
  }
  return [
    "status",
    "observation_contract_version",
    "reason_code",
    "retry_after_seconds",
    "diagnostic_ref",
  ];
}

function providerEvidenceCrossPin(reference: string, observerHash: string): void {
  const prefix = `hns-observer-v1:sha256:${observerHash}:`;
  const snapshotReference = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
  if (
    snapshotReference.length === 0 ||
    utf8Length(snapshotReference) > 424 ||
    snapshotReference.trim() !== snapshotReference ||
    !isSafeText(snapshotReference)
  ) {
    throw new HnsOwnerRecoveryDecodeError(
      "HNS owner-recovery provider evidence is not cross-pinned",
    );
  }
}

function orderedJson(values: ReadonlyArray<string | number | boolean | null>): string {
  return JSON.stringify(values);
}

export function hnsOwnerRecoveryRequirementPreimage(
  authority: HnsOwnerRecoveryAuthorityV1,
): string {
  assertAuthority(authority);
  return orderedJson([
    HNS_OWNER_RECOVERY_REQUIREMENT_VERSION,
    authority.actor_id,
    authority.community_id,
    authority.route_binding_id,
    authority.expected_binding_generation,
    authority.recovery_authority_kind,
    authority.recovery_authority_reference,
    authority.provider_id,
    authority.provider_binding_hash,
    authority.provider_configuration.kind,
    authority.provider_configuration.reference,
    authority.provider_configuration.version,
    authority.provider_configuration.digest,
    authority.protocol_version,
    authority.environment,
    authority.route.family,
    authority.route.root_label,
    authority.route.root_label_display,
    authority.route.path_segment,
  ]);
}

export function hnsOwnerRecoveryRequirementHash(
  authority: HnsOwnerRecoveryAuthorityV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoveryRequirementPreimage(authority));
}

export function hnsOwnerRecoveryPublicStartPreimage(
  input: Readonly<{
    readonly actor_id: string;
    readonly community_id: string;
    readonly route_binding_id: string;
    readonly expected_binding_generation: number;
    readonly idempotency_key: string;
    readonly requirement_hash: string;
  }>,
): string {
  const decoded = decodeSchema(
    PublicStartHashInputSchema,
    input,
    "HNS owner-recovery public start hash input is invalid",
  );
  return orderedJson([
    HNS_OWNER_RECOVERY_PUBLIC_START_VERSION,
    decoded.actor_id,
    decoded.community_id,
    decoded.route_binding_id,
    decoded.expected_binding_generation,
    decoded.idempotency_key,
    decoded.requirement_hash,
  ]);
}

export function hnsOwnerRecoveryPublicStartHash(
  input: Parameters<typeof hnsOwnerRecoveryPublicStartPreimage>[0],
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoveryPublicStartPreimage(input));
}

export function hnsOwnerRecoveryProviderStartPreimage(
  input: HnsOwnerSameRootRecoveryProviderStartV1,
): string {
  decodeSchema(ProviderStartSchema, input, "HNS owner-recovery provider start is not strict");
  assertRoute(input.route);
  return orderedJson([
    HNS_OWNER_RECOVERY_PROVIDER_START_VERSION,
    input.route_recovery_id,
    input.session_id,
    input.actor_id,
    input.community_id,
    input.route_binding_id,
    input.expected_binding_generation,
    input.recovery_authority_kind,
    input.recovery_authority_reference,
    input.requirement_hash,
    input.provider_id,
    input.provider_binding_hash,
    input.provider_configuration.kind,
    input.provider_configuration.reference,
    input.provider_configuration.version,
    input.provider_configuration.digest,
    input.protocol_version,
    input.environment,
    input.challenge_expires_at,
    input.route.family,
    input.route.root_label,
    input.route.root_label_display,
    input.route.path_segment,
  ]);
}

export function hnsOwnerRecoveryProviderStartHash(
  input: HnsOwnerSameRootRecoveryProviderStartV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoveryProviderStartPreimage(input));
}

export function hnsOwnerRecoveryPollPreimage(input: HnsOwnerRecoveryPollRequestV1): string {
  decodeSchema(PollRequestSchema, input, "HNS owner-recovery poll request is not strict");
  return orderedJson([
    HNS_OWNER_RECOVERY_POLL_VERSION,
    input.route_recovery_id,
    input.session_id,
    input.expected_generation,
    input.idempotency_key,
    input.channel,
  ]);
}

export function hnsOwnerRecoveryPollHash(
  input: HnsOwnerRecoveryPollRequestV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoveryPollPreimage(input));
}

export function hnsOwnerRecoveryEvidencePreimage(
  evidence: Omit<HnsOwnerRecoveryEvidenceEnvelopeV1, "version" | "evidence_digest">,
): string {
  decodeSchema(EvidenceBodySchema, evidence, "HNS owner-recovery evidence hash input is invalid");
  providerEvidenceCrossPin(evidence.provider_evidence_ref, evidence.observer_result_sha256);
  assertRoute({
    family: "hns",
    root_label: evidence.root_label,
    root_label_display: evidence.root_label_display,
    path_segment: evidence.path_segment,
    href: `/c/${evidence.path_segment}`,
    app_host: null,
  });
  if (evidence.binding_generation !== evidence.expected_binding_generation + 1) {
    throw new HnsOwnerRecoveryDecodeError(
      "HNS owner-recovery evidence must advance generation exactly once",
    );
  }
  return orderedJson([
    HNS_OWNER_RECOVERY_EVIDENCE_VERSION,
    evidence.route_recovery_id,
    evidence.session_id,
    evidence.recovery_attempt_id,
    evidence.actor_id,
    evidence.community_id,
    evidence.route_binding_id,
    evidence.requirement_hash,
    evidence.public_start_hash,
    evidence.provider_start_hash,
    evidence.poll_hash,
    evidence.expected_binding_generation,
    evidence.binding_generation,
    evidence.recovery_authority_kind,
    evidence.recovery_authority_reference,
    evidence.provider_id,
    evidence.provider_binding_hash,
    evidence.provider_configuration_kind,
    evidence.provider_configuration_reference,
    evidence.provider_configuration_version,
    evidence.provider_configuration_digest,
    evidence.protocol_version,
    evidence.environment,
    evidence.family,
    evidence.root_label,
    evidence.root_label_display,
    evidence.path_segment,
    evidence.challenge_expires_at,
    evidence.ownership_source,
    evidence.challenge_name,
    evidence.challenge_value_sha256,
    evidence.root_exists,
    evidence.root_control_verified,
    evidence.expiry_horizon_sufficient,
    evidence.chain_network,
    evidence.chain_anchor_height,
    evidence.chain_anchor_block_hash,
    evidence.chain_anchor_median_time,
    evidence.expiry_height,
    evidence.observed_at,
    evidence.expires_at,
    evidence.evidence_ref,
    evidence.provider_evidence_ref,
    evidence.observer_result_sha256,
    evidence.provider_response_sha256,
    evidence.provider_identity_digest,
  ]);
}

export function hnsOwnerRecoveryEvidenceDigest(
  evidence: Omit<HnsOwnerRecoveryEvidenceEnvelopeV1, "version" | "evidence_digest">,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoveryEvidencePreimage(evidence));
}

function assertResultMatrix(input: HnsOwnerRecoveryResultHashInput): void {
  if (input.outcome_status === "verified") {
    if (
      input.evidence_ref_or_null === null ||
      input.evidence_digest_or_null === null ||
      input.provider_response_sha256_or_null === null ||
      input.ownership_status_or_null !== "verified" ||
      input.route_lifecycle_status_or_null !== "active"
    ) {
      throw new TypeError("Verified HNS owner-recovery result has an invalid matrix");
    }
    return;
  }
  if (
    input.outcome_status === "root_absent" ||
    input.outcome_status === "root_inactive" ||
    input.outcome_status === "expiry_horizon_insufficient"
  ) {
    const expectedOwnership =
      input.outcome_status === "expiry_horizon_insufficient" ? "expired" : "revoked";
    if (
      input.evidence_ref_or_null !== null ||
      input.evidence_digest_or_null !== null ||
      input.provider_response_sha256_or_null === null ||
      input.ownership_status_or_null !== expectedOwnership ||
      input.route_lifecycle_status_or_null !== "suspended"
    ) {
      throw new TypeError("Rejected HNS owner-recovery result has an invalid matrix");
    }
    return;
  }
  if (input.outcome_status === "session_expired") {
    if (
      input.evidence_ref_or_null !== null ||
      input.evidence_digest_or_null !== null ||
      input.provider_response_sha256_or_null !== null ||
      input.ownership_status_or_null !== "expired" ||
      input.route_lifecycle_status_or_null !== "suspended"
    ) {
      throw new TypeError("Expired HNS owner-recovery result has an invalid matrix");
    }
    return;
  }
  if (
    input.evidence_ref_or_null !== null ||
    input.evidence_digest_or_null !== null ||
    input.ownership_status_or_null !== null ||
    input.route_lifecycle_status_or_null !== null
  ) {
    throw new TypeError("Stale HNS owner-recovery result must not mutate authority");
  }
}

export function hnsOwnerRecoveryResultPreimage(input: HnsOwnerRecoveryResultHashInput): string {
  const decoded = decodeSchema(
    ResultHashInputSchema,
    input,
    "HNS owner-recovery result hash input is invalid",
  );
  assertResultMatrix(decoded);
  return orderedJson([
    HNS_OWNER_RECOVERY_RESULT_VERSION,
    decoded.route_recovery_id,
    decoded.session_id,
    decoded.recovery_attempt_id,
    decoded.route_binding_id,
    decoded.expected_binding_generation,
    decoded.idempotency_key,
    decoded.poll_hash,
    decoded.outcome_status,
    decoded.evidence_ref_or_null,
    decoded.evidence_digest_or_null,
    decoded.provider_response_sha256_or_null,
    decoded.ownership_status_or_null,
    decoded.route_lifecycle_status_or_null,
  ]);
}

export function hnsOwnerRecoveryResultHash(
  input: HnsOwnerRecoveryResultHashInput,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoveryResultPreimage(input));
}

export function hnsOwnerRecoveryChallengeExpiresAt(databaseStartedAt: string): string {
  decodeSchema(
    CanonicalInstant,
    databaseStartedAt,
    "HNS owner-recovery start time is not canonical",
  );
  const start = Date.parse(databaseStartedAt);
  const expires = start + HNS_OWNER_RECOVERY_CHALLENGE_TTL_SECONDS * 1_000;
  if (!Number.isSafeInteger(expires) || !Number.isFinite(expires)) {
    throw new HnsOwnerRecoveryDecodeError("HNS owner-recovery deadline is not representable");
  }
  return new Date(expires).toISOString();
}

export function hnsOwnerRecoveryDeadlineState(
  input: Readonly<{
    readonly database_now: string;
    readonly challenge_expires_at: string;
  }>,
): "live" | "expired" {
  decodeSchema(CanonicalInstant, input.database_now, "HNS recovery database time is not canonical");
  decodeSchema(
    CanonicalInstant,
    input.challenge_expires_at,
    "HNS recovery challenge deadline is not canonical",
  );
  return Date.parse(input.database_now) < Date.parse(input.challenge_expires_at)
    ? "live"
    : "expired";
}

export async function buildHnsOwnerRecoveryProviderStart(
  input: Readonly<{
    readonly route_recovery_id: string;
    readonly session_id: string;
    readonly authority: HnsOwnerRecoveryAuthorityV1;
    readonly database_started_at: string;
  }>,
): Promise<HnsOwnerSameRootRecoveryProviderStartV1> {
  assertAuthority(input.authority);
  const challengeExpiresAt = hnsOwnerRecoveryChallengeExpiresAt(input.database_started_at);
  const requirementHash = await hnsOwnerRecoveryRequirementHash(input.authority);
  const seed = {
    version: HNS_OWNER_RECOVERY_PROVIDER_START_VERSION,
    operation_kind: "same_root_recovery" as const,
    route_recovery_id: input.route_recovery_id,
    session_id: input.session_id,
    actor_id: input.authority.actor_id,
    community_id: input.authority.community_id,
    route_binding_id: input.authority.route_binding_id,
    expected_binding_generation: input.authority.expected_binding_generation,
    recovery_authority_kind: input.authority.recovery_authority_kind,
    recovery_authority_reference: input.authority.recovery_authority_reference,
    requirement_hash: requirementHash,
    provider_start_hash: "0".repeat(64) as Sha256HexValue,
    provider_id: input.authority.provider_id,
    provider_binding_hash: input.authority.provider_binding_hash,
    provider_configuration: input.authority.provider_configuration,
    protocol_version: HNS_OWNER_RECOVERY_PROTOCOL_VERSION,
    environment: input.authority.environment,
    challenge_expires_at: challengeExpiresAt,
    route: input.authority.route,
  };
  const providerStartHash = await hnsOwnerRecoveryProviderStartHash(seed);
  const body = { ...seed, provider_start_hash: providerStartHash };
  decodeSchema(ProviderStartSchema, body, "Built HNS owner-recovery provider start is invalid");
  return body;
}

function providerStartAuthority(
  input: HnsOwnerSameRootRecoveryProviderStartV1,
): HnsOwnerRecoveryAuthorityV1 {
  return {
    actor_id: input.actor_id,
    community_id: input.community_id,
    route_binding_id: input.route_binding_id,
    expected_binding_generation: input.expected_binding_generation,
    recovery_authority_kind: input.recovery_authority_kind,
    recovery_authority_reference: input.recovery_authority_reference,
    provider_id: input.provider_id,
    provider_binding_hash: input.provider_binding_hash,
    provider_configuration: input.provider_configuration,
    protocol_version: input.protocol_version,
    environment: input.environment,
    route: input.route,
  };
}

function providerStartFromPersistedSession(
  session: HnsOwnerRecoveryPersistedSessionV1,
): HnsOwnerSameRootRecoveryProviderStartV1 {
  return {
    version: HNS_OWNER_RECOVERY_PROVIDER_START_VERSION,
    operation_kind: "same_root_recovery",
    route_recovery_id: session.route_recovery_id,
    session_id: session.session_id,
    actor_id: session.actor_id,
    community_id: session.community_id,
    route_binding_id: session.route_binding_id,
    expected_binding_generation: session.expected_binding_generation,
    recovery_authority_kind: session.recovery_authority_kind,
    recovery_authority_reference: session.recovery_authority_reference,
    requirement_hash: session.requirement_hash,
    provider_start_hash: session.provider_start_hash,
    provider_id: session.provider_id,
    provider_binding_hash: session.provider_binding_hash,
    provider_configuration: session.provider_configuration,
    protocol_version: session.protocol_version,
    environment: session.environment,
    challenge_expires_at: session.challenge_expires_at,
    route: session.route,
  };
}

export async function validateHnsOwnerRecoveryPersistedSession(
  input: HnsOwnerRecoveryPersistedSessionV1,
  authority: HnsOwnerRecoveryPersistedSessionAuthority,
): Promise<HnsOwnerRecoveryPersistedSessionV1> {
  const session = decodeSchema(
    PersistedSessionSchema,
    input,
    "HNS owner-recovery persisted session is invalid",
  );
  assertRoute(session.route);
  const providerStart = providerStartFromPersistedSession(session);
  const expectedRequirementHash = await hnsOwnerRecoveryRequirementHash(
    providerStartAuthority(providerStart),
  );
  const expectedProviderStartHash = await hnsOwnerRecoveryProviderStartHash(providerStart);
  const expectedRouteRecoveryId = decodeSchema(
    Identifier,
    authority.expected_route_recovery_id,
    "HNS owner-recovery reservation operation id is invalid",
  );
  const expectedSessionId = decodeSchema(
    Identifier,
    authority.expected_session_id,
    "HNS owner-recovery reservation session id is invalid",
  );
  const startIdempotencyKey = decodeSchema(
    Identifier,
    authority.start_idempotency_key,
    "HNS owner-recovery reservation start idempotency key is invalid",
  );
  const expectedPublicStartHash = decodeSchema(
    Sha256Hex,
    authority.expected_public_start_hash,
    "HNS owner-recovery reservation public-start hash is invalid",
  );
  const expectedUpstreamSessionRef = decodeSchema(
    UpstreamReference,
    authority.expected_upstream_session_ref,
    "HNS owner-recovery retained upstream session reference is invalid",
  );
  const expectedOwnershipSource = decodeSchema(
    OwnershipSourceSchema,
    authority.expected_ownership_source,
    "HNS owner-recovery retained ownership source is invalid",
  );
  const expectedChallengeExpiresAt = decodeSchema(
    CanonicalInstant,
    authority.expected_challenge_expires_at,
    "HNS owner-recovery reservation challenge deadline is invalid",
  );
  const recomputedPublicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: session.actor_id,
    community_id: session.community_id,
    route_binding_id: session.route_binding_id,
    expected_binding_generation: session.expected_binding_generation,
    idempotency_key: startIdempotencyKey,
    requirement_hash: session.requirement_hash,
  });
  if (
    session.route_recovery_id !== expectedRouteRecoveryId ||
    session.session_id !== expectedSessionId ||
    session.requirement_hash !== expectedRequirementHash ||
    session.provider_start_hash !== expectedProviderStartHash ||
    session.public_start_hash !== expectedPublicStartHash ||
    session.public_start_hash !== recomputedPublicStartHash ||
    session.upstream_session_ref !== expectedUpstreamSessionRef ||
    session.ownership_source !== expectedOwnershipSource ||
    session.challenge_expires_at !== expectedChallengeExpiresAt ||
    session.challenge_expires_at !== hnsOwnerRecoveryChallengeExpiresAt(session.started_at) ||
    session.challenge_name !==
      hnsOwnerChallengeName(session.ownership_source, session.route.root_label) ||
    session.challenge_value !== hnsOwnerChallengeValue(session.upstream_session_ref)
  ) {
    throw new HnsOwnerRecoveryDecodeError(
      "HNS owner-recovery persisted session authority is not self-consistent",
    );
  }
  return session;
}

export async function encodeHnsOwnerRecoveryProviderStart(
  input: HnsOwnerSameRootRecoveryProviderStartV1,
): Promise<Uint8Array> {
  const decoded = decodeSchema(
    ProviderStartSchema,
    input,
    "HNS owner-recovery provider start is not strict",
  );
  assertOrder(decoded, providerStartKeys, "HNS owner-recovery provider start is reordered");
  assertOrder(
    decoded.provider_configuration,
    ["kind", "reference", "version", "digest"],
    "HNS owner-recovery provider configuration is reordered",
  );
  assertOrder(
    decoded.route,
    ["family", "root_label", "root_label_display", "path_segment", "href", "app_host"],
    "HNS owner-recovery route is reordered",
  );
  const expectedRequirementHash = await hnsOwnerRecoveryRequirementHash(
    providerStartAuthority(decoded),
  );
  const expectedProviderStartHash = await hnsOwnerRecoveryProviderStartHash(decoded);
  if (
    decoded.requirement_hash !== expectedRequirementHash ||
    decoded.provider_start_hash !== expectedProviderStartHash
  ) {
    throw new HnsOwnerRecoveryDecodeError(
      "HNS owner-recovery provider start hashes are not self-consistent",
    );
  }
  const bytes = encoder.encode(JSON.stringify(decoded));
  if (bytes.byteLength > HNS_OWNER_RECOVERY_PROVIDER_START_MAX_BYTES) {
    throw new HnsOwnerRecoveryDecodeError("HNS owner-recovery provider start exceeds byte limit");
  }
  return bytes;
}

export function decodeHnsOwnerRecoveryStartRequestBytes(
  value: Uint8Array,
): HnsOwnerRecoveryStartRequestV1 {
  const json = decodeStrictHnsJsonBytes(value, HNS_OWNER_RECOVERY_START_REQUEST_MAX_BYTES);
  assertOrder(json, ["expected_generation", "idempotency_key"], "Recovery start members reordered");
  return decodeSchema(StartRequestSchema, json, "HNS owner-recovery start request is invalid");
}

export function decodeHnsOwnerRecoveryPollRequestBytes(
  value: Uint8Array,
): HnsOwnerRecoveryPollRequestV1 {
  const json = decodeStrictHnsJsonBytes(value, HNS_OWNER_RECOVERY_POLL_REQUEST_MAX_BYTES);
  assertOrder(
    json,
    ["route_recovery_id", "session_id", "expected_generation", "idempotency_key", "channel"],
    "Recovery poll members reordered",
  );
  return decodeSchema(PollRequestSchema, json, "HNS owner-recovery poll request is invalid");
}

export async function buildHnsOwnerRecoveryProviderPoll(
  session: HnsOwnerRecoveryPersistedSessionV1,
  authority: HnsOwnerRecoveryPersistedSessionAuthority,
): Promise<HnsOwnerSameRootRecoveryProviderPollV1> {
  const decoded = await validateHnsOwnerRecoveryPersistedSession(session, authority);
  assertOrder(decoded, persistedSessionKeys, "HNS owner-recovery session is reordered");
  assertRoute(decoded.route);
  return {
    operation_kind: "same_root_recovery",
    protocol_version: HNS_OWNER_RECOVERY_PROTOCOL_VERSION,
    session: decoded,
    payload: {},
  };
}

export async function planHnsOwnerRecoveryPoll(
  input: Readonly<{
    readonly session: HnsOwnerRecoveryPersistedSessionV1;
    readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
    readonly database_now: string;
  }>,
): Promise<
  | Readonly<{ readonly kind: "expired" }>
  | Readonly<{
      readonly kind: "provider";
      readonly request: HnsOwnerSameRootRecoveryProviderPollV1;
    }>
> {
  const session = await validateHnsOwnerRecoveryPersistedSession(
    input.session,
    input.session_authority,
  );
  return hnsOwnerRecoveryDeadlineState({
    database_now: input.database_now,
    challenge_expires_at: session.challenge_expires_at,
  }) === "expired"
    ? { kind: "expired" }
    : {
        kind: "provider",
        request: await buildHnsOwnerRecoveryProviderPoll(session, input.session_authority),
      };
}

export async function encodeHnsOwnerRecoveryProviderPoll(
  input: HnsOwnerSameRootRecoveryProviderPollV1,
  authority: HnsOwnerRecoveryPersistedSessionAuthority,
): Promise<Uint8Array> {
  const decoded = decodeSchema(
    ProviderPollSchema,
    input,
    "HNS owner-recovery provider poll is invalid",
  );
  await validateHnsOwnerRecoveryPersistedSession(decoded.session, authority);
  assertOrder(
    decoded,
    ["operation_kind", "protocol_version", "session", "payload"],
    "HNS owner-recovery provider poll is reordered",
  );
  assertOrder(decoded.session, persistedSessionKeys, "HNS owner-recovery session is reordered");
  assertOrder(decoded.payload, [], "HNS owner-recovery poll payload is not empty");
  const bytes = encoder.encode(JSON.stringify(decoded));
  if (bytes.byteLength > HNS_OWNER_RECOVERY_PROVIDER_POLL_MAX_BYTES) {
    throw new HnsOwnerRecoveryDecodeError("HNS owner-recovery provider poll exceeds byte limit");
  }
  return bytes;
}

export async function decodeHnsOwnerRecoveryTargetResponseBytes(value: Uint8Array): Promise<
  Readonly<{
    readonly response: HnsOwnerRecoveryTargetResponseV2;
    readonly response_bytes: Uint8Array;
    readonly response_sha256: Sha256HexValue;
  }>
> {
  if (!(value instanceof Uint8Array)) {
    throw new HnsOwnerRecoveryDecodeError("HNS owner-recovery response must be exact bytes");
  }
  const bytes = new Uint8Array(value);
  const json = decodeStrictHnsJsonBytes(bytes, HNS_OWNER_RECOVERY_PROVIDER_RESPONSE_MAX_BYTES);
  const status =
    json !== null && typeof json === "object" && !Array.isArray(json) && "status" in json
      ? (json as { readonly status?: unknown }).status
      : undefined;
  const rawKeys: ReadonlyArray<string> =
    status === "verified"
      ? verifiedKeys
      : status === "rejected" || status === "pending"
        ? [
            "status",
            "observation_contract_version",
            "reason_code",
            "observer_result_sha256",
            "provider_evidence_ref",
          ]
        : [
            "status",
            "observation_contract_version",
            "reason_code",
            "retry_after_seconds",
            "diagnostic_ref",
          ];
  assertOrder(json, rawKeys, "HNS owner-recovery target response is reordered");
  const decoded: HnsOwnerRecoveryTargetResponseV2 =
    status === "verified"
      ? decodeSchema(
          TargetVerifiedSchema,
          json,
          "HNS owner-recovery requires a strict target-v2 verified response",
        )
      : status === "rejected"
        ? decodeSchema(
            TargetRejectedSchema,
            json,
            "HNS owner-recovery requires a strict target-v2 rejected response",
          )
        : status === "pending"
          ? decodeSchema(
              TargetPendingSchema,
              json,
              "HNS owner-recovery requires a strict target-v2 pending response",
            )
          : decodeSchema(
              TargetUnavailableSchema,
              json,
              "HNS owner-recovery requires a strict target-v2 unavailable response",
            );
  assertOrder(decoded, targetKeys(decoded), "HNS owner-recovery target response is reordered");
  if (decoded.status !== "unavailable") {
    providerEvidenceCrossPin(decoded.provider_evidence_ref, decoded.observer_result_sha256);
  }
  return {
    response: decoded,
    response_bytes: bytes,
    response_sha256: await sha256RouteRevalidationBytes(bytes),
  };
}

export async function classifyHnsOwnerRecoveryTargetResponse(
  input: Readonly<{
    readonly session: HnsOwnerRecoveryPersistedSessionV1;
    readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
    readonly response_bytes: Uint8Array;
    readonly policy: HnsEvidenceLeasePolicy;
    readonly database_now: string;
  }>,
): Promise<HnsOwnerRecoveryPollOutcome> {
  const session = await validateHnsOwnerRecoveryPersistedSession(
    input.session,
    input.session_authority,
  );
  if (
    hnsOwnerRecoveryDeadlineState({
      database_now: input.database_now,
      challenge_expires_at: session.challenge_expires_at,
    }) === "expired"
  ) {
    throw new HnsOwnerRecoveryDecodeError(
      "Expired HNS owner-recovery must terminalize without provider response",
    );
  }
  const decoded = await decodeHnsOwnerRecoveryTargetResponseBytes(input.response_bytes);
  const response = decoded.response;
  if (response.status === "pending") {
    return { kind: "pending", retry_after_seconds: HNS_OWNER_RECOVERY_DEFAULT_RETRY_SECONDS };
  }
  if (response.status === "unavailable") {
    return {
      kind: "unavailable",
      retry_after_seconds: response.retry_after_seconds ?? HNS_OWNER_RECOVERY_DEFAULT_RETRY_SECONDS,
      reason_code: response.reason_code,
      diagnostic_ref: response.diagnostic_ref,
    };
  }
  if (response.status === "rejected") {
    return {
      kind: "rejected",
      outcome_status: response.reason_code,
      provider_response_sha256: decoded.response_sha256,
    };
  }
  const expectedChallengeHash = await hnsOwnerChallengeValueSha256(session.upstream_session_ref);
  const expectedControlIdentityDigest = await hnsControlIdentityDigest({
    ownership_source: session.ownership_source,
    txt_name: session.challenge_name,
    expected_txt_value: session.challenge_value,
    root_label: session.route.root_label,
    chain_authority_digest: response.chain_authority_digest,
  });
  if (
    response.upstream_session_ref !== session.upstream_session_ref ||
    response.ownership_source !== session.ownership_source ||
    response.challenge_name !== session.challenge_name ||
    response.challenge_value !== session.challenge_value ||
    response.challenge_value !== hnsOwnerChallengeValue(session.upstream_session_ref) ||
    response.expected_txt_value_sha256 !== expectedChallengeHash ||
    response.control_identity_digest !== expectedControlIdentityDigest
  ) {
    throw new HnsOwnerRecoveryDecodeError(
      "HNS recovery response disagrees with persisted challenge",
    );
  }
  const lease = deriveHnsEvidenceLease(response, input.policy);
  if (response.observed_at !== lease.observed_at || response.expires_at !== lease.expires_at) {
    throw new HnsOwnerRecoveryDecodeError("HNS recovery lease is not chain-derived");
  }
  const databaseNow = Date.parse(input.database_now);
  if (
    Date.parse(response.observed_at) > databaseNow ||
    databaseNow >= Date.parse(response.expires_at)
  ) {
    throw new HnsOwnerRecoveryDecodeError("HNS recovery evidence is not fresh at database time");
  }
  return {
    kind: "verified",
    observation: response,
    provider_response_sha256: decoded.response_sha256,
  };
}

export async function buildHnsOwnerRecoveryEvidence(
  input: Readonly<{
    readonly session: HnsOwnerRecoveryPersistedSessionV1;
    readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
    readonly recovery_attempt_id: string;
    readonly poll_request: HnsOwnerRecoveryPollRequestV1;
    readonly response_bytes: Uint8Array;
    readonly policy: HnsEvidenceLeasePolicy;
    readonly database_now: string;
    readonly binding_generation: number;
    readonly evidence_ref: string;
  }>,
): Promise<HnsOwnerRecoveryEvidenceEnvelopeV1> {
  const session = await validateHnsOwnerRecoveryPersistedSession(
    input.session,
    input.session_authority,
  );
  if (input.binding_generation !== session.expected_binding_generation + 1) {
    throw new HnsOwnerRecoveryDecodeError("Recovery evidence must advance generation exactly once");
  }
  const outcome = await classifyHnsOwnerRecoveryTargetResponse({
    session,
    session_authority: input.session_authority,
    response_bytes: input.response_bytes,
    policy: input.policy,
    database_now: input.database_now,
  });
  if (outcome.kind !== "verified") {
    throw new HnsOwnerRecoveryDecodeError("Only verified recovery can build evidence");
  }
  const pollHash = await hnsOwnerRecoveryPollHash(input.poll_request);
  if (
    input.poll_request.route_recovery_id !== session.route_recovery_id ||
    input.poll_request.session_id !== session.session_id ||
    input.poll_request.expected_generation !== session.expected_binding_generation
  ) {
    throw new HnsOwnerRecoveryDecodeError("Recovery poll does not match persisted session");
  }
  const observation = outcome.observation;
  const providerIdentityDigest = await hnsProviderIdentityDigest({
    provider_id: session.provider_id,
    provider_configuration_kind: session.provider_configuration.kind,
    provider_configuration_reference: session.provider_configuration.reference,
    provider_configuration_version: session.provider_configuration.version,
    protocol_version: session.protocol_version,
    root_label: session.route.root_label,
  });
  const challengeValueSha256 = await hnsOwnerChallengeValueSha256(session.upstream_session_ref);
  const body = {
    route_recovery_id: session.route_recovery_id,
    session_id: session.session_id,
    recovery_attempt_id: input.recovery_attempt_id,
    actor_id: session.actor_id,
    community_id: session.community_id,
    route_binding_id: session.route_binding_id,
    requirement_hash: session.requirement_hash,
    public_start_hash: session.public_start_hash,
    provider_start_hash: session.provider_start_hash,
    poll_hash: pollHash,
    expected_binding_generation: session.expected_binding_generation,
    binding_generation: input.binding_generation,
    recovery_authority_kind: session.recovery_authority_kind,
    recovery_authority_reference: session.recovery_authority_reference,
    provider_id: session.provider_id,
    provider_binding_hash: session.provider_binding_hash,
    provider_configuration_kind: session.provider_configuration.kind,
    provider_configuration_reference: session.provider_configuration.reference,
    provider_configuration_version: session.provider_configuration.version,
    provider_configuration_digest: session.provider_configuration.digest,
    protocol_version: session.protocol_version,
    environment: session.environment,
    family: session.route.family,
    root_label: session.route.root_label,
    root_label_display: session.route.root_label_display,
    path_segment: session.route.path_segment,
    challenge_expires_at: session.challenge_expires_at,
    ownership_source: observation.ownership_source,
    challenge_name: observation.challenge_name,
    challenge_value_sha256: challengeValueSha256,
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
    evidence_ref: input.evidence_ref,
    provider_evidence_ref: observation.provider_evidence_ref,
    observer_result_sha256: observation.observer_result_sha256,
    provider_response_sha256: outcome.provider_response_sha256,
    provider_identity_digest: providerIdentityDigest,
  };
  return {
    version: HNS_OWNER_RECOVERY_EVIDENCE_VERSION,
    ...body,
    evidence_digest: await hnsOwnerRecoveryEvidenceDigest(body),
  };
}

export type HnsOwnerRecoveryProviderStartOutcome =
  | Readonly<{
      readonly status: "pending";
      readonly upstream_session_ref: string;
      readonly ownership_source: Schema.Schema.Type<typeof OwnershipSourceSchema>;
      readonly challenge_name: string;
      readonly challenge_value: string;
      readonly expires_at: string;
    }>
  | Readonly<{
      readonly status: "failed";
      readonly reason: "unavailable" | "misconfigured" | "invalid_response";
    }>;

export async function finalizeHnsOwnerRecoveryProviderStart(
  input: Readonly<{
    readonly provider_start: HnsOwnerSameRootRecoveryProviderStartV1;
    readonly public_start_hash: Sha256HexValue;
    readonly start_request: HnsOwnerRecoveryStartRequestV1;
    readonly started_at: string;
    readonly provider_outcome: HnsOwnerRecoveryProviderStartOutcome;
  }>,
): Promise<
  | Readonly<{
      readonly kind: "retained";
      readonly session: HnsOwnerRecoveryPersistedSessionV1;
      readonly response: Awaited<ReturnType<typeof hnsOwnerRecoveryStartResponse>>;
    }>
  | Readonly<{ readonly kind: "failed" }>
> {
  const providerStart = decodeSchema(
    ProviderStartSchema,
    input.provider_start,
    "Invalid HNS owner-recovery provider start",
  );
  decodeSchema(CanonicalInstant, input.started_at, "Invalid HNS owner-recovery start instant");
  const expectedRequirementHash = await hnsOwnerRecoveryRequirementHash(
    providerStartAuthority(providerStart),
  );
  const expectedProviderStartHash = await hnsOwnerRecoveryProviderStartHash(providerStart);
  if (
    providerStart.requirement_hash !== expectedRequirementHash ||
    providerStart.provider_start_hash !== expectedProviderStartHash
  ) {
    throw new HnsOwnerRecoveryDecodeError("Provider start hashes are not self-consistent");
  }
  const expectedPublicStartHash = await hnsOwnerRecoveryPublicStartHash({
    actor_id: providerStart.actor_id,
    community_id: providerStart.community_id,
    route_binding_id: providerStart.route_binding_id,
    expected_binding_generation: providerStart.expected_binding_generation,
    idempotency_key: input.start_request.idempotency_key,
    requirement_hash: providerStart.requirement_hash,
  });
  if (
    input.start_request.expected_generation !== providerStart.expected_binding_generation ||
    input.public_start_hash !== expectedPublicStartHash
  ) {
    throw new HnsOwnerRecoveryDecodeError("Public recovery start hash is not self-consistent");
  }
  const outcome = decodeSchema(
    ProviderStartOutcomeSchema,
    input.provider_outcome,
    "HNS owner-recovery provider start outcome is invalid",
  );
  if (outcome.status === "failed") return { kind: "failed" };
  if (
    outcome.expires_at !== providerStart.challenge_expires_at ||
    providerStart.challenge_expires_at !== hnsOwnerRecoveryChallengeExpiresAt(input.started_at) ||
    outcome.challenge_name !==
      hnsOwnerChallengeName(outcome.ownership_source, providerStart.route.root_label) ||
    outcome.challenge_value !== hnsOwnerChallengeValue(outcome.upstream_session_ref)
  ) {
    throw new HnsOwnerRecoveryDecodeError("Provider start does not echo recovery authority");
  }
  const session: HnsOwnerRecoveryPersistedSessionV1 = {
    route_recovery_id: providerStart.route_recovery_id,
    session_id: providerStart.session_id,
    operation_mode: "same_root_recovery",
    actor_id: providerStart.actor_id,
    community_id: providerStart.community_id,
    route_binding_id: providerStart.route_binding_id,
    expected_binding_generation: providerStart.expected_binding_generation,
    recovery_authority_kind: providerStart.recovery_authority_kind,
    recovery_authority_reference: providerStart.recovery_authority_reference,
    requirement_hash: providerStart.requirement_hash,
    public_start_hash: input.public_start_hash,
    provider_start_hash: providerStart.provider_start_hash,
    provider_id: providerStart.provider_id,
    provider_binding_hash: providerStart.provider_binding_hash,
    provider_configuration: providerStart.provider_configuration,
    protocol_version: providerStart.protocol_version,
    environment: providerStart.environment,
    route: providerStart.route,
    upstream_session_ref: outcome.upstream_session_ref,
    ownership_source: outcome.ownership_source,
    challenge_name: outcome.challenge_name,
    challenge_value: outcome.challenge_value,
    challenge_expires_at: outcome.expires_at,
    status: "pending",
    started_at: input.started_at,
  };
  decodeSchema(PersistedSessionSchema, session, "Built recovery session is invalid");
  return {
    kind: "retained",
    session,
    response: await hnsOwnerRecoveryStartResponse({
      session,
      session_authority: {
        expected_route_recovery_id: providerStart.route_recovery_id,
        expected_session_id: providerStart.session_id,
        start_idempotency_key: input.start_request.idempotency_key,
        expected_public_start_hash: input.public_start_hash,
        expected_upstream_session_ref: outcome.upstream_session_ref,
        expected_ownership_source: outcome.ownership_source,
        expected_challenge_expires_at: providerStart.challenge_expires_at,
      },
      replayed: false,
    }),
  };
}

export async function hnsOwnerRecoveryStartResponse(
  input: Readonly<{
    readonly session: HnsOwnerRecoveryPersistedSessionV1;
    readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
    readonly replayed: boolean;
  }>,
): Promise<
  Readonly<{
    readonly route_recovery_id: string;
    readonly session_id: string;
    readonly generation: number;
    readonly channel: "poll_result";
    readonly status: "pending";
    readonly expires_at: string;
    readonly challenge: Readonly<{
      readonly ownership_source: Schema.Schema.Type<typeof OwnershipSourceSchema>;
      readonly challenge_name: string;
      readonly challenge_value: string;
      readonly expires_at: string;
    }>;
    readonly replayed: boolean;
  }>
> {
  const session = await validateHnsOwnerRecoveryPersistedSession(
    input.session,
    input.session_authority,
  );
  if (
    session.challenge_name !==
      hnsOwnerChallengeName(session.ownership_source, session.route.root_label) ||
    session.challenge_value !== hnsOwnerChallengeValue(session.upstream_session_ref) ||
    session.challenge_expires_at !== hnsOwnerRecoveryChallengeExpiresAt(session.started_at)
  ) {
    throw new HnsOwnerRecoveryDecodeError("Recovery session challenge authority is inconsistent");
  }
  const response = {
    route_recovery_id: session.route_recovery_id,
    session_id: session.session_id,
    generation: session.expected_binding_generation,
    channel: "poll_result",
    status: "pending",
    expires_at: session.challenge_expires_at,
    challenge: {
      ownership_source: session.ownership_source,
      challenge_name: session.challenge_name,
      challenge_value: session.challenge_value,
      expires_at: session.challenge_expires_at,
    },
    replayed: input.replayed,
  };
  assertOrder(
    response,
    [
      "route_recovery_id",
      "session_id",
      "generation",
      "channel",
      "status",
      "expires_at",
      "challenge",
      "replayed",
    ],
    "HNS owner-recovery public start response is reordered",
  );
  assertOrder(
    response.challenge,
    ["ownership_source", "challenge_name", "challenge_value", "expires_at"],
    "HNS owner-recovery public challenge is reordered",
  );
  return decodeSchema(
    PublicStartResponseSchema,
    response,
    "HNS owner-recovery public start response is invalid",
  );
}

export type HnsOwnerRecoveryPollResponseV1 =
  | Readonly<{
      readonly route_recovery_id: string;
      readonly session_id: string;
      readonly generation: number;
      readonly status: "pending" | "unavailable";
      readonly replayed: false;
      readonly retry_after_seconds: number;
      readonly result_hash: null;
    }>
  | Readonly<{
      readonly route_recovery_id: string;
      readonly session_id: string;
      readonly generation: number;
      readonly status: "rejected";
      readonly reason_code: "root_unavailable" | "expiry_insufficient";
      readonly replayed: boolean;
      readonly retry_after_seconds: null;
      readonly result_hash: Sha256HexValue;
    }>
  | Readonly<{
      readonly route_recovery_id: string;
      readonly session_id: string;
      readonly generation: number;
      readonly status: "verified";
      readonly canonical_route: HnsOwnerRecoveryRoute;
      readonly replayed: boolean;
      readonly retry_after_seconds: null;
      readonly result_hash: Sha256HexValue;
    }>
  | Readonly<{
      readonly route_recovery_id: string;
      readonly session_id: string;
      readonly generation: number;
      readonly status: "expired";
      readonly replayed: boolean;
      readonly retry_after_seconds: null;
      readonly result_hash: Sha256HexValue;
    }>;

function validatePublicPollResponse(
  value: HnsOwnerRecoveryPollResponseV1,
): HnsOwnerRecoveryPollResponseV1 {
  const keys =
    value.status === "rejected"
      ? [
          "route_recovery_id",
          "session_id",
          "generation",
          "status",
          "reason_code",
          "replayed",
          "retry_after_seconds",
          "result_hash",
        ]
      : value.status === "verified"
        ? [
            "route_recovery_id",
            "session_id",
            "generation",
            "status",
            "canonical_route",
            "replayed",
            "retry_after_seconds",
            "result_hash",
          ]
        : [
            "route_recovery_id",
            "session_id",
            "generation",
            "status",
            "replayed",
            "retry_after_seconds",
            "result_hash",
          ];
  assertOrder(value, keys, "HNS owner-recovery public poll response is reordered");
  if (value.status === "verified") {
    assertRoute(value.canonical_route);
    assertOrder(
      value.canonical_route,
      ["family", "root_label", "root_label_display", "path_segment", "href", "app_host"],
      "HNS owner-recovery public canonical route is reordered",
    );
    return decodeSchema(
      PublicPollVerifiedSchema,
      value,
      "HNS owner-recovery public verified response is invalid",
    );
  }
  if (value.status === "rejected") {
    return decodeSchema(
      PublicPollRejectedSchema,
      value,
      "HNS owner-recovery public rejected response is invalid",
    );
  }
  if (value.status === "expired") {
    return decodeSchema(
      PublicPollExpiredSchema,
      value,
      "HNS owner-recovery public expired response is invalid",
    );
  }
  return decodeSchema(
    PublicPollPendingSchema,
    value,
    "HNS owner-recovery public nonterminal response is invalid",
  );
}

export async function hnsOwnerRecoveryPollResponse(
  input: Readonly<{
    readonly session: HnsOwnerRecoveryPersistedSessionV1;
    readonly session_authority: HnsOwnerRecoveryPersistedSessionAuthority;
    readonly outcome:
      | Extract<HnsOwnerRecoveryPollOutcome, { readonly kind: "pending" | "unavailable" }>
      | Readonly<{
          readonly kind: "terminal";
          readonly result: HnsOwnerRecoveryResultHashInput;
        }>;
    readonly replayed?: boolean;
  }>,
): Promise<HnsOwnerRecoveryPollResponseV1> {
  const session = await validateHnsOwnerRecoveryPersistedSession(
    input.session,
    input.session_authority,
  );
  const generation = session.expected_binding_generation + 1;
  if (input.outcome.kind === "pending" || input.outcome.kind === "unavailable") {
    return validatePublicPollResponse({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      generation: session.expected_binding_generation,
      status: input.outcome.kind,
      replayed: false,
      retry_after_seconds: input.outcome.retry_after_seconds,
      result_hash: null,
    });
  }
  const result = input.outcome.result;
  const resultHash = await hnsOwnerRecoveryResultHash(result);
  if (
    result.route_recovery_id !== session.route_recovery_id ||
    result.session_id !== session.session_id ||
    result.route_binding_id !== session.route_binding_id ||
    result.expected_binding_generation !== session.expected_binding_generation
  ) {
    throw new HnsOwnerRecoveryDecodeError(
      "Terminal recovery result does not match persisted session authority",
    );
  }
  const replayed = input.replayed ?? false;
  if (result.outcome_status === "verified") {
    return validatePublicPollResponse({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      generation,
      status: "verified",
      canonical_route: session.route,
      replayed,
      retry_after_seconds: null,
      result_hash: resultHash,
    });
  }
  const outcomeStatus = result.outcome_status;
  if (outcomeStatus === "session_expired") {
    return validatePublicPollResponse({
      route_recovery_id: session.route_recovery_id,
      session_id: session.session_id,
      generation,
      status: "expired",
      replayed,
      retry_after_seconds: null,
      result_hash: resultHash,
    });
  }
  if (
    outcomeStatus !== "root_absent" &&
    outcomeStatus !== "root_inactive" &&
    outcomeStatus !== "expiry_horizon_insufficient"
  ) {
    throw new HnsOwnerRecoveryDecodeError("Stale recovery has no public terminal response");
  }
  return validatePublicPollResponse({
    route_recovery_id: session.route_recovery_id,
    session_id: session.session_id,
    generation,
    status: "rejected",
    reason_code:
      outcomeStatus === "expiry_horizon_insufficient" ? "expiry_insufficient" : "root_unavailable",
    replayed,
    retry_after_seconds: null,
    result_hash: resultHash,
  });
}
