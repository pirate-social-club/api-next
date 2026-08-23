import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Option, Schema } from "effect";
import {
  decodeStrictHnsJsonBytes,
  HnsOwnerResponseDecodeError,
  sha256Utf8,
} from "./hns-evidence.ts";

export const HNS_CONTROL_OBSERVATION_REQUEST_VERSION =
  "pirate-hns-control-observation-request-v1" as const;
export const HNS_CONTROL_OBSERVATION_RESULT_VERSION =
  "pirate-hns-control-observation-result-v1" as const;
export const HNS_TARGET_OBSERVATION_VERSION = "pirate-hns-target-observation-v2" as const;
export const HNS_CONTROL_OBSERVATION_REQUEST_MAX_BYTES = 32_768 as const;
export const HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES = 1_048_576 as const;
export const HNS_CONTROL_OBSERVATION_PROVIDER_EVIDENCE_MAX_BYTES = 424 as const;
export const HNS_CONTROL_OBSERVATION_DIAGNOSTIC_MAX_BYTES = 512 as const;
export const HNS_CONTROL_OBSERVATION_EXPECTED_TXT_MAX_BYTES = 16_448 as const;

const exactParseOptions = { onExcessProperty: "error" } as const;
const sourceValues = ["hns_parent_chain_txt", "owner_authoritative_dns_txt"] as const;
const unavailableReasonValues = [
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

export type HnsOwnershipSource = (typeof sourceValues)[number];
export type HnsControlObservationUnavailableReason = (typeof unavailableReasonValues)[number];
export type HnsControlObservationRejectedReason = (typeof rejectedReasonValues)[number];

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

function hasOnlyUnicodeScalars(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0xd800 || codePoint > 0xdfff;
  });
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

function boundedValue(maxBytes: number, label: string) {
  return Schema.String.check(
    Schema.makeFilter((value) =>
      value.trim() === value &&
      value.length > 0 &&
      utf8Length(value) <= maxBytes &&
      hasOnlyUnicodeScalars(value)
        ? undefined
        : `Expected ${label} to be a bounded canonical UTF-8 value`,
    ),
  );
}

const Identifier = boundedString(256, "identifier");
const ConfigurationReference = boundedString(512, "provider_configuration_reference");
const ConfigurationDigest = Sha256Hex;
const RootLabel = boundedString(63, "root_label").check(
  Schema.makeFilter((value) =>
    validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root label",
  ),
);
const TxtName = boundedString(255, "txt_name");
const ExpectedTxtValue = boundedValue(
  HNS_CONTROL_OBSERVATION_EXPECTED_TXT_MAX_BYTES,
  "expected_txt_value",
);
const NonNegativeSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a non-negative safe integer",
  ),
);
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 && value <= 3_600
      ? undefined
      : "Expected an integer from 1 through 3600",
  ),
);
const Sha256 = Sha256Hex;
const ProviderEvidenceReference = boundedString(
  HNS_CONTROL_OBSERVATION_PROVIDER_EVIDENCE_MAX_BYTES,
  "provider_evidence_ref",
);
const DiagnosticReference = boundedString(
  HNS_CONTROL_OBSERVATION_DIAGNOSTIC_MAX_BYTES,
  "diagnostic_ref",
);

const RequestSchema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_REQUEST_VERSION),
  observation_id: Identifier,
  provider_id: Identifier,
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: ConfigurationDigest,
  environment: Identifier,
  ownership_source: Schema.Literals(sourceValues),
  root_label: RootLabel,
  txt_name: TxtName,
  expected_txt_value: ExpectedTxtValue,
});

const VerifiedSchema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256,
  status: Schema.Literal("verified"),
  provider_id: Identifier,
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: ConfigurationDigest,
  environment: Identifier,
  ownership_source: Schema.Literals(sourceValues),
  root_label: RootLabel,
  txt_name: TxtName,
  expected_txt_value_sha256: Sha256,
  control_identity_digest: Sha256,
  chain_authority_digest: Sha256,
  root_exists: Schema.Literal(true),
  root_control_verified: Schema.Literal(true),
  expiry_horizon_sufficient: Schema.Literal(true),
  chain_network: Identifier,
  chain_genesis_block_hash: Sha256,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: NonNegativeSafeInteger,
  provider_evidence_ref: ProviderEvidenceReference,
});

