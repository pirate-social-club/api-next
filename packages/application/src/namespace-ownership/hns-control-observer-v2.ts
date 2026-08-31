import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Predicate, Schema } from "effect";
import {
  decodeHnsControlObservationResultBytes,
  deriveHnsEvidenceLease,
  HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES,
  HNS_CONTROL_OBSERVATION_RESULT_VERSION,
  type HnsControlObservationDecodedResult,
  type HnsControlObservationRequestV1,
  type HnsControlObservationUnavailableReason,
  type HnsEvidenceLeasePolicy,
  hnsControlIdentityDigest,
  hnsControlObservationRequestHash,
} from "./hns-control-observer.ts";
import {
  HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION,
  HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION,
} from "./hns-control-observer-configuration.ts";
import {
  HNS_CONTROL_OBSERVER_SNAPSHOT_REFERENCE_MAX_BYTES,
  HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_ENTRIES,
  type HnsControlObserverReservationInput,
  type HnsControlObserverReservationOutcome,
  type HnsControlObserverSnapshotFinalizeOutcome,
  type HnsControlObserverTranscriptEntryV1,
  hnsControlObserverTranscriptByteLength,
  isHnsControlObserverSnapshotReference,
} from "./hns-control-observer-store.ts";
import {
  decodeStrictHnsJsonBytes,
  HNS_OWNER_EVIDENCE_PREIMAGE_VERSION,
  HNS_OWNER_PROVIDER_ID,
  HnsOwnerResponseDecodeError,
  type HnsOwnershipEvidenceEnvelope,
  type HnsOwnershipEvidenceInput,
  type HnsOwnershipEvidencePreimageInput,
  hnsNamespaceStartHash,
  hnsOwnerChallengeName,
  hnsOwnerChallengeValue,
  hnsOwnerChallengeValueSha256,
  hnsOwnershipEvidencePreimage,
  hnsProviderIdentityDigest,
  sha256Utf8,
} from "./hns-evidence.ts";

export const HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION =
  "pirate-hns-control-observation-result-v2" as const;
export const HNS_TARGET_OBSERVATION_V3_VERSION = "pirate-hns-target-observation-v3" as const;
export const HNS_CONTROL_OBSERVER_TRANSCRIPT_MANIFEST_V2_VERSION =
  "pirate-hns-control-observer-transcript-manifest-v2" as const;
export const HNS_CONTROL_OBSERVER_SNAPSHOT_V2_VERSION =
  "pirate-hns-control-observer-snapshot-v2" as const;
export const HNS_CREATION_SOURCE_INELIGIBLE_RESULT_V2_VERSION =
  "pirate-hns-terminal-result-v2" as const;
export const HNS_OWNER_RECOVERY_SOURCE_INELIGIBLE_RESULT_V2_VERSION =
  "pirate-hns-owner-recovery-result-v2" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_INELIGIBLE_RESPONSE_V2_VERSION =
  "pirate-hns-active-lease-renewal-response-v2" as const;
export const HNS_ACTIVE_LEASE_RENEWAL_SOURCE_INELIGIBLE_RESULT_V3_VERSION =
  "pirate-hns-active-lease-renewal-result-v3" as const;

const exactParseOptions = { onExcessProperty: "error" } as const;
const encoder = new TextEncoder();
const sourceValues = ["hns_parent_chain_txt", "owner_authoritative_dns_txt"] as const;
const unavailableReasonValues = [
  "chain_transport_unavailable",
  "chain_unsynchronized",
  "chain_view_stale",
  "chain_view_changed",
  "chain_response_invalid",
  "authority_inventory_unavailable",
  "authoritative_dns_timeout",
  "authoritative_dns_servfail",
  "authoritative_dns_insecure",
  "authoritative_dns_inconclusive",
  "observer_capacity",
  "observer_internal_error",
] as const;
const rejectedReasonValues = [
  "root_absent",
  "root_inactive",
  "txt_absent",
  "txt_value_mismatch",
  "expiry_horizon_insufficient",
] as const;
const targetRejectedReasonValues = [
  "root_absent",
  "root_inactive",
  "expiry_horizon_insufficient",
] as const;
const registryReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

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
      value.trim() === value && isSafeText(value) && utf8Length(value) <= maxBytes
        ? undefined
        : `Expected ${label} to be bounded canonical UTF-8`,
    ),
  );
}

const Identifier = boundedString(256, "identifier");
const ConfigurationReference = boundedString(512, "configuration reference");
const RegistryReference = boundedString(256, "registry reference").check(
  Schema.makeFilter((value) =>
    registryReferencePattern.test(value) ? undefined : "Expected a canonical registry reference",
  ),
);
const RootLabel = boundedString(63, "root label").check(
  Schema.makeFilter((value) =>
    validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
  ),
);
const TxtName = boundedString(255, "TXT name");
const SnapshotReference = boundedString(
  HNS_CONTROL_OBSERVER_SNAPSHOT_REFERENCE_MAX_BYTES,
  "snapshot reference",
).check(
  Schema.makeFilter((value) =>
    isHnsControlObserverSnapshotReference(value)
      ? undefined
      : "Expected a canonical observer snapshot reference",
  ),
);
const NonNegativeSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a non-negative safe integer",
  ),
);
const PositiveRetrySeconds = Schema.Int.check(
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

const VerifiedV2Schema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256Hex,
  status: Schema.Literal("verified"),
  provider_id: Identifier,
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: Sha256Hex,
  environment: Identifier,
  ownership_source: Schema.Literals(sourceValues),
  root_label: RootLabel,
  txt_name: TxtName,
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: Identifier,
  chain_genesis_block_hash: Sha256Hex,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  observer_snapshot_sha256: Sha256Hex,
  provider_evidence_ref: SnapshotReference,
});

const RejectedV2Schema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256Hex,
  status: Schema.Literal("rejected"),
  reason_code: Schema.Literals(rejectedReasonValues),
  provider_id: Identifier,
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: Sha256Hex,
  environment: Identifier,
  ownership_source: Schema.Literals(sourceValues),
  root_label: RootLabel,
  txt_name: TxtName,
  expected_txt_value_sha256: Sha256Hex,
  observed_txt_values_digest: Schema.NullOr(Sha256Hex),
  chain_authority_digest: Sha256Hex,
  chain_network: Identifier,
  chain_genesis_block_hash: Sha256Hex,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: Schema.NullOr(NonNegativeSafeInteger),
  observer_snapshot_sha256: Sha256Hex,
  provider_evidence_ref: SnapshotReference,
});

const UnavailableV2Schema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256Hex,
  status: Schema.Literal("unavailable"),
  reason_code: Schema.Literals(unavailableReasonValues),
  retry_after_seconds: Schema.NullOr(PositiveRetrySeconds),
  observer_snapshot_sha256: Sha256Hex,
  diagnostic_ref: SnapshotReference,
});

const IneligibleV2Schema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256Hex,
  status: Schema.Literal("ineligible"),
  reason_code: Schema.Literal("owner_authoritative_source_ineligible"),
  provider_id: Identifier,
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: Sha256Hex,
  environment: Identifier,
  ownership_source: Schema.Literal("owner_authoritative_dns_txt"),
  root_label: RootLabel,
  txt_name: TxtName,
  expected_txt_value_sha256: Sha256Hex,
  chain_authority_digest: Sha256Hex,
  chain_network: Identifier,
  chain_genesis_block_hash: Sha256Hex,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256Hex,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  authority_inventory_reference: RegistryReference,
  authority_inventory_version: Identifier,
  authority_inventory_digest: Sha256Hex,
  observer_snapshot_sha256: Sha256Hex,
  diagnostic_ref: SnapshotReference,
});

