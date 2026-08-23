import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Predicate, Schema } from "effect";
import {
  decodeHnsControlObservationResultBytes,
  HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES,
  HNS_CONTROL_OBSERVATION_RESULT_VERSION,
  type HnsControlObservationDecodedResult,
  type HnsControlObservationRequestV1,
  type HnsControlObservationUnavailableReason,
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
  type HnsControlObserverTranscriptEntryV1,
  hnsControlObserverTranscriptByteLength,
  isHnsControlObserverSnapshotReference,
} from "./hns-control-observer-store.ts";
import {
  decodeStrictHnsJsonBytes,
  HnsOwnerResponseDecodeError,
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

export async function decodeHnsOwnerTargetIneligibleObservationV3Bytes(
  value: unknown,
): Promise<
  Readonly<{ response: HnsOwnerTargetIneligibleObservationV3; response_sha256: Sha256HexValue }>
> {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 1_048_576) {
    throw new HnsControlObservationV2DecodeError("Target ineligible response exceeds its bound");
  }
  const bytes = new Uint8Array(value);
  const json = decodeStrictHnsJsonBytes(bytes, 1_048_576);
  assertObjectOrder(json, targetIneligibleV3Keys, "Target ineligible response-v3");
  return {
    response: decodeSchema(
      TargetIneligibleV3Schema,
      json,
      "Target ineligible response-v3 is invalid",
    ),
    response_sha256: await sha256Bytes(bytes),
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