const RejectedSchema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256,
  status: Schema.Literal("rejected"),
  reason_code: Schema.Literals(rejectedReasonValues),
  provider_id: Identifier,
  provider_configuration_reference: ConfigurationReference,
  provider_configuration_version: Identifier,
  provider_configuration_digest: ConfigurationDigest,
  environment: Identifier,
  ownership_source: Schema.Literals(sourceValues),
  root_label: RootLabel,
  txt_name: TxtName,
  expected_txt_value_sha256: Sha256,
  observed_txt_values_digest: Schema.NullOr(Sha256),
  chain_authority_digest: Sha256,
  chain_network: Identifier,
  chain_genesis_block_hash: Sha256,
  chain_anchor_height: NonNegativeSafeInteger,
  chain_anchor_block_hash: Sha256,
  chain_anchor_median_time: NonNegativeSafeInteger,
  expiry_height: Schema.NullOr(NonNegativeSafeInteger),
  provider_evidence_ref: ProviderEvidenceReference,
});

const UnavailableSchema = Schema.Struct({
  version: Schema.Literal(HNS_CONTROL_OBSERVATION_RESULT_VERSION),
  observation_id: Identifier,
  request_sha256: Sha256,
  status: Schema.Literal("unavailable"),
  reason_code: Schema.Literals(unavailableReasonValues),
  retry_after_seconds: Schema.NullOr(PositiveSafeInteger),
  diagnostic_ref: Schema.NullOr(DiagnosticReference),
});

export type HnsControlObservationRequestV1 = Schema.Schema.Type<typeof RequestSchema>;
export type HnsControlObservationVerifiedV1 = Schema.Schema.Type<typeof VerifiedSchema>;
export type HnsControlObservationRejectedV1 = Schema.Schema.Type<typeof RejectedSchema>;
export type HnsControlObservationUnavailableV1 = Schema.Schema.Type<typeof UnavailableSchema>;
export type HnsControlObservationResultV1 =
  | HnsControlObservationVerifiedV1
  | HnsControlObservationRejectedV1
  | HnsControlObservationUnavailableV1;

export type HnsObservedTxtRecord =
  | Readonly<{
      readonly chunks: ReadonlyArray<string>;
    }>
  | ReadonlyArray<string>;

export type HnsChainAuthorityRecord =
  | readonly ["NS", string]
  | readonly ["GLUE4", string, string]
  | readonly ["GLUE6", string, string]
  | readonly ["DS", number, number, number, string];

export type HnsEvidenceLeasePolicy = Readonly<{
  readonly expected_block_interval_seconds: number;
  readonly expiry_safety_blocks: number;
  readonly evidence_lease_seconds: number;
}>;

export type HnsEvidenceLease = Readonly<{
  readonly safe_remaining_blocks: number;
  readonly observed_at: string;
  readonly expires_at: string;
}>;

export type HnsControlObservationDecodedRequest = Readonly<{
  readonly request_bytes: Uint8Array;
  readonly request: HnsControlObservationRequestV1;
  readonly request_sha256: Sha256HexValue;
}>;

export type HnsControlObservationDecodedResult = Readonly<{
  readonly result_bytes: Uint8Array;
  readonly result: HnsControlObservationResultV1;
  readonly result_sha256: Sha256HexValue;
}>;

export type HnsOwnerTargetVerifiedObservationV2 = Readonly<{
  readonly status: "verified";
  readonly observation_contract_version: typeof HNS_TARGET_OBSERVATION_VERSION;
  readonly provider_evidence_ref: string;
  readonly upstream_session_ref: string;
  readonly ownership_source: HnsOwnershipSource;
  readonly challenge_name: string;
  readonly challenge_value: string;
  readonly expected_txt_value_sha256: Sha256HexValue;
  readonly control_identity_digest: Sha256HexValue;
  readonly chain_authority_digest: Sha256HexValue;
  readonly observer_result_sha256: Sha256HexValue;
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
}>;