export type HnsControlObservationVerifiedV2 = Schema.Schema.Type<typeof VerifiedV2Schema>;
export type HnsControlObservationRejectedV2 = Schema.Schema.Type<typeof RejectedV2Schema>;
export type HnsControlObservationUnavailableV2 = Schema.Schema.Type<typeof UnavailableV2Schema>;
export type HnsControlObservationIneligibleV2 = Schema.Schema.Type<typeof IneligibleV2Schema>;
export type HnsControlObservationResultV2 =
  | HnsControlObservationVerifiedV2
  | HnsControlObservationRejectedV2
  | HnsControlObservationUnavailableV2
  | HnsControlObservationIneligibleV2;

export type HnsControlObservationDecodedResultV2 = Readonly<{
  readonly result_bytes: Uint8Array;
  readonly result: HnsControlObservationResultV2;
  readonly result_sha256: Sha256HexValue;
}>;

export type HnsControlObservationCompatibleDecodedResult =
  | HnsControlObservationDecodedResult
  | HnsControlObservationDecodedResultV2;

export class HnsControlObservationV2DecodeError extends HnsOwnerResponseDecodeError {
  readonly name = "HnsControlObservationV2DecodeError";
}

const verifiedV2Keys = [
  "version",
  "observation_id",
  "request_sha256",
  "status",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "provider_configuration_digest",
  "environment",
  "ownership_source",
  "root_label",
  "txt_name",
  "expected_txt_value_sha256",
  "control_identity_digest",
  "chain_authority_digest",
  "root_exists",
  "root_control_verified",
  "expiry_horizon_sufficient",
  "chain_network",
  "chain_genesis_block_hash",
  "chain_anchor_height",
  "chain_anchor_block_hash",
  "chain_anchor_median_time",
  "expiry_height",
  "observer_snapshot_sha256",
  "provider_evidence_ref",
] as const;
const rejectedV2Keys = [
  "version",
  "observation_id",
  "request_sha256",
  "status",
  "reason_code",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "provider_configuration_digest",
  "environment",
  "ownership_source",
  "root_label",
  "txt_name",
  "expected_txt_value_sha256",
  "observed_txt_values_digest",
  "chain_authority_digest",
  "chain_network",
  "chain_genesis_block_hash",
  "chain_anchor_height",
  "chain_anchor_block_hash",
  "chain_anchor_median_time",
  "expiry_height",
  "observer_snapshot_sha256",
  "provider_evidence_ref",
] as const;
const unavailableV2Keys = [
  "version",
  "observation_id",
  "request_sha256",
  "status",
  "reason_code",
  "retry_after_seconds",
  "observer_snapshot_sha256",
  "diagnostic_ref",
] as const;
const ineligibleV2Keys = [
  "version",
  "observation_id",
  "request_sha256",
  "status",
  "reason_code",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "provider_configuration_digest",
  "environment",
  "ownership_source",
  "root_label",
  "txt_name",
  "expected_txt_value_sha256",
  "chain_authority_digest",
  "chain_network",
  "chain_genesis_block_hash",
  "chain_anchor_height",
  "chain_anchor_block_hash",
  "chain_anchor_median_time",
  "expiry_height",
  "authority_inventory_reference",
  "authority_inventory_version",
  "authority_inventory_digest",
  "observer_snapshot_sha256",
  "diagnostic_ref",
] as const;

function decodeSchema<T>(schema: Schema.ConstraintDecoder<T>, value: unknown, message: string): T {
  const decoded = Schema.decodeUnknownOption(schema, exactParseOptions)(value);
  if (Option.isNone(decoded)) throw new HnsControlObservationV2DecodeError(message);
  return decoded.value;
}

function assertObjectOrder(value: unknown, keys: ReadonlyArray<string>, label: string): void {
  if (!Predicate.isObject(value) || Array.isArray(value)) {
    throw new HnsControlObservationV2DecodeError(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new HnsControlObservationV2DecodeError(`${label} members are reordered`);
  }
}

async function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Schema.decodeUnknownSync(Sha256Hex)(
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function copyResultBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new HnsControlObservationV2DecodeError("Observer result must be exact bytes");
  }
  if (value.byteLength === 0 || value.byteLength > HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES) {
    throw new HnsControlObservationV2DecodeError("Observer result exceeds its byte bound");
  }
  return new Uint8Array(value);
}

function assertSourceName(result: HnsControlObservationResultV2): void {
  if (result.status === "unavailable") return;
  const expected =
    result.ownership_source === "hns_parent_chain_txt"
      ? result.root_label
      : `_pirate.${result.root_label}`;
  if (result.txt_name !== expected || result.txt_name.endsWith(".")) {
    throw new HnsControlObservationV2DecodeError("Observer result source and TXT name disagree");
  }
}

function assertRejectedMatrix(result: HnsControlObservationRejectedV2): void {
  const hasTxtDigest = result.observed_txt_values_digest !== null;
  const hasExpiry = result.expiry_height !== null;
  const valid =
    result.reason_code === "root_absent"
      ? !hasTxtDigest && !hasExpiry
      : result.reason_code === "root_inactive"
        ? !hasTxtDigest
        : result.reason_code === "txt_absent"
          ? !hasTxtDigest && hasExpiry
          : hasTxtDigest && hasExpiry;
  if (!valid) {
    throw new HnsControlObservationV2DecodeError(
      "Observer rejection facts do not match the reason code",
    );
  }
}

async function assertRequestBinding(
  request: HnsControlObservationRequestV1,
  result: HnsControlObservationResultV2,
): Promise<void> {
  const requestHash = await hnsControlObservationRequestHash(request);
  if (result.observation_id !== request.observation_id || result.request_sha256 !== requestHash) {
    throw new HnsControlObservationV2DecodeError("Observer result does not bind its request");
  }
  if (result.status === "unavailable") return;
  if (
    result.provider_id !== request.provider_id ||
    result.provider_configuration_reference !== request.provider_configuration_reference ||
    result.provider_configuration_version !== request.provider_configuration_version ||
    result.provider_configuration_digest !== request.provider_configuration_digest ||
    result.environment !== request.environment ||
    result.ownership_source !== request.ownership_source ||
    result.root_label !== request.root_label ||
    result.txt_name !== request.txt_name
  ) {
    throw new HnsControlObservationV2DecodeError("Observer result does not echo request authority");
  }
  const expectedTxtHash = await sha256Utf8(request.expected_txt_value);
  if (result.expected_txt_value_sha256 !== expectedTxtHash) {
    throw new HnsControlObservationV2DecodeError("Observer result TXT hash disagrees with request");
  }
  if (result.status === "verified") {
    const controlIdentityDigest = await hnsControlIdentityDigest({
      ownership_source: request.ownership_source,
      txt_name: request.txt_name,
      expected_txt_value: request.expected_txt_value,
      root_label: request.root_label,
      chain_authority_digest: result.chain_authority_digest,
    });
    if (result.control_identity_digest !== controlIdentityDigest) {
      throw new HnsControlObservationV2DecodeError(
        "Observer result control identity disagrees with request",
      );
    }
  }
}