export type HnsOwnerTargetRejectedObservationV2 = Readonly<{
  readonly status: "rejected";
  readonly observation_contract_version: typeof HNS_TARGET_OBSERVATION_VERSION;
  readonly reason_code: (typeof targetRejectedReasonValues)[number];
  readonly observer_result_sha256: Sha256HexValue;
  readonly provider_evidence_ref: string;
}>;

export type HnsOwnerTargetPendingObservationV2 = Readonly<{
  readonly status: "pending";
  readonly observation_contract_version: typeof HNS_TARGET_OBSERVATION_VERSION;
  readonly reason_code: "txt_absent" | "txt_value_mismatch";
  readonly observer_result_sha256: Sha256HexValue;
  readonly provider_evidence_ref: string;
}>;

export type HnsOwnerTargetUnavailableObservationV2 = Readonly<{
  readonly status: "unavailable";
  readonly observation_contract_version: typeof HNS_TARGET_OBSERVATION_VERSION;
  readonly reason_code: HnsControlObservationUnavailableReason;
  readonly retry_after_seconds: number | null;
  readonly diagnostic_ref: string | null;
}>;

export type HnsOwnerTargetObservationV2 =
  | HnsOwnerTargetVerifiedObservationV2
  | HnsOwnerTargetRejectedObservationV2
  | HnsOwnerTargetPendingObservationV2
  | HnsOwnerTargetUnavailableObservationV2;

export class HnsControlObservationDecodeError extends HnsOwnerResponseDecodeError {
  constructor(message: string) {
    super(message);
    this.name = "HnsControlObservationDecodeError";
  }
}

function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return Schema.decodeUnknownSync(Sha256Hex)(hex);
  });
}

function decodeSchema<T>(schema: Schema.ConstraintDecoder<T>, value: unknown, message: string): T {
  const decoded = Schema.decodeUnknownOption(schema, exactParseOptions)(value);
  if (Option.isNone(decoded)) throw new HnsControlObservationDecodeError(message);
  return decoded.value;
}

function assertObjectOrder(value: unknown, expected: ReadonlyArray<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HnsControlObservationDecodeError("HNS observer JSON must be an object");
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new HnsControlObservationDecodeError("HNS observer JSON members are reordered");
  }
}

const requestKeys = [
  "version",
  "observation_id",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "provider_configuration_digest",
  "environment",
  "ownership_source",
  "root_label",
  "txt_name",
  "expected_txt_value",
] as const;
const verifiedKeys = [
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
  "provider_evidence_ref",
] as const;
const rejectedKeys = [
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
  "provider_evidence_ref",
] as const;
const unavailableKeys = [
  "version",
  "observation_id",
  "request_sha256",
  "status",
  "reason_code",
  "retry_after_seconds",
  "diagnostic_ref",
] as const;

function decodeCanonicalJson(value: unknown, maxBytes: number): unknown {
  try {
    return decodeStrictHnsJsonBytes(value, maxBytes);
  } catch (error) {
    if (error instanceof HnsOwnerResponseDecodeError) {
      throw new HnsControlObservationDecodeError(error.message);
    }
    throw error;
  }
}

export function hnsControlObservationRequestPreimage(
  input: HnsControlObservationRequestV1,
): string {
  const decoded = decodeSchema(
    RequestSchema,
    input,
    "HNS observer request failed its strict schema",
  );
  assertRequestSourceName(decoded);
  return JSON.stringify([
    HNS_CONTROL_OBSERVATION_REQUEST_VERSION,
    decoded.observation_id,
    decoded.provider_id,
    decoded.provider_configuration_reference,
    decoded.provider_configuration_version,
    decoded.provider_configuration_digest,
    decoded.environment,
    decoded.ownership_source,
    decoded.root_label,
    decoded.txt_name,
    decoded.expected_txt_value,
  ]);
}

export function hnsControlObservationRequestHash(
  input: HnsControlObservationRequestV1,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsControlObservationRequestPreimage(input));
}

export async function encodeHnsControlObservationRequest(
  input: HnsControlObservationRequestV1,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  return (await decodeHnsControlObservationRequestBytes(bytes)).request_bytes;
}

export async function decodeHnsControlObservationRequestBytes(
  value: unknown,
): Promise<HnsControlObservationDecodedRequest> {
  const bytes = copyBoundedBytes(value, HNS_CONTROL_OBSERVATION_REQUEST_MAX_BYTES);
  const json = decodeCanonicalJson(bytes, HNS_CONTROL_OBSERVATION_REQUEST_MAX_BYTES);
  assertObjectOrder(json, requestKeys);
  const request = decodeSchema(
    RequestSchema,
    json,
    "HNS observer request failed its strict schema",
  );
  assertRequestSourceName(request);
  const request_sha256 = await hnsControlObservationRequestHash(request);
  return { request_bytes: bytes, request, request_sha256 };
}

function copyBoundedBytes(value: unknown, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maxBytes) {
    throw new HnsControlObservationDecodeError("HNS observer body has an invalid byte length");
  }
  return new Uint8Array(value);
}

function assertRequestSourceName(request: HnsControlObservationRequestV1): void {
  const expected =
    request.ownership_source === "hns_parent_chain_txt"
      ? request.root_label
      : `_pirate.${request.root_label}`;
  if (request.txt_name !== expected || request.txt_name.endsWith(".")) {
    throw new HnsControlObservationDecodeError("HNS observer source and TXT name do not match");
  }
}

export function hnsObservedTxtValuesPreimage(records: ReadonlyArray<HnsObservedTxtRecord>): string {
  const values = records.map((record) => {
    const chunks = Array.isArray(record) ? record : "chunks" in record ? record.chunks : [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new TypeError("TXT records must contain one or more character-string chunks");
    }
    for (const chunk of chunks) {
      if (typeof chunk !== "string" || !hasOnlyUnicodeScalars(chunk) || utf8Length(chunk) > 255) {
        throw new TypeError("TXT chunks must be bounded UTF-8 character strings");
      }
    }
    return chunks.join("");
  });
  values.sort(compareUtf8);
  return JSON.stringify(["pirate-hns-observed-txt-values-v1", ...values]);
}

export function hnsObservedTxtValuesDigest(
  records: ReadonlyArray<HnsObservedTxtRecord>,
): Promise<Sha256HexValue | null> {
  if (records.length === 0) return Promise.resolve(null);
  return sha256Utf8(hnsObservedTxtValuesPreimage(records));
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index] ?? 0;
    const rightByte = rightBytes[index] ?? 0;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalDnsName(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function canonicalIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  );
}