export async function decodeHnsControlObservationResultV2Bytes(
  value: unknown,
  expectedRequest?: HnsControlObservationRequestV1,
): Promise<HnsControlObservationDecodedResultV2> {
  const resultBytes = copyResultBytes(value);
  let json: unknown;
  try {
    json = decodeStrictHnsJsonBytes(resultBytes, HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsControlObservationV2DecodeError(error.message);
    }
    throw error;
  }
  const status =
    Predicate.isObject(json) && !Array.isArray(json)
      ? (json as Readonly<Record<string, unknown>>).status
      : undefined;
  let result: HnsControlObservationResultV2;
  if (status === "verified") {
    assertObjectOrder(json, verifiedV2Keys, "Observer result-v2");
    result = decodeSchema(VerifiedV2Schema, json, "Observer verified result-v2 is invalid");
  } else if (status === "rejected") {
    assertObjectOrder(json, rejectedV2Keys, "Observer result-v2");
    result = decodeSchema(RejectedV2Schema, json, "Observer rejected result-v2 is invalid");
  } else if (status === "ineligible") {
    assertObjectOrder(json, ineligibleV2Keys, "Observer result-v2");
    result = decodeSchema(IneligibleV2Schema, json, "Observer ineligible result-v2 is invalid");
  } else {
    assertObjectOrder(json, unavailableV2Keys, "Observer result-v2");
    result = decodeSchema(UnavailableV2Schema, json, "Observer unavailable result-v2 is invalid");
  }
  if (result.status === "rejected") assertRejectedMatrix(result);
  assertSourceName(result);
  if (expectedRequest !== undefined) await assertRequestBinding(expectedRequest, result);
  return {
    result_bytes: resultBytes,
    result,
    result_sha256: await sha256Bytes(resultBytes),
  };
}

export async function encodeHnsControlObservationResultV2(
  result: HnsControlObservationResultV2,
  expectedRequest?: HnsControlObservationRequestV1,
): Promise<Uint8Array> {
  return (
    await decodeHnsControlObservationResultV2Bytes(
      encoder.encode(JSON.stringify(result)),
      expectedRequest,
    )
  ).result_bytes;
}

export function promoteHnsControlObservationResultV1ToV2(
  result: HnsControlObservationDecodedResult["result"],
  observerSnapshotSha256: Sha256HexValue,
): HnsControlObservationResultV2 {
  if (result.status === "verified") {
    return {
      version: HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
      observation_id: result.observation_id,
      request_sha256: result.request_sha256,
      status: result.status,
      provider_id: result.provider_id,
      provider_configuration_reference: result.provider_configuration_reference,
      provider_configuration_version: result.provider_configuration_version,
      provider_configuration_digest: result.provider_configuration_digest,
      environment: result.environment,
      ownership_source: result.ownership_source,
      root_label: result.root_label,
      txt_name: result.txt_name,
      expected_txt_value_sha256: result.expected_txt_value_sha256,
      control_identity_digest: result.control_identity_digest,
      chain_authority_digest: result.chain_authority_digest,
      root_exists: result.root_exists,
      root_control_verified: result.root_control_verified,
      expiry_horizon_sufficient: result.expiry_horizon_sufficient,
      chain_network: result.chain_network,
      chain_genesis_block_hash: result.chain_genesis_block_hash,
      chain_anchor_height: result.chain_anchor_height,
      chain_anchor_block_hash: result.chain_anchor_block_hash,
      chain_anchor_median_time: result.chain_anchor_median_time,
      expiry_height: result.expiry_height,
      observer_snapshot_sha256: observerSnapshotSha256,
      provider_evidence_ref: result.provider_evidence_ref,
    };
  }
  if (result.status === "rejected") {
    return {
      version: HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
      observation_id: result.observation_id,
      request_sha256: result.request_sha256,
      status: result.status,
      reason_code: result.reason_code,
      provider_id: result.provider_id,
      provider_configuration_reference: result.provider_configuration_reference,
      provider_configuration_version: result.provider_configuration_version,
      provider_configuration_digest: result.provider_configuration_digest,
      environment: result.environment,
      ownership_source: result.ownership_source,
      root_label: result.root_label,
      txt_name: result.txt_name,
      expected_txt_value_sha256: result.expected_txt_value_sha256,
      observed_txt_values_digest: result.observed_txt_values_digest,
      chain_authority_digest: result.chain_authority_digest,
      chain_network: result.chain_network,
      chain_genesis_block_hash: result.chain_genesis_block_hash,
      chain_anchor_height: result.chain_anchor_height,
      chain_anchor_block_hash: result.chain_anchor_block_hash,
      chain_anchor_median_time: result.chain_anchor_median_time,
      expiry_height: result.expiry_height,
      observer_snapshot_sha256: observerSnapshotSha256,
      provider_evidence_ref: result.provider_evidence_ref,
    };
  }
  return {
    version: HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION,
    observation_id: result.observation_id,
    request_sha256: result.request_sha256,
    status: result.status,
    reason_code: result.reason_code,
    retry_after_seconds: result.retry_after_seconds,
    observer_snapshot_sha256: observerSnapshotSha256,
    diagnostic_ref: result.diagnostic_ref,
  };
}

export async function decodeHnsControlObservationCompatibleResultBytes(
  value: unknown,
  expectedRequest: HnsControlObservationRequestV1,
  configurationVersion:
    | typeof HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION
    | typeof HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION,
): Promise<HnsControlObservationCompatibleDecodedResult> {
  const bytes = copyResultBytes(value);
  const json = decodeStrictHnsJsonBytes(bytes, HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES);
  const version =
    Predicate.isObject(json) && !Array.isArray(json)
      ? (json as Readonly<Record<string, unknown>>).version
      : undefined;
  if (
    configurationVersion === HNS_CONTROL_OBSERVER_CONFIGURATION_VERSION &&
    version === HNS_CONTROL_OBSERVATION_RESULT_VERSION
  ) {
    return decodeHnsControlObservationResultBytes(bytes, expectedRequest);
  }
  if (
    configurationVersion === HNS_CONTROL_OBSERVER_CONFIGURATION_V2_VERSION &&
    version === HNS_CONTROL_OBSERVATION_RESULT_V2_VERSION
  ) {
    return decodeHnsControlObservationResultV2Bytes(bytes, expectedRequest);
  }
  throw new HnsControlObservationV2DecodeError(
    "Observer configuration and result versions cannot cross-decode",
  );
}

export type HnsControlObserverTranscriptManifestEntryV2 = readonly [
  driver_reference: string,
  ownership_source: (typeof sourceValues)[number],
  method_or_view_id: string,
  request_sha256: Sha256HexValue,
  transport_outcome: "response" | "timeout" | "transport_error" | "aborted",
  transport_status: number | null,
  response_sha256: Sha256HexValue | null,
];

export function hnsControlObserverTranscriptManifestV2(
  transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>,
): ReadonlyArray<HnsControlObserverTranscriptManifestEntryV2> {
  if (transcript.length > HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_ENTRIES) {
    throw new TypeError("Observer transcript exceeds its manifest entry bound");
  }
  return transcript.map((entry) => [
    entry.driver_reference,
    entry.ownership_source,
    entry.method_or_view_id,
    entry.request_sha256,
    entry.transport_outcome,
    entry.transport_status,
    entry.response_sha256,
  ]);
}

export function hnsControlObserverTranscriptManifestPreimageV2(
  entries: ReadonlyArray<HnsControlObserverTranscriptManifestEntryV2>,
): string {
  if (entries.length > HNS_CONTROL_OBSERVER_TRANSCRIPT_MAX_ENTRIES) {
    throw new TypeError("Observer transcript manifest exceeds its entry bound");
  }
  for (const entry of entries) {
    if (
      entry.length !== 7 ||
      !isSafeText(entry[0]) ||
      !isSafeText(entry[2]) ||
      Option.isNone(Schema.decodeUnknownOption(Sha256Hex)(entry[3])) ||
      !sourceValues.includes(entry[1]) ||
      !["response", "timeout", "transport_error", "aborted"].includes(entry[4]) ||
      (entry[4] === "response") !== (entry[6] !== null) ||
      (entry[4] === "response" &&
        entry[5] !== null &&
        (!Number.isSafeInteger(entry[5]) || entry[5] < 100 || entry[5] > 599)) ||
      (entry[4] !== "response" && entry[5] !== null) ||
      (entry[6] !== null && Option.isNone(Schema.decodeUnknownOption(Sha256Hex)(entry[6])))
    ) {
      throw new TypeError("Observer transcript manifest entry is invalid");
    }
  }
  return JSON.stringify([HNS_CONTROL_OBSERVER_TRANSCRIPT_MANIFEST_V2_VERSION, entries]);
}