function canonicalIpv6(value: string): boolean {
  if (value.length === 0 || value !== value.toLowerCase() || value.includes(".")) return false;
  if (!/^[0-9a-f:]+$/u.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const leftHalf = halves[0] ?? "";
  const rightHalf = halves[1] ?? "";
  const left = leftHalf === "" ? [] : leftHalf.split(":");
  const right = halves.length === 2 && rightHalf !== "" ? rightHalf.split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return false;
  if (right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return false;
  const count = left.length + right.length;
  if (halves.length === 1 ? count !== 8 : count >= 8) return false;
  return canonicalizeIpv6(value) === value;
}

function canonicalizeIpv6(value: string): string | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const leftHalf = halves[0] ?? "";
  const rightHalf = halves[1] ?? "";
  const left = leftHalf === "" ? [] : leftHalf.split(":");
  const right = halves.length === 2 && rightHalf !== "" ? rightHalf.split(":") : [];
  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) ||
    right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
  ) {
    return null;
  }
  const words =
    halves.length === 2
      ? [
          ...left.map((part) => Number.parseInt(part, 16)),
          ...new Array(8 - left.length - right.length).fill(0),
          ...right.map((part) => Number.parseInt(part, 16)),
        ]
      : [...left.map((part) => Number.parseInt(part, 16))];
  if (words.length !== 8) return null;
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < words.length; ) {
    if (words[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const encoded: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (index === bestStart) {
      encoded.push("");
      index += bestLength - 1;
    } else {
      encoded.push(words[index].toString(16));
    }
  }
  let result = encoded.join(":");
  if (bestStart === 0) result = `:${result}`;
  if (bestStart + bestLength === words.length) result = `${result}:`;
  return result;
}

function canonicalAuthorityRecord(record: HnsChainAuthorityRecord): HnsChainAuthorityRecord {
  if (!Array.isArray(record)) throw new TypeError("Authority records must be tuples");
  if (record[0] === "NS" && record.length === 2 && canonicalDnsName(record[1])) {
    return ["NS", record[1]];
  }
  if (
    record[0] === "GLUE4" &&
    record.length === 3 &&
    canonicalDnsName(record[1]) &&
    canonicalIpv4(record[2])
  ) {
    return ["GLUE4", record[1], record[2]];
  }
  if (
    record[0] === "GLUE6" &&
    record.length === 3 &&
    canonicalDnsName(record[1]) &&
    canonicalIpv6(record[2])
  ) {
    return ["GLUE6", record[1], record[2]];
  }
  if (
    record[0] === "DS" &&
    record.length === 5 &&
    Number.isSafeInteger(record[1]) &&
    record[1] >= 0 &&
    record[1] <= 65_535 &&
    Number.isSafeInteger(record[2]) &&
    record[2] >= 0 &&
    record[2] <= 255 &&
    Number.isSafeInteger(record[3]) &&
    record[3] >= 0 &&
    record[3] <= 255 &&
    typeof record[4] === "string" &&
    /^[0-9a-f]{2,128}$/u.test(record[4]) &&
    record[4].length % 2 === 0
  ) {
    return ["DS", record[1], record[2], record[3], record[4]];
  }
  throw new TypeError("Authority record is not canonical");
}

export function hnsChainAuthorityRecords(
  source: HnsOwnershipSource,
  records: ReadonlyArray<HnsChainAuthorityRecord>,
): ReadonlyArray<HnsChainAuthorityRecord> {
  const decodedSource = Schema.decodeUnknownSync(Schema.Literals(sourceValues))(source);
  if (decodedSource === "hns_parent_chain_txt") {
    if (records.length !== 0) throw new TypeError("Parent-chain authority records must be empty");
    return [];
  }
  const canonical = records.map(canonicalAuthorityRecord);
  const unique = new Map<string, HnsChainAuthorityRecord>();
  for (const record of canonical) unique.set(JSON.stringify(record), record);
  const order = { NS: 0, GLUE4: 1, GLUE6: 2, DS: 3 } as const;
  return [...unique.values()].sort((left, right) => {
    const byType = order[left[0]] - order[right[0]];
    return byType === 0 ? compareUtf8(JSON.stringify(left), JSON.stringify(right)) : byType;
  });
}

export function hnsChainAuthorityPreimage(
  input: Readonly<{
    readonly chain_network: string;
    readonly chain_genesis_block_hash: Sha256HexValue;
    readonly root_label: string;
    readonly ownership_source: HnsOwnershipSource;
    readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  }>,
): string {
  const chainNetwork = Schema.decodeUnknownSync(Identifier)(input.chain_network);
  const genesis = Schema.decodeUnknownSync(Sha256)(input.chain_genesis_block_hash);
  const root = Schema.decodeUnknownSync(RootLabel)(input.root_label);
  const ownershipSource = Schema.decodeUnknownSync(Schema.Literals(sourceValues))(
    input.ownership_source,
  );
  const records = hnsChainAuthorityRecords(ownershipSource, input.authority_records);
  return JSON.stringify([
    "pirate-hns-chain-authority-v1",
    chainNetwork,
    genesis,
    root,
    ownershipSource,
    records,
  ]);
}

export function hnsChainAuthorityDigest(
  input: Readonly<{
    readonly chain_network: string;
    readonly chain_genesis_block_hash: Sha256HexValue;
    readonly root_label: string;
    readonly ownership_source: HnsOwnershipSource;
    readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  }>,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsChainAuthorityPreimage(input));
}

export function hnsControlIdentityPreimage(
  input: Readonly<{
    readonly ownership_source: HnsOwnershipSource;
    readonly txt_name: string;
    readonly expected_txt_value: string;
    readonly root_label: string;
    readonly chain_authority_digest: Sha256HexValue;
  }>,
): string {
  const request: HnsControlObservationRequestV1 = {
    version: HNS_CONTROL_OBSERVATION_REQUEST_VERSION,
    observation_id: "identity-preimage",
    provider_id: "identity-preimage",
    provider_configuration_reference: "identity-preimage",
    provider_configuration_version: "identity-preimage",
    provider_configuration_digest: "0".repeat(64) as Sha256HexValue,
    environment: "identity-preimage",
    ownership_source: input.ownership_source,
    root_label: input.root_label,
    txt_name: input.txt_name,
    expected_txt_value: input.expected_txt_value,
  };
  const decoded = decodeSchema(
    RequestSchema,
    request,
    "HNS control identity input failed its strict schema",
  );
  assertRequestSourceName(decoded);
  const value = decoded.expected_txt_value;
  const digest = Schema.decodeUnknownSync(Sha256)(input.chain_authority_digest);
  return JSON.stringify([
    "pirate-hns-control-identity-v1",
    decoded.ownership_source,
    decoded.txt_name,
    value,
    decoded.root_label,
    digest,
  ]);
}

export function hnsControlIdentityDigest(
  input: Readonly<{
    readonly ownership_source: HnsOwnershipSource;
    readonly txt_name: string;
    readonly expected_txt_value: string;
    readonly root_label: string;
    readonly chain_authority_digest: Sha256HexValue;
  }>,
): Promise<Sha256HexValue> {
  return sha256Utf8(hnsControlIdentityPreimage(input));
}

export function hnsControlObservationResultHash(value: Uint8Array): Promise<Sha256HexValue> {
  return sha256Bytes(copyBoundedBytes(value, HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES));
}

export async function decodeHnsControlObservationResultBytes(
  value: unknown,
  expectedRequest?: HnsControlObservationRequestV1,
): Promise<HnsControlObservationDecodedResult> {
  const bytes = copyBoundedBytes(value, HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES);
  const json = decodeCanonicalJson(bytes, HNS_CONTROL_OBSERVATION_RESULT_MAX_BYTES);
  const status =
    json !== null && typeof json === "object" && !Array.isArray(json) && "status" in json
      ? (json as { readonly status?: unknown }).status
      : undefined;
  const keys =
    status === "verified" ? verifiedKeys : status === "rejected" ? rejectedKeys : unavailableKeys;
  assertObjectOrder(json, keys);
  const result: HnsControlObservationResultV1 =
    status === "verified"
      ? decodeSchema(VerifiedSchema, json, "HNS observer result failed its strict schema")
      : status === "rejected"
        ? decodeSchema(RejectedSchema, json, "HNS observer result failed its strict schema")
        : decodeSchema(UnavailableSchema, json, "HNS observer result failed its strict schema");
  if (result.status === "rejected") assertRejectedReasonInvariants(result);
  if (result.status !== "unavailable") assertResultSourceName(result);
  const result_sha256 = await sha256Bytes(bytes);
  if (expectedRequest !== undefined) {
    const expectedRequestHash = await hnsControlObservationRequestHash(expectedRequest);
    validateHnsControlObservationResult(expectedRequest, result, expectedRequestHash);
    if (result.status !== "unavailable") {
      const expectedTxtValueSha256 = await sha256Utf8(expectedRequest.expected_txt_value);
      if (result.expected_txt_value_sha256 !== expectedTxtValueSha256) {
        throw new HnsControlObservationDecodeError(
          "Observer result TXT value hash does not match its request",
        );
      }
      if (result.status === "verified") {
        const expectedControlIdentityDigest = await hnsControlIdentityDigest({
          ownership_source: expectedRequest.ownership_source,
          txt_name: expectedRequest.txt_name,
          expected_txt_value: expectedRequest.expected_txt_value,
          root_label: expectedRequest.root_label,
          chain_authority_digest: result.chain_authority_digest,
        });
        if (result.control_identity_digest !== expectedControlIdentityDigest) {
          throw new HnsControlObservationDecodeError(
            "Observer result control identity does not match its request",
          );
        }
      }
    }
  }
  return { result_bytes: bytes, result, result_sha256 };
}