export function hnsControlObserverTranscriptManifestDigestV2(
  entries: ReadonlyArray<HnsControlObserverTranscriptManifestEntryV2>,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsControlObserverTranscriptManifestPreimageV2(entries));
}

export type HnsControlObserverSnapshotManifestV2Input = Readonly<{
  readonly observation_id: string;
  readonly request_sha256: Sha256HexValue;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly authority_inventory_reference_or_null: string | null;
  readonly authority_inventory_version_or_null: string | null;
  readonly authority_inventory_digest_or_null: Sha256HexValue | null;
  readonly reservation_database_time: string;
  readonly snapshot_reference: string;
  readonly transcript_manifest_sha256: Sha256HexValue;
  readonly semantic_facts_sha256: Sha256HexValue;
}>;

function assertSnapshotManifest(input: HnsControlObserverSnapshotManifestV2Input): void {
  decodeSchema(Identifier, input.observation_id, "Snapshot observation id is invalid");
  decodeSchema(Sha256Hex, input.request_sha256, "Snapshot request digest is invalid");
  decodeSchema(
    Sha256Hex,
    input.provider_configuration_digest,
    "Snapshot configuration digest is invalid",
  );
  decodeSchema(CanonicalInstant, input.reservation_database_time, "Snapshot time is invalid");
  decodeSchema(SnapshotReference, input.snapshot_reference, "Snapshot reference is invalid");
  decodeSchema(
    Sha256Hex,
    input.transcript_manifest_sha256,
    "Snapshot transcript digest is invalid",
  );
  decodeSchema(Sha256Hex, input.semantic_facts_sha256, "Snapshot facts digest is invalid");
  const inventoryMembers = [
    input.authority_inventory_reference_or_null,
    input.authority_inventory_version_or_null,
    input.authority_inventory_digest_or_null,
  ];
  if (
    !inventoryMembers.every((value) => value === null) &&
    inventoryMembers.some((value) => value === null)
  ) {
    throw new TypeError("Snapshot inventory identity is a partial nullable tuple");
  }
  if (input.authority_inventory_reference_or_null !== null) {
    decodeSchema(
      RegistryReference,
      input.authority_inventory_reference_or_null,
      "Snapshot inventory reference is invalid",
    );
    decodeSchema(
      Identifier,
      input.authority_inventory_version_or_null,
      "Snapshot inventory version is invalid",
    );
    decodeSchema(
      Sha256Hex,
      input.authority_inventory_digest_or_null,
      "Snapshot inventory digest is invalid",
    );
  }
}

export function hnsControlObserverSnapshotPreimageV2(
  input: HnsControlObserverSnapshotManifestV2Input,
): string {
  assertSnapshotManifest(input);
  return JSON.stringify([
    HNS_CONTROL_OBSERVER_SNAPSHOT_V2_VERSION,
    input.observation_id,
    input.request_sha256,
    input.provider_configuration_digest,
    input.authority_inventory_reference_or_null,
    input.authority_inventory_version_or_null,
    input.authority_inventory_digest_or_null,
    input.reservation_database_time,
    input.snapshot_reference,
    input.transcript_manifest_sha256,
    input.semantic_facts_sha256,
  ]);
}

export function hnsControlObserverSnapshotDigestV2(
  input: HnsControlObserverSnapshotManifestV2Input,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsControlObserverSnapshotPreimageV2(input));
}

export type HnsControlObserverSnapshotLogicalPayloadV2 = Readonly<{
  readonly observation_id: string;
  readonly observer_fence: number;
  readonly reservation_database_time: string;
  readonly lease_expires_at: string;
  readonly request_bytes: Uint8Array;
  readonly request_sha256: Sha256HexValue;
  readonly configuration_bytes: Uint8Array;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly authority_inventory_bytes: Uint8Array | null;
  readonly authority_inventory_reference_or_null: string | null;
  readonly authority_inventory_version_or_null: string | null;
  readonly authority_inventory_digest_or_null: Sha256HexValue | null;
  readonly snapshot_reference: string;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
  readonly transcript_manifest_sha256: Sha256HexValue;
  readonly semantic_facts_bytes: Uint8Array;
  readonly semantic_facts_sha256: Sha256HexValue;
  readonly observer_snapshot_sha256: Sha256HexValue;
  readonly result_status: "verified" | "rejected" | "unavailable" | "ineligible";
  readonly result_reference_kind: "provider_evidence_ref" | "diagnostic_ref";
  readonly result_bytes: Uint8Array;
  readonly result_sha256: Sha256HexValue;
}>;

export type HnsControlObserverSnapshotFinalizeInputV2 = Readonly<{
  readonly observation_id: string;
  readonly observer_fence: number;
  readonly request_sha256: Sha256HexValue;
  readonly provider_configuration_digest: Sha256HexValue;
  readonly snapshot_reference: string;
  readonly authority_inventory_bytes: Uint8Array | null;
  readonly authority_inventory_reference_or_null: string | null;
  readonly authority_inventory_version_or_null: string | null;
  readonly authority_inventory_digest_or_null: Sha256HexValue | null;
  readonly transcript: ReadonlyArray<HnsControlObserverTranscriptEntryV1>;
  readonly transcript_manifest_sha256: Sha256HexValue;
  readonly semantic_facts_bytes: Uint8Array;
  readonly semantic_facts_sha256: Sha256HexValue;
  readonly observer_snapshot_sha256: Sha256HexValue;
  readonly result_bytes: Uint8Array;
  readonly result_sha256: Sha256HexValue;
}>;