function assertRejectedReasonInvariants(result: HnsControlObservationRejectedV1): void {
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
    throw new HnsControlObservationDecodeError(
      "Observer rejection facts do not match the reason code",
    );
  }
}

function assertResultSourceName(
  result: HnsControlObservationVerifiedV1 | HnsControlObservationRejectedV1,
): void {
  const expected =
    result.ownership_source === "hns_parent_chain_txt"
      ? result.root_label
      : `_pirate.${result.root_label}`;
  if (result.txt_name !== expected || result.txt_name.endsWith(".")) {
    throw new HnsControlObservationDecodeError("HNS observer source and TXT name do not match");
  }
}

function validateHnsControlObservationResult(
  expectedRequest: HnsControlObservationRequestV1,
  result: HnsControlObservationResultV1,
  expectedRequestHash: Sha256HexValue,
): void {
  if (result.request_sha256 !== expectedRequestHash)
    throw new TypeError("Observer result request hash mismatch");
  if (result.observation_id !== expectedRequest.observation_id) {
    throw new TypeError("Observer result does not echo its request authority");
  }
  if (result.status !== "unavailable") {
    if (
      result.provider_id !== expectedRequest.provider_id ||
      result.provider_configuration_reference !==
        expectedRequest.provider_configuration_reference ||
      result.provider_configuration_version !== expectedRequest.provider_configuration_version ||
      result.provider_configuration_digest !== expectedRequest.provider_configuration_digest ||
      result.environment !== expectedRequest.environment ||
      result.ownership_source !== expectedRequest.ownership_source ||
      result.root_label !== expectedRequest.root_label ||
      result.txt_name !== expectedRequest.txt_name
    ) {
      throw new TypeError("Observer result does not echo its request authority");
    }
    assertRequestSourceName(expectedRequest);
    assertResultSourceName(result);
  }
  if (result.status !== "unavailable" && result.root_label !== result.root_label.toLowerCase()) {
    throw new TypeError("Observer result root label is not canonical");
  }
}

export function deriveHnsEvidenceLease(
  result: Pick<
    HnsControlObservationVerifiedV1,
    "chain_anchor_median_time" | "chain_anchor_height" | "expiry_height"
  >,
  policy: HnsEvidenceLeasePolicy,
): HnsEvidenceLease {
  if (
    !Number.isSafeInteger(result.chain_anchor_median_time) ||
    result.chain_anchor_median_time < 0 ||
    !Number.isSafeInteger(result.chain_anchor_height) ||
    result.chain_anchor_height < 0 ||
    !Number.isSafeInteger(result.expiry_height) ||
    result.expiry_height < 0
  ) {
    throw new TypeError("HNS observer chain facts are not canonical");
  }
  if (
    !Number.isSafeInteger(policy.expected_block_interval_seconds) ||
    policy.expected_block_interval_seconds <= 0 ||
    !Number.isSafeInteger(policy.expiry_safety_blocks) ||
    policy.expiry_safety_blocks < 0 ||
    !Number.isSafeInteger(policy.evidence_lease_seconds) ||
    policy.evidence_lease_seconds <= 0
  ) {
    throw new TypeError("HNS evidence lease policy is not canonical");
  }
  const safe_remaining_blocks =
    result.expiry_height - result.chain_anchor_height - policy.expiry_safety_blocks;
  if (safe_remaining_blocks <= 0) {
    throw new TypeError("HNS evidence expiry horizon is insufficient");
  }
  const chainSafeExpiresAt =
    result.chain_anchor_median_time +
    safe_remaining_blocks * policy.expected_block_interval_seconds;
  const expiresAt = Math.min(
    result.chain_anchor_median_time + policy.evidence_lease_seconds,
    chainSafeExpiresAt,
  );
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= result.chain_anchor_median_time) {
    throw new TypeError("HNS evidence lease is not representable");
  }
  const observedAt = new Date(result.chain_anchor_median_time * 1_000);
  const expiresAtDate = new Date(expiresAt * 1_000);
  if (!Number.isFinite(observedAt.getTime()) || !Number.isFinite(expiresAtDate.getTime())) {
    throw new TypeError("HNS evidence lease is not representable");
  }
  return {
    safe_remaining_blocks,
    observed_at: observedAt.toISOString(),
    expires_at: expiresAtDate.toISOString(),
  };
}

export type HnsControlObservationMappingInput = Readonly<{
  readonly request: HnsControlObservationRequestV1;
  readonly result_bytes: Uint8Array;
  readonly upstream_session_ref: string;
  readonly policy: HnsEvidenceLeasePolicy;
}>;

export async function mapHnsControlObservationToTargetV2(
  input: HnsControlObservationMappingInput,
): Promise<HnsOwnerTargetObservationV2> {
  const decodedResult = await decodeHnsControlObservationResultBytes(
    input.result_bytes,
    input.request,
  );
  const result = decodedResult.result;
  if (
    input.upstream_session_ref.trim() !== input.upstream_session_ref ||
    input.upstream_session_ref.length === 0 ||
    !isSafeText(input.upstream_session_ref) ||
    utf8Length(input.upstream_session_ref) > 16_384 ||
    input.request.expected_txt_value !== `pirate-verification=${input.upstream_session_ref}`
  ) {
    throw new TypeError("Observer request is not bound to the upstream challenge");
  }
  if (result.status === "unavailable") {
    return {
      status: "unavailable",
      observation_contract_version: HNS_TARGET_OBSERVATION_VERSION,
      reason_code: result.reason_code,
      retry_after_seconds: result.retry_after_seconds,
      diagnostic_ref: result.diagnostic_ref,
    };
  }
  const providerEvidenceRef = `hns-observer-v1:sha256:${decodedResult.result_sha256}:${result.provider_evidence_ref}`;
  if (result.status === "rejected") {
    return result.reason_code === "txt_absent" || result.reason_code === "txt_value_mismatch"
      ? {
          status: "pending",
          observation_contract_version: HNS_TARGET_OBSERVATION_VERSION,
          reason_code: result.reason_code,
          observer_result_sha256: decodedResult.result_sha256,
          provider_evidence_ref: providerEvidenceRef,
        }
      : {
          status: "rejected",
          observation_contract_version: HNS_TARGET_OBSERVATION_VERSION,
          reason_code: result.reason_code,
          observer_result_sha256: decodedResult.result_sha256,
          provider_evidence_ref: providerEvidenceRef,
        };
  }
  const expectedTxtValueSha256 = await sha256Utf8(input.request.expected_txt_value);
  return mapVerifiedResult(
    input.request,
    result,
    decodedResult.result_sha256,
    input.upstream_session_ref,
    deriveHnsEvidenceLease(result, input.policy),
    providerEvidenceRef,
    expectedTxtValueSha256,
  );
}

function mapVerifiedResult(
  request: HnsControlObservationRequestV1,
  result: HnsControlObservationVerifiedV1,
  resultSha256: Sha256HexValue,
  upstreamSessionRef: string,
  lease: HnsEvidenceLease,
  providerEvidenceRef: string,
  expectedTxtValueSha256: Sha256HexValue,
): HnsOwnerTargetVerifiedObservationV2 {
  return {
    status: "verified",
    observation_contract_version: HNS_TARGET_OBSERVATION_VERSION,
    provider_evidence_ref: providerEvidenceRef,
    upstream_session_ref: upstreamSessionRef,
    ownership_source: request.ownership_source,
    challenge_name: request.txt_name,
    challenge_value: request.expected_txt_value,
    expected_txt_value_sha256: expectedTxtValueSha256,
    control_identity_digest: result.control_identity_digest,
    chain_authority_digest: result.chain_authority_digest,
    observer_result_sha256: resultSha256,
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