export type HnsControlObserverSnapshotStorePortV2 = Readonly<{
  readonly reserve: (
    input: HnsControlObserverReservationInput,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<HnsControlObserverReservationOutcome>;
  readonly finalize: (
    input: HnsControlObserverSnapshotFinalizeInputV2,
    options: Readonly<{ readonly deadline_ms: number; readonly signal: AbortSignal }>,
  ) => Promise<HnsControlObserverSnapshotFinalizeOutcome>;
}>;

function assertInventoryAccountingTuple(input: HnsControlObserverSnapshotLogicalPayloadV2): void {
  const hasBytes = input.authority_inventory_bytes !== null;
  const hasReference = input.authority_inventory_reference_or_null !== null;
  const hasVersion = input.authority_inventory_version_or_null !== null;
  const hasDigest = input.authority_inventory_digest_or_null !== null;
  if (!(hasBytes === hasReference && hasReference === hasVersion && hasVersion === hasDigest)) {
    throw new TypeError("Snapshot inventory accounting is a partial nullable tuple");
  }
  if (
    (input.result_status === "ineligible" && !hasBytes) ||
    (input.result_status === "ineligible" && input.result_reference_kind !== "diagnostic_ref") ||
    ((input.result_status === "verified" || input.result_status === "rejected") &&
      input.result_reference_kind !== "provider_evidence_ref") ||
    (input.result_status === "unavailable" && input.result_reference_kind !== "diagnostic_ref")
  ) {
    throw new TypeError("Snapshot result and inventory accounting matrix is invalid");
  }
}

export function hnsControlObserverSnapshotAccountingEnvelopeV2Bytes(
  input: HnsControlObserverSnapshotLogicalPayloadV2,
): Uint8Array {
  assertInventoryAccountingTuple(input);
  const envelope = {
    observation_id: input.observation_id,
    observer_fence: input.observer_fence,
    reservation_database_time: input.reservation_database_time,
    lease_expires_at: input.lease_expires_at,
    request_bytes: input.request_bytes.byteLength,
    request_sha256: input.request_sha256,
    configuration_bytes: input.configuration_bytes.byteLength,
    provider_configuration_digest: input.provider_configuration_digest,
    authority_inventory_bytes: input.authority_inventory_bytes?.byteLength ?? null,
    authority_inventory_reference_or_null: input.authority_inventory_reference_or_null,
    authority_inventory_version_or_null: input.authority_inventory_version_or_null,
    authority_inventory_digest_or_null: input.authority_inventory_digest_or_null,
    snapshot_reference: input.snapshot_reference,
    transcript: input.transcript.map((entry) => ({
      driver_reference: entry.driver_reference,
      ownership_source: entry.ownership_source,
      method_or_view_id: entry.method_or_view_id,
      request_bytes: entry.request_bytes.byteLength,
      request_sha256: entry.request_sha256,
      transport_outcome: entry.transport_outcome,
      transport_status: entry.transport_status,
      response_bytes: entry.response_bytes?.byteLength ?? null,
      response_sha256: entry.response_sha256,
    })),
    transcript_entry_count: input.transcript.length,
    transcript_byte_length: hnsControlObserverTranscriptByteLength(input.transcript),
    semantic_facts_bytes: input.semantic_facts_bytes.byteLength,
    semantic_facts_sha256: input.semantic_facts_sha256,
    transcript_manifest_sha256: input.transcript_manifest_sha256,
    observer_snapshot_sha256: input.observer_snapshot_sha256,
    result_status: input.result_status,
    result_reference_kind: input.result_reference_kind,
    result_reference: input.snapshot_reference,
    result_bytes: input.result_bytes.byteLength,
    result_sha256: input.result_sha256,
  };
  return encoder.encode(JSON.stringify(envelope));
}

export function hnsControlObserverSnapshotLogicalByteLengthV2(
  input: HnsControlObserverSnapshotLogicalPayloadV2,
): number {
  const raw =
    input.request_bytes.byteLength +
    input.configuration_bytes.byteLength +
    (input.authority_inventory_bytes?.byteLength ?? 0) +
    input.semantic_facts_bytes.byteLength +
    input.result_bytes.byteLength +
    hnsControlObserverTranscriptByteLength(input.transcript);
  const total = raw + hnsControlObserverSnapshotAccountingEnvelopeV2Bytes(input).byteLength;
  return Number.isSafeInteger(total) ? total : Number.POSITIVE_INFINITY;
}

const TargetEvidenceReference = boundedString(512, "target evidence reference");

const TargetVerifiedV3Schema = Schema.Struct({
  status: Schema.Literal("verified"),
  observation_contract_version: Schema.Literal(HNS_TARGET_OBSERVATION_V3_VERSION),
  provider_evidence_ref: TargetEvidenceReference,
  upstream_session_ref: boundedString(16_384, "upstream session reference"),
  ownership_source: Schema.Literals(sourceValues),
  challenge_name: TxtName,
  challenge_value: boundedString(16_384, "challenge value"),
  expected_txt_value_sha256: Sha256Hex,
  control_identity_digest: Sha256Hex,
  chain_authority_digest: Sha256Hex,
  observer_snapshot_sha256: Sha256Hex,
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

const TargetRejectedV3Schema = Schema.Struct({
  status: Schema.Literal("rejected"),
  observation_contract_version: Schema.Literal(HNS_TARGET_OBSERVATION_V3_VERSION),
  reason_code: Schema.Literals(targetRejectedReasonValues),
  observer_snapshot_sha256: Sha256Hex,
  observer_result_sha256: Sha256Hex,
  provider_evidence_ref: TargetEvidenceReference,
});

const TargetPendingV3Schema = Schema.Struct({
  status: Schema.Literal("pending"),
  observation_contract_version: Schema.Literal(HNS_TARGET_OBSERVATION_V3_VERSION),
  reason_code: Schema.Literals(["txt_absent", "txt_value_mismatch"]),
  observer_snapshot_sha256: Sha256Hex,
  observer_result_sha256: Sha256Hex,
  provider_evidence_ref: TargetEvidenceReference,
});

const TargetUnavailableV3Schema = Schema.Struct({
  status: Schema.Literal("unavailable"),
  observation_contract_version: Schema.Literal(HNS_TARGET_OBSERVATION_V3_VERSION),
  reason_code: Schema.Literals(unavailableReasonValues),
  retry_after_seconds: Schema.NullOr(PositiveRetrySeconds),
  observer_snapshot_sha256: Sha256Hex,
  diagnostic_ref: SnapshotReference,
});

export type HnsOwnerTargetVerifiedObservationV3 = Schema.Schema.Type<typeof TargetVerifiedV3Schema>;
export type HnsOwnerTargetRejectedObservationV3 = Schema.Schema.Type<typeof TargetRejectedV3Schema>;
export type HnsOwnerTargetPendingObservationV3 = Schema.Schema.Type<typeof TargetPendingV3Schema>;
export type HnsOwnerTargetUnavailableObservationV3 = Schema.Schema.Type<
  typeof TargetUnavailableV3Schema
>;

const TargetIneligibleV3Schema = Schema.Struct({
  status: Schema.Literal("ineligible"),
  observation_contract_version: Schema.Literal(HNS_TARGET_OBSERVATION_V3_VERSION),
  reason_code: Schema.Literal("owner_authoritative_source_ineligible"),
  ownership_source: Schema.Literal("owner_authoritative_dns_txt"),
  root_label: RootLabel,
  chain_authority_digest: Sha256Hex,
  authority_inventory_reference: RegistryReference,
  authority_inventory_version: Identifier,
  authority_inventory_digest: Sha256Hex,
  observer_snapshot_sha256: Sha256Hex,
  observer_result_sha256: Sha256Hex,
  diagnostic_ref: SnapshotReference,
});

export type HnsOwnerTargetIneligibleObservationV3 = Schema.Schema.Type<
  typeof TargetIneligibleV3Schema
>;

export type HnsOwnerTargetObservationV3 =
  | HnsOwnerTargetVerifiedObservationV3
  | HnsOwnerTargetRejectedObservationV3
  | HnsOwnerTargetPendingObservationV3
  | HnsOwnerTargetUnavailableObservationV3
  | HnsOwnerTargetIneligibleObservationV3;

const targetVerifiedV3Keys = [
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
  "observer_snapshot_sha256",
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
const targetRejectedV3Keys = [
  "status",
  "observation_contract_version",
  "reason_code",
  "observer_snapshot_sha256",
  "observer_result_sha256",
  "provider_evidence_ref",
] as const;
const targetPendingV3Keys = targetRejectedV3Keys;
const targetUnavailableV3Keys = [
  "status",
  "observation_contract_version",
  "reason_code",
  "retry_after_seconds",
  "observer_snapshot_sha256",
  "diagnostic_ref",
] as const;

const targetIneligibleV3Keys = [
  "status",
  "observation_contract_version",
  "reason_code",
  "ownership_source",
  "root_label",
  "chain_authority_digest",
  "authority_inventory_reference",
  "authority_inventory_version",
  "authority_inventory_digest",
  "observer_snapshot_sha256",
  "observer_result_sha256",
  "diagnostic_ref",
] as const;

function assertTargetV3EvidenceReference(
  providerEvidenceRef: string,
  observerResultSha256: Sha256HexValue,
): void {
  const prefix = `hns-observer-v2:sha256:${observerResultSha256}:`;
  if (
    !providerEvidenceRef.startsWith(prefix) ||
    !isHnsControlObserverSnapshotReference(providerEvidenceRef.slice(prefix.length))
  ) {
    throw new HnsControlObservationV2DecodeError(
      "Target-v3 evidence reference does not bind its observer result",
    );
  }
}

async function assertTargetV3Common(response: HnsOwnerTargetObservationV3): Promise<void> {
  if (response.status === "verified") {
    assertTargetV3EvidenceReference(
      response.provider_evidence_ref,
      response.observer_result_sha256,
    );
    if (
      response.challenge_value !== `pirate-verification=${response.upstream_session_ref}` ||
      response.expected_txt_value_sha256 !== (await sha256Utf8(response.challenge_value)) ||
      response.expires_at <= response.observed_at
    ) {
      throw new HnsControlObservationV2DecodeError(
        "Target-v3 verified challenge or evidence time is invalid",
      );
    }
    const expectedName =
      response.ownership_source === "hns_parent_chain_txt"
        ? response.challenge_name
        : response.challenge_name.startsWith("_pirate.")
          ? response.challenge_name
          : null;
    if (expectedName === null) {
      throw new HnsControlObservationV2DecodeError(
        "Target-v3 verified source and challenge name disagree",
      );
    }
    return;
  }
  if (response.status === "rejected" || response.status === "pending") {
    assertTargetV3EvidenceReference(
      response.provider_evidence_ref,
      response.observer_result_sha256,
    );
  }
}

function assertUpstreamChallengeBinding(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly upstream_session_ref: string;
  }>,
): void {
  if (
    input.upstream_session_ref.trim() !== input.upstream_session_ref ||
    input.upstream_session_ref.length === 0 ||
    !isSafeText(input.upstream_session_ref) ||
    utf8Length(input.upstream_session_ref) > 16_384 ||
    input.request.expected_txt_value !== `pirate-verification=${input.upstream_session_ref}`
  ) {
    throw new TypeError("Observer request is not bound to the upstream challenge");
  }
}

export async function mapHnsControlObservationToTargetV3(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly result_bytes: Uint8Array;
    readonly upstream_session_ref: string;
    readonly policy: HnsEvidenceLeasePolicy;
  }>,
): Promise<HnsOwnerTargetObservationV3> {
  assertUpstreamChallengeBinding(input);
  const decoded = await decodeHnsControlObservationResultV2Bytes(input.result_bytes, input.request);
  const result = decoded.result;
  if (result.status === "unavailable") {
    return {
      status: "unavailable",
      observation_contract_version: HNS_TARGET_OBSERVATION_V3_VERSION,
      reason_code: result.reason_code,
      retry_after_seconds: result.retry_after_seconds,
      observer_snapshot_sha256: result.observer_snapshot_sha256,
      diagnostic_ref: result.diagnostic_ref,
    };
  }
  if (result.status === "ineligible") {
    return {
      status: "ineligible",
      observation_contract_version: HNS_TARGET_OBSERVATION_V3_VERSION,
      reason_code: result.reason_code,
      ownership_source: result.ownership_source,
      root_label: result.root_label,
      chain_authority_digest: result.chain_authority_digest,
      authority_inventory_reference: result.authority_inventory_reference,
      authority_inventory_version: result.authority_inventory_version,
      authority_inventory_digest: result.authority_inventory_digest,
      observer_snapshot_sha256: result.observer_snapshot_sha256,
      observer_result_sha256: decoded.result_sha256,
      diagnostic_ref: result.diagnostic_ref,
    };
  }
  const providerEvidenceRef = `hns-observer-v2:sha256:${decoded.result_sha256}:${result.provider_evidence_ref}`;
  if (result.status === "rejected") {
    return result.reason_code === "txt_absent" || result.reason_code === "txt_value_mismatch"
      ? {
          status: "pending",
          observation_contract_version: HNS_TARGET_OBSERVATION_V3_VERSION,
          reason_code: result.reason_code,
          observer_snapshot_sha256: result.observer_snapshot_sha256,
          observer_result_sha256: decoded.result_sha256,
          provider_evidence_ref: providerEvidenceRef,
        }
      : {
          status: "rejected",
          observation_contract_version: HNS_TARGET_OBSERVATION_V3_VERSION,
          reason_code: result.reason_code,
          observer_snapshot_sha256: result.observer_snapshot_sha256,
          observer_result_sha256: decoded.result_sha256,
          provider_evidence_ref: providerEvidenceRef,
        };
  }
  const lease = deriveHnsEvidenceLease(result, input.policy);
  return {
    status: "verified",
    observation_contract_version: HNS_TARGET_OBSERVATION_V3_VERSION,
    provider_evidence_ref: providerEvidenceRef,
    upstream_session_ref: input.upstream_session_ref,
    ownership_source: input.request.ownership_source,
    challenge_name: input.request.txt_name,
    challenge_value: input.request.expected_txt_value,
    expected_txt_value_sha256: await sha256Utf8(input.request.expected_txt_value),
    control_identity_digest: result.control_identity_digest,
    chain_authority_digest: result.chain_authority_digest,
    observer_snapshot_sha256: result.observer_snapshot_sha256,
    observer_result_sha256: decoded.result_sha256,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: result.chain_network,
    chain_anchor_height: result.chain_anchor_height,
    chain_anchor_block_hash: result.chain_anchor_block_hash,
    chain_anchor_median_time: result.chain_anchor_median_time,
    expiry_height: result.expiry_height,
    observed_at: lease.observed_at,
    expires_at: lease.expires_at,
  };
}

export async function mapHnsControlObservationIneligibleToTargetV3(
  input: Readonly<{
    readonly request: HnsControlObservationRequestV1;
    readonly result_bytes: Uint8Array;
  }>,
): Promise<HnsOwnerTargetIneligibleObservationV3> {
  const decoded = await decodeHnsControlObservationResultV2Bytes(input.result_bytes, input.request);
  if (decoded.result.status !== "ineligible") {
    throw new TypeError("Expected an ineligible observer result-v2");
  }
  const result = decoded.result;
  return {
    status: "ineligible",
    observation_contract_version: HNS_TARGET_OBSERVATION_V3_VERSION,
    reason_code: result.reason_code,
    ownership_source: result.ownership_source,
    root_label: result.root_label,
    chain_authority_digest: result.chain_authority_digest,
    authority_inventory_reference: result.authority_inventory_reference,
    authority_inventory_version: result.authority_inventory_version,
    authority_inventory_digest: result.authority_inventory_digest,
    observer_snapshot_sha256: result.observer_snapshot_sha256,
    observer_result_sha256: decoded.result_sha256,
    diagnostic_ref: result.diagnostic_ref,
  };
}

export async function decodeHnsOwnerTargetObservationV3Bytes(value: unknown): Promise<
  Readonly<{
    response: HnsOwnerTargetObservationV3;
    response_bytes: Uint8Array;
    response_sha256: Sha256HexValue;
  }>
> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 1_048_576) {
    throw new HnsControlObservationV2DecodeError("Target-v3 response exceeds its bound");
  }
  const bytes = new Uint8Array(value);
  const json = decodeStrictHnsJsonBytes(bytes, 1_048_576);
  const status =
    Predicate.isObject(json) && !Array.isArray(json)
      ? (json as Readonly<Record<string, unknown>>).status
      : undefined;
  let response: HnsOwnerTargetObservationV3;
  if (status === "verified") {
    assertObjectOrder(json, targetVerifiedV3Keys, "Target verified response-v3");
    response = decodeSchema(TargetVerifiedV3Schema, json, "Target verified response-v3 is invalid");
  } else if (status === "rejected") {
    assertObjectOrder(json, targetRejectedV3Keys, "Target rejected response-v3");
    response = decodeSchema(TargetRejectedV3Schema, json, "Target rejected response-v3 is invalid");
  } else if (status === "pending") {
    assertObjectOrder(json, targetPendingV3Keys, "Target pending response-v3");
    response = decodeSchema(TargetPendingV3Schema, json, "Target pending response-v3 is invalid");
  } else if (status === "unavailable") {
    assertObjectOrder(json, targetUnavailableV3Keys, "Target unavailable response-v3");
    response = decodeSchema(
      TargetUnavailableV3Schema,
      json,
      "Target unavailable response-v3 is invalid",
    );
  } else {
    assertObjectOrder(json, targetIneligibleV3Keys, "Target ineligible response-v3");
    response = decodeSchema(
      TargetIneligibleV3Schema,
      json,
      "Target ineligible response-v3 is invalid",
    );
  }
  await assertTargetV3Common(response);
  return {
    response,
    response_bytes: bytes,
    response_sha256: await sha256Bytes(bytes),
  };
}

export async function buildHnsOwnershipEvidenceFromTargetV3(
  input: HnsOwnershipEvidenceInput,
): Promise<HnsOwnershipEvidenceEnvelope> {
  const decoded = await decodeHnsOwnerTargetObservationV3Bytes(input.raw_response_bytes);
  if (decoded.response.status !== "verified") {
    throw new HnsControlObservationV2DecodeError(
      "Only a verified target-v3 response can produce ownership evidence",
    );
  }
  const observation = decoded.response;
  if (
    input.provider_id !== HNS_OWNER_PROVIDER_ID ||
    input.route.family !== "hns" ||
    input.route.app_host !== null ||
    observation.upstream_session_ref !== input.upstream_session_ref ||
    observation.challenge_name !==
      hnsOwnerChallengeName(observation.ownership_source, input.route.root_label) ||
    observation.challenge_value !== hnsOwnerChallengeValue(input.upstream_session_ref)
  ) {
    throw new HnsControlObservationV2DecodeError(
      "Target-v3 ownership evidence is not bound to its namespace session",
    );
  }
  const expectedControlIdentity = await hnsControlIdentityDigest({
    ownership_source: observation.ownership_source,
    txt_name: observation.challenge_name,
    expected_txt_value: observation.challenge_value,
    root_label: input.route.root_label,
    chain_authority_digest: observation.chain_authority_digest,
  });
  if (observation.control_identity_digest !== expectedControlIdentity) {
    throw new HnsControlObservationV2DecodeError(
      "Target-v3 ownership evidence has inconsistent control authority",
    );
  }
  const expectedRequestHash = await hnsNamespaceStartHash({
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    requirement_hash: input.requirement_hash,
    generation: input.generation,
    provider_id: input.provider_id,
    provider_binding_hash: input.provider_binding_hash,
    provider_configuration: input.provider_configuration,
    protocol_version: input.protocol_version,
    environment: input.environment,
    route: input.route,
  });
  if (input.request_hash !== expectedRequestHash) {
    throw new HnsControlObservationV2DecodeError(
      "Target-v3 ownership evidence request hash is inconsistent",
    );
  }
  const providerIdentityDigest = await hnsProviderIdentityDigest({
    provider_id: input.provider_id,
    provider_configuration_kind: input.provider_configuration.kind,
    provider_configuration_reference: input.provider_configuration.reference,
    provider_configuration_version: input.provider_configuration.version,
    protocol_version: input.protocol_version,
    root_label: input.route.root_label,
  });
  const challengeValueSha256 = await hnsOwnerChallengeValueSha256(input.upstream_session_ref);
  const evidenceInput: HnsOwnershipEvidencePreimageInput = {
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    requirement_hash: input.requirement_hash,
    generation: input.generation,
    provider_id: input.provider_id,
    provider_binding_hash: input.provider_binding_hash,
    provider_configuration: input.provider_configuration,
    protocol_version: input.protocol_version,
    environment: input.environment,
    route: input.route,
    request_hash: input.request_hash,
    upstream_session_ref: observation.upstream_session_ref,
    ownership_source: observation.ownership_source,
    challenge_name: observation.challenge_name,
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
    evidence_ref: input.evidence_ref,
    provider_evidence_ref: observation.provider_evidence_ref,
    observation_sha256: decoded.response_sha256,
    provider_identity_digest: providerIdentityDigest,
    challenge_value_sha256: challengeValueSha256,
  };
  const evidenceDigest = await sha256Utf8(hnsOwnershipEvidencePreimage(evidenceInput));
  return {
    version: HNS_OWNER_EVIDENCE_PREIMAGE_VERSION,
    actor_id: input.actor_id,
    creation_intent_id: input.creation_intent_id,
    requirement: "namespace_ownership",
    requirement_hash: input.requirement_hash,
    ceremony_intent_id: input.ceremony_intent_id,
    generation: input.generation,
    request_hash: input.request_hash,
    provider_id: input.provider_id,
    provider_binding_hash: input.provider_binding_hash,
    provider_configuration_kind: input.provider_configuration.kind,
    provider_configuration_reference: input.provider_configuration.reference,
    provider_configuration_version: input.provider_configuration.version,
    protocol_version: input.protocol_version,
    environment: input.environment,
    family: "hns",
    root_label: input.route.root_label,
    root_label_display: input.route.root_label_display,
    path_segment: input.route.path_segment,
    upstream_session_ref: observation.upstream_session_ref,
    ownership_source: observation.ownership_source,
    challenge_name: observation.challenge_name,
    challenge_value_sha256: challengeValueSha256,
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
    evidence_ref: input.evidence_ref,
    provider_evidence_ref: observation.provider_evidence_ref,
    observation_sha256: decoded.response_sha256,
    provider_identity_digest: providerIdentityDigest,
    evidence_digest: evidenceDigest,
  };
}

export async function encodeHnsOwnerTargetObservationV3(
  input: HnsOwnerTargetObservationV3,
): Promise<Uint8Array> {
  return (await decodeHnsOwnerTargetObservationV3Bytes(encoder.encode(JSON.stringify(input))))
    .response_bytes;
}

export async function decodeHnsOwnerTargetIneligibleObservationV3Bytes(
  value: unknown,
): Promise<
  Readonly<{ response: HnsOwnerTargetIneligibleObservationV3; response_sha256: Sha256HexValue }>
> {
  const decoded = await decodeHnsOwnerTargetObservationV3Bytes(value);
  if (decoded.response.status !== "ineligible") {
    throw new HnsControlObservationV2DecodeError("Expected target ineligible response-v3");
  }
  return {
    response: decoded.response,
    response_sha256: decoded.response_sha256,
  };
}

function strictHashInput(
  value: string,
  schema: Schema.ConstraintDecoder<string>,
  label: string,
): string {
  return decodeSchema(schema, value, `${label} is invalid`);
}

export type HnsCreationSourceIneligibleResultV2Input = Readonly<{
  readonly ceremony_intent_id: string;
  readonly session_id: string;
  readonly expected_revision: number;
  readonly idempotency_key: string;
  readonly completion_request_hash: Sha256HexValue;
  readonly provider_response_sha256: Sha256HexValue;
}>;

export function hnsCreationSourceIneligibleResultV2Preimage(
  input: HnsCreationSourceIneligibleResultV2Input,
): string {
  return JSON.stringify([
    HNS_CREATION_SOURCE_INELIGIBLE_RESULT_V2_VERSION,
    strictHashInput(input.ceremony_intent_id, Identifier, "Ceremony id"),
    strictHashInput(input.session_id, Identifier, "Session id"),
    decodeSchema(NonNegativeSafeInteger, input.expected_revision, "Revision is invalid"),
    strictHashInput(input.idempotency_key, Identifier, "Idempotency key"),
    decodeSchema(Sha256Hex, input.completion_request_hash, "Completion hash is invalid"),
    "rejected",
    "owner_authoritative_source_ineligible",
    null,
    null,
    null,
    decodeSchema(Sha256Hex, input.provider_response_sha256, "Provider response hash is invalid"),
  ]);
}

export function hnsCreationSourceIneligibleResultV2Hash(
  input: HnsCreationSourceIneligibleResultV2Input,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsCreationSourceIneligibleResultV2Preimage(input));
}

export type HnsOwnerRecoverySourceIneligibleResultV2Input = Readonly<{
  readonly route_recovery_id: string;
  readonly session_id: string;
  readonly recovery_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly idempotency_key: string;
  readonly poll_hash: Sha256HexValue;
  readonly provider_response_sha256: Sha256HexValue;
}>;

export function hnsOwnerRecoverySourceIneligibleResultV2Preimage(
  input: HnsOwnerRecoverySourceIneligibleResultV2Input,
): string {
  return JSON.stringify([
    HNS_OWNER_RECOVERY_SOURCE_INELIGIBLE_RESULT_V2_VERSION,
    strictHashInput(input.route_recovery_id, Identifier, "Recovery id"),
    strictHashInput(input.session_id, Identifier, "Session id"),
    strictHashInput(input.recovery_attempt_id, Identifier, "Recovery attempt id"),
    strictHashInput(input.route_binding_id, Identifier, "Route binding id"),
    decodeSchema(
      NonNegativeSafeInteger,
      input.expected_binding_generation,
      "Expected binding generation is invalid",
    ),
    strictHashInput(input.idempotency_key, Identifier, "Idempotency key"),
    decodeSchema(Sha256Hex, input.poll_hash, "Poll hash is invalid"),
    "owner_authoritative_source_ineligible",
    null,
    null,
    decodeSchema(Sha256Hex, input.provider_response_sha256, "Provider response hash is invalid"),
    "disputed",
    "suspended",
  ]);
}

export function hnsOwnerRecoverySourceIneligibleResultV2Hash(
  input: HnsOwnerRecoverySourceIneligibleResultV2Input,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsOwnerRecoverySourceIneligibleResultV2Preimage(input));
}

const RecoveryIneligiblePublicResponseSchema = Schema.Struct({
  route_recovery_id: Identifier,
  session_id: Identifier,
  generation: NonNegativeSafeInteger,
  status: Schema.Literal("rejected"),
  reason_code: Schema.Literal("source_ineligible"),
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});

export type HnsOwnerRecoverySourceIneligiblePublicResponse = Schema.Schema.Type<
  typeof RecoveryIneligiblePublicResponseSchema
>;

const recoveryIneligiblePublicResponseKeys = [
  "route_recovery_id",
  "session_id",
  "generation",
  "status",
  "reason_code",
  "replayed",
  "retry_after_seconds",
  "result_hash",
] as const;

export async function decodeHnsOwnerRecoverySourceIneligiblePublicResponseBytes(
  value: unknown,
): Promise<
  Readonly<{
    response: HnsOwnerRecoverySourceIneligiblePublicResponse;
    response_bytes: Uint8Array;
    response_sha256: Sha256HexValue;
  }>
> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 1_024) {
    throw new HnsControlObservationV2DecodeError(
      "Owner-recovery source-ineligible response exceeds its bound",
    );
  }
  const bytes = new Uint8Array(value);
  const json = decodeStrictHnsJsonBytes(bytes, 1_024);
  assertObjectOrder(
    json,
    recoveryIneligiblePublicResponseKeys,
    "Owner-recovery source-ineligible response",
  );
  return {
    response: decodeSchema(
      RecoveryIneligiblePublicResponseSchema,
      json,
      "Owner-recovery source-ineligible response is invalid",
    ),
    response_bytes: bytes,
    response_sha256: await sha256Bytes(bytes),
  };
}

export async function encodeHnsOwnerRecoverySourceIneligiblePublicResponse(
  input: HnsOwnerRecoverySourceIneligiblePublicResponse,
): Promise<Uint8Array> {
  return (
    await decodeHnsOwnerRecoverySourceIneligiblePublicResponseBytes(
      encoder.encode(JSON.stringify(input)),
    )
  ).response_bytes;
}

const RenewalIneligibleResponseV2Schema = Schema.Struct({
  version: Schema.Literal(HNS_ACTIVE_LEASE_RENEWAL_INELIGIBLE_RESPONSE_V2_VERSION),
  active_lease_renewal_id: Identifier,
  active_lease_renewal_attempt_id: Identifier,
  request_hash: Sha256Hex,
  status: Schema.Literal("ineligible"),
  reason_code: Schema.Literal("owner_authoritative_source_ineligible"),
  observer_snapshot_sha256: Sha256Hex,
  observer_result_sha256: Sha256Hex,
  diagnostic_ref: SnapshotReference,
});

export type HnsActiveLeaseRenewalIneligibleResponseV2 = Schema.Schema.Type<
  typeof RenewalIneligibleResponseV2Schema
>;

const renewalIneligibleResponseV2Keys = [
  "version",
  "active_lease_renewal_id",
  "active_lease_renewal_attempt_id",
  "request_hash",
  "status",
  "reason_code",
  "observer_snapshot_sha256",
  "observer_result_sha256",
  "diagnostic_ref",
] as const;

export async function decodeHnsActiveLeaseRenewalIneligibleResponseV2Bytes(value: unknown): Promise<
  Readonly<{
    response: HnsActiveLeaseRenewalIneligibleResponseV2;
    response_bytes: Uint8Array;
    response_sha256: Sha256HexValue;
  }>
> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 1_048_576) {
    throw new HnsControlObservationV2DecodeError(
      "Renewal source-ineligible response-v2 exceeds its bound",
    );
  }
  const bytes = new Uint8Array(value);
  const json = decodeStrictHnsJsonBytes(bytes, 1_048_576);
  assertObjectOrder(json, renewalIneligibleResponseV2Keys, "Renewal source-ineligible response-v2");
  return {
    response: decodeSchema(
      RenewalIneligibleResponseV2Schema,
      json,
      "Renewal ineligible response-v2 is invalid",
    ),
    response_bytes: bytes,
    response_sha256: await sha256Bytes(bytes),
  };
}

export async function encodeHnsActiveLeaseRenewalIneligibleResponseV2(
  input: HnsActiveLeaseRenewalIneligibleResponseV2,
): Promise<Uint8Array> {
  return (
    await decodeHnsActiveLeaseRenewalIneligibleResponseV2Bytes(
      encoder.encode(JSON.stringify(input)),
    )
  ).response_bytes;
}

export type HnsActiveLeaseRenewalSourceIneligibleResultV3Input = Readonly<{
  readonly active_lease_renewal_id: string;
  readonly active_lease_renewal_attempt_id: string;
  readonly route_binding_id: string;
  readonly expected_binding_generation: number;
  readonly idempotency_key: string;
  readonly request_hash: Sha256HexValue;
  readonly provider_response_sha256: Sha256HexValue;
}>;

export function hnsActiveLeaseRenewalSourceIneligibleResultV3Preimage(
  input: HnsActiveLeaseRenewalSourceIneligibleResultV3Input,
): string {
  return JSON.stringify([
    HNS_ACTIVE_LEASE_RENEWAL_SOURCE_INELIGIBLE_RESULT_V3_VERSION,
    strictHashInput(input.active_lease_renewal_id, Identifier, "Renewal id"),
    strictHashInput(input.active_lease_renewal_attempt_id, Identifier, "Renewal attempt id"),
    strictHashInput(input.route_binding_id, Identifier, "Route binding id"),
    decodeSchema(
      NonNegativeSafeInteger,
      input.expected_binding_generation,
      "Expected binding generation is invalid",
    ),
    strictHashInput(input.idempotency_key, Identifier, "Idempotency key"),
    decodeSchema(Sha256Hex, input.request_hash, "Renewal request hash is invalid"),
    "owner_authoritative_source_ineligible",
    null,
    null,
    decodeSchema(Sha256Hex, input.provider_response_sha256, "Provider response hash is invalid"),
    "disputed",
    "suspended",
  ]);
}

export function hnsActiveLeaseRenewalSourceIneligibleResultV3Hash(
  input: HnsActiveLeaseRenewalSourceIneligibleResultV3Input,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsActiveLeaseRenewalSourceIneligibleResultV3Preimage(input));
}

export type HnsControlObservationUnavailableReasonV2 =
  | HnsControlObservationUnavailableReason
  | "authority_inventory_unavailable";
