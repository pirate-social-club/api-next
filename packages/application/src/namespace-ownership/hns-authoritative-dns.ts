import { validCommunityRouteRoot } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Schema } from "effect";
import type { HnsChainAuthorityRecord, HnsObservedTxtRecord } from "./hns-control-observer.ts";
import { hnsChainAuthorityRecords } from "./hns-control-observer.ts";
import { decodeStrictHnsJsonBytes } from "./hns-evidence.ts";

export const HNS_AUTHORITATIVE_DNS_SEMANTIC_FACTS_VERSION =
  "pirate-hns-authoritative-dns-semantic-facts-v1" as const;
export const HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID =
  "pirate-hns-authoritative-dns-validator-policy-v1" as const;
export const HNS_AUTHORITATIVE_DNS_QUERY_UDP_PAYLOAD_SIZE = 1_232 as const;
export const HNS_AUTHORITATIVE_DNS_OWNER_VIEW_MAX_COUNT = 4 as const;
export const HNS_AUTHORITATIVE_DNS_SEMANTIC_FACTS_MAX_BYTES = 8_192 as const;

export type HnsAuthoritativeDnsQueryKindV1 = "dnskey" | "control_txt";
export type HnsAuthoritativeDnsAddressFamilyV1 = "GLUE4" | "GLUE6";

export type HnsAuthoritativeDnsAuthorityTupleV1 = Readonly<{
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
}>;

export type HnsAuthoritativeDnsExchangeInputV1 = Readonly<{
  readonly driver_reference: string;
  readonly view_id: string;
  readonly query_kind: HnsAuthoritativeDnsQueryKindV1;
  readonly root_label: string;
  readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  readonly chain_authority_digest: Sha256HexValue;
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly request_bytes: Uint8Array;
  readonly response_max_bytes: number;
  readonly signal: AbortSignal;
}>;

export type HnsAuthoritativeDnsTransportPortV1 = Readonly<{
  readonly exchange: (input: HnsAuthoritativeDnsExchangeInputV1) => Promise<Uint8Array>;
}>;

export type HnsAuthoritativeDnsTransportFailureV1 = "timeout" | "transport_error" | "aborted";

export class HnsAuthoritativeDnsTransportErrorV1 extends Error {
  readonly name = "HnsAuthoritativeDnsTransportErrorV1";

  constructor(readonly outcome: HnsAuthoritativeDnsTransportFailureV1) {
    super(outcome);
  }
}

export type HnsAuthoritativeDnsMessageIdPortV1 = Readonly<{
  readonly next_id: (view_id: string, query_kind: HnsAuthoritativeDnsQueryKindV1) => number;
}>;

export type HnsAuthoritativeDnsValidationV1 = "secure" | "insecure" | "bogus" | "indeterminate";

export type HnsAuthoritativeDnsValidationResultV1 = Readonly<{
  readonly dnssec_validation: HnsAuthoritativeDnsValidationV1;
  readonly validated_dnskey_response_sha256: Sha256HexValue;
  readonly validated_control_response_sha256: Sha256HexValue;
  readonly validated_chain_authority_digest: Sha256HexValue;
}>;

export type HnsAuthoritativeDnsValidatorInputV1 = Readonly<{
  readonly driver_reference: string;
  readonly view_id: string;
  readonly root_label: string;
  readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  readonly chain_authority_digest: Sha256HexValue;
  readonly authority_nameserver: string;
  readonly authority_address_family: HnsAuthoritativeDnsAddressFamilyV1;
  readonly authority_address: string;
  readonly dnskey_request_bytes: Uint8Array;
  readonly dnskey_response_bytes: Uint8Array;
  readonly control_request_bytes: Uint8Array;
  readonly control_response_bytes: Uint8Array;
  readonly validation_database_time: string;
  readonly signal: AbortSignal;
}>;

export type HnsAuthoritativeDnsValidatorPortV1 = Readonly<{
  readonly policy_id: typeof HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID;
  readonly validate: (
    input: HnsAuthoritativeDnsValidatorInputV1,
  ) => Promise<HnsAuthoritativeDnsValidationResultV1>;
}>;

export type HnsAuthoritativeDnsSemanticClassV1 = "txt_values" | "nxdomain" | "nodata";

export type HnsAuthoritativeDnsSemanticViewV1 = HnsAuthoritativeDnsAuthorityTupleV1 &
  Readonly<{
    readonly view_id: string;
    readonly dnskey_request_sha256: Sha256HexValue;
    readonly dnskey_response_sha256: Sha256HexValue;
    readonly control_request_sha256: Sha256HexValue;
    readonly control_response_sha256: Sha256HexValue;
    readonly chain_authority_digest: Sha256HexValue;
    readonly validation_database_time: string;
    readonly dnssec_validation: HnsAuthoritativeDnsValidationV1;
    readonly semantic_class: HnsAuthoritativeDnsSemanticClassV1 | null;
    readonly observed_txt_values_digest: Sha256HexValue | null;
  }>;

export type HnsAuthoritativeDnsDecodedSemanticFactsV1 = Readonly<{
  readonly semantic_facts_bytes: Uint8Array;
  readonly views: ReadonlyArray<HnsAuthoritativeDnsSemanticViewV1>;
}>;

export type HnsAuthoritativeDnsDecodedQueryV1 = Readonly<{
  readonly message_id: number;
  readonly query_kind: HnsAuthoritativeDnsQueryKindV1;
  readonly root_label: string;
}>;

export type HnsAuthoritativeDnsResponseClassificationV1 =
  | Readonly<{ readonly kind: "dnskey" }>
  | Readonly<{
      readonly kind: "txt_values";
      readonly observed_txt_records: ReadonlyArray<HnsObservedTxtRecord>;
    }>
  | Readonly<{ readonly kind: "nxdomain" | "nodata" | "servfail" | "inconclusive" }>;

export class HnsAuthoritativeDnsWireError extends Error {
  readonly name = "HnsAuthoritativeDnsWireError";
}

export class HnsAuthoritativeDnsAdapterResultError extends Error {
  readonly name = "HnsAuthoritativeDnsAdapterResultError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const viewIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const validationValues: ReadonlyArray<HnsAuthoritativeDnsValidationV1> = [
  "secure",
  "insecure",
  "bogus",
  "indeterminate",
];
const validationResultKeys = [
  "dnssec_validation",
  "validated_dnskey_response_sha256",
  "validated_control_response_sha256",
  "validated_chain_authority_digest",
] as const;

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function assertRootLabel(value: string): void {
  if (
    !validCommunityRouteRoot("hns", value) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value) ||
    encoder.encode(value).byteLength > 63
  ) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS root label is invalid");
  }
}

function assertMessageId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS message id is invalid");
  }
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS integer crosses the message");
  }
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function encodedQueryName(
  rootLabel: string,
  queryKind: HnsAuthoritativeDnsQueryKindV1,
): Uint8Array {
  const rootBytes = encoder.encode(rootLabel);
  const prefixBytes = queryKind === "control_txt" ? encoder.encode("_pirate") : null;
  const length = 1 + rootBytes.byteLength + 1 + (prefixBytes === null ? 0 : 1 + prefixBytes.length);
  const bytes = new Uint8Array(length);
  let offset = 0;
  if (prefixBytes !== null) {
    bytes[offset] = prefixBytes.byteLength;
    bytes.set(prefixBytes, offset + 1);
    offset += 1 + prefixBytes.byteLength;
  }
  bytes[offset] = rootBytes.byteLength;
  bytes.set(rootBytes, offset + 1);
  return bytes;
}

export function buildHnsAuthoritativeDnsQueryV1(
  input: Readonly<{
    readonly message_id: number;
    readonly query_kind: HnsAuthoritativeDnsQueryKindV1;
    readonly root_label: string;
  }>,
): Uint8Array {
  assertMessageId(input.message_id);
  assertRootLabel(input.root_label);
  if (input.query_kind !== "dnskey" && input.query_kind !== "control_txt") {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query kind is invalid");
  }
  const name = encodedQueryName(input.root_label, input.query_kind);
  const bytes = new Uint8Array(12 + name.byteLength + 4 + 11);
  writeUint16(bytes, 0, input.message_id);
  writeUint16(bytes, 2, 0);
  writeUint16(bytes, 4, 1);
  writeUint16(bytes, 6, 0);
  writeUint16(bytes, 8, 0);
  writeUint16(bytes, 10, 1);
  bytes.set(name, 12);
  let offset = 12 + name.byteLength;
  writeUint16(bytes, offset, input.query_kind === "dnskey" ? 48 : 16);
  writeUint16(bytes, offset + 2, 1);
  offset += 4;
  bytes[offset] = 0;
  writeUint16(bytes, offset + 1, 41);
  writeUint16(bytes, offset + 3, HNS_AUTHORITATIVE_DNS_QUERY_UDP_PAYLOAD_SIZE);
  bytes[offset + 5] = 0;
  bytes[offset + 6] = 0;
  writeUint16(bytes, offset + 7, 0x8000);
  writeUint16(bytes, offset + 9, 0);
  return bytes;
}

function readUncompressedQueryLabels(
  bytes: Uint8Array,
  initialOffset: number,
): Readonly<{ readonly labels: ReadonlyArray<string>; readonly next_offset: number }> {
  const labels: string[] = [];
  let offset = initialOffset;
  let expandedLength = 1;
  while (true) {
    if (offset >= bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query name is truncated");
    }
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length === 0) break;
    if ((length & 0xc0) !== 0 || length > 63 || offset + length > bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query name is malformed");
    }
    const labelBytes = bytes.subarray(offset, offset + length);
    let label: string;
    try {
      label = decoder.decode(labelBytes);
    } catch {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query label is not UTF-8");
    }
    if (!/^(?:_pirate|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u.test(label)) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query label is not canonical");
    }
    expandedLength += length + 1;
    if (expandedLength > 255) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query name is too long");
    }
    labels.push(label);
    offset += length;
  }
  return { labels, next_offset: offset };
}

export function decodeHnsAuthoritativeDnsQueryV1(
  value: unknown,
): HnsAuthoritativeDnsDecodedQueryV1 {
  if (!(value instanceof Uint8Array)) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query must be exact bytes");
  }
  const bytes = new Uint8Array(value);
  if (
    bytes.byteLength < 28 ||
    readUint16(bytes, 2) !== 0 ||
    readUint16(bytes, 4) !== 1 ||
    readUint16(bytes, 6) !== 0 ||
    readUint16(bytes, 8) !== 0 ||
    readUint16(bytes, 10) !== 1
  ) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query header is invalid");
  }
  const name = readUncompressedQueryLabels(bytes, 12);
  let offset = name.next_offset;
  const queryType = readUint16(bytes, offset);
  const queryClass = readUint16(bytes, offset + 2);
  offset += 4;
  const queryKind = queryType === 48 ? "dnskey" : queryType === 16 ? "control_txt" : null;
  if (
    queryKind === null ||
    queryClass !== 1 ||
    (queryKind === "dnskey" && name.labels.length !== 1) ||
    (queryKind === "control_txt" && (name.labels.length !== 2 || name.labels[0] !== "_pirate"))
  ) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS question is invalid");
  }
  const rootLabel = name.labels[name.labels.length - 1];
  if (rootLabel === undefined) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS root label is absent");
  }
  assertRootLabel(rootLabel);
  if (
    offset + 11 !== bytes.byteLength ||
    bytes[offset] !== 0 ||
    readUint16(bytes, offset + 1) !== 41 ||
    readUint16(bytes, offset + 3) !== HNS_AUTHORITATIVE_DNS_QUERY_UDP_PAYLOAD_SIZE ||
    bytes[offset + 5] !== 0 ||
    bytes[offset + 6] !== 0 ||
    readUint16(bytes, offset + 7) !== 0x8000 ||
    readUint16(bytes, offset + 9) !== 0
  ) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS query OPT record is invalid");
  }
  return {
    message_id: readUint16(bytes, 0),
    query_kind: queryKind,
    root_label: rootLabel,
  };
}

export type HnsAuthoritativeDnsDecodedQuestionV1 = Readonly<{
  readonly name: string;
  readonly type: number;
  readonly record_class: number;
}>;

export type HnsAuthoritativeDnsDecodedRecordV1 = Readonly<{
  readonly section: "answer" | "authority" | "additional";
  readonly section_index: number;
  readonly owner: string;
  readonly owner_label_count: number;
  readonly owner_canonical_wire: Uint8Array;
  readonly owner_original_wire: Uint8Array;
  readonly type: number;
  readonly record_class: number;
  readonly ttl: number;
  readonly rdata: Uint8Array;
  readonly rdata_offset: number;
}>;

export type HnsAuthoritativeDnsDecodedResponseV1 = Readonly<{
  readonly message_bytes: Uint8Array;
  readonly known_name_offsets: ReadonlySet<number>;
  readonly message_id: number;
  readonly flags: number;
  readonly rcode: number;
  readonly question: HnsAuthoritativeDnsDecodedQuestionV1;
  readonly answers: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>;
  readonly authorities: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>;
  readonly additionals: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>;
}>;

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS integer crosses the message");
  }
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function asciiDnsLabel(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e || byte === 0x2e) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS name label is not ASCII");
    }
    const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    value += String.fromCharCode(lower);
  }
  return value;
}

function dnsLabelIdentity(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    if (lower >= 0x21 && lower <= 0x7e && lower !== 0x2e && lower !== 0x5c) {
      value += String.fromCharCode(lower);
    } else {
      value += `\\${lower.toString(16).padStart(2, "0")}`;
    }
  }
  return value;
}

function readResponseQuestionName(
  bytes: Uint8Array,
  initialOffset: number,
  knownNameOffsets: Set<number>,
): Readonly<{ readonly name: string; readonly next_offset: number }> {
  const labels: string[] = [];
  let offset = initialOffset;
  let expandedLength = 1;
  while (true) {
    if (offset >= bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError(
        "HNS authoritative DNS response question is truncated",
      );
    }
    knownNameOffsets.add(offset);
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length === 0) break;
    if ((length & 0xc0) !== 0 || length > 63 || offset + length > bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError(
        "HNS authoritative DNS response question is malformed",
      );
    }
    labels.push(asciiDnsLabel(bytes.subarray(offset, offset + length)));
    expandedLength += length + 1;
    if (expandedLength > 255) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS expanded name is too long");
    }
    offset += length;
  }
  return { name: labels.join("."), next_offset: offset };
}

function readCompressedName(
  bytes: Uint8Array,
  initialOffset: number,
  knownNameOffsets: Set<number>,
): HnsAuthoritativeDnsDecodedNameV1 {
  const labels: Uint8Array[] = [];
  const visited = new Set<number>();
  let offset = initialOffset;
  let nextOffset: number | null = null;
  let expandedLength = 1;
  let jumps = 0;
  while (true) {
    if (offset >= bytes.byteLength || visited.has(offset)) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS compressed name is invalid");
    }
    visited.add(offset);
    knownNameOffsets.add(offset);
    const length = bytes[offset] ?? 0;
    if ((length & 0xc0) === 0xc0) {
      if (offset + 2 > bytes.byteLength) {
        throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS pointer is truncated");
      }
      const target = ((length & 0x3f) << 8) | (bytes[offset + 1] ?? 0);
      if (target >= offset || !knownNameOffsets.has(target) || jumps >= 128) {
        throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS pointer is invalid");
      }
      if (nextOffset === null) nextOffset = offset + 2;
      offset = target;
      jumps += 1;
      continue;
    }
    if ((length & 0xc0) !== 0) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS label kind is reserved");
    }
    offset += 1;
    if (length === 0) {
      if (nextOffset === null) nextOffset = offset;
      break;
    }
    if (length > 63 || offset + length > bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS label crosses the message");
    }
    labels.push(new Uint8Array(bytes.subarray(offset, offset + length)));
    expandedLength += length + 1;
    if (expandedLength > 255) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS expanded name is too long");
    }
    offset += length;
  }
  return {
    name: labels.map(dnsLabelIdentity).join("."),
    label_count: labels.length,
    canonical_wire: expandedNameWire(labels, true),
    original_wire: expandedNameWire(labels, false),
    next_offset: nextOffset,
  };
}

export type HnsAuthoritativeDnsDecodedNameV1 = Readonly<{
  readonly name: string;
  readonly label_count: number;
  readonly canonical_wire: Uint8Array;
  readonly original_wire: Uint8Array;
  readonly next_offset: number;
}>;

function expandedNameWire(labels: ReadonlyArray<Uint8Array>, lowercase: boolean): Uint8Array {
  const length = labels.reduce((total, label) => total + 1 + label.byteLength, 1);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const label of labels) {
    bytes[offset] = label.byteLength;
    offset += 1;
    for (const byte of label) {
      bytes[offset] = lowercase && byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
      offset += 1;
    }
  }
  return bytes;
}

function decodeHnsAuthoritativeDnsRdataNameWithOffsetsV1(
  input: Readonly<{
    readonly message_bytes: Uint8Array;
    readonly initial_offset: number;
    readonly encoded_end_offset: number;
    readonly known_name_offsets: Set<number>;
  }>,
): HnsAuthoritativeDnsDecodedNameV1 {
  const bytes = input.message_bytes;
  if (
    !Number.isSafeInteger(input.initial_offset) ||
    !Number.isSafeInteger(input.encoded_end_offset) ||
    input.initial_offset < 0 ||
    input.initial_offset >= input.encoded_end_offset ||
    input.encoded_end_offset > bytes.byteLength
  ) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA name bounds are invalid");
  }
  const labels: Uint8Array[] = [];
  const visited = new Set<number>();
  let offset = input.initial_offset;
  let nextOffset: number | null = null;
  let expandedLength = 1;
  let jumps = 0;
  while (true) {
    const directLimit = nextOffset === null ? input.encoded_end_offset : bytes.byteLength;
    if (offset >= directLimit || visited.has(offset)) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA name is invalid");
    }
    visited.add(offset);
    input.known_name_offsets.add(offset);
    const length = bytes[offset] ?? 0;
    if ((length & 0xc0) === 0xc0) {
      if (offset + 2 > directLimit) {
        throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA pointer is truncated");
      }
      const target = ((length & 0x3f) << 8) | (bytes[offset + 1] ?? 0);
      if (target >= offset || !input.known_name_offsets.has(target) || jumps >= 128) {
        throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA pointer is invalid");
      }
      if (nextOffset === null) nextOffset = offset + 2;
      offset = target;
      jumps += 1;
      continue;
    }
    if ((length & 0xc0) !== 0) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA label is reserved");
    }
    offset += 1;
    if (length === 0) {
      if (nextOffset === null) nextOffset = offset;
      break;
    }
    if (length > 63 || offset + length > directLimit) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA label is truncated");
    }
    const label = new Uint8Array(bytes.subarray(offset, offset + length));
    labels.push(label);
    expandedLength += length + 1;
    if (expandedLength > 255) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA name is too long");
    }
    offset += length;
  }
  const canonicalWire = expandedNameWire(labels, true);
  return {
    name: labels.map(dnsLabelIdentity).join("."),
    label_count: labels.length,
    canonical_wire: canonicalWire,
    original_wire: expandedNameWire(labels, false),
    next_offset: nextOffset,
  };
}

export function decodeHnsAuthoritativeDnsRdataNameV1(
  input: Readonly<{
    readonly message_bytes: Uint8Array;
    readonly initial_offset: number;
    readonly encoded_end_offset: number;
    readonly known_name_offsets: ReadonlySet<number>;
  }>,
): HnsAuthoritativeDnsDecodedNameV1 {
  return decodeHnsAuthoritativeDnsRdataNameWithOffsetsV1({
    ...input,
    known_name_offsets: new Set(input.known_name_offsets),
  });
}

function registerKnownRdataNameOffsets(
  bytes: Uint8Array,
  type: number,
  rdataOffset: number,
  rdataLength: number,
  knownNameOffsets: Set<number>,
): void {
  const end = rdataOffset + rdataLength;
  if (type === 6 && rdataLength > 0) {
    const mname = decodeHnsAuthoritativeDnsRdataNameWithOffsetsV1({
      message_bytes: bytes,
      initial_offset: rdataOffset,
      encoded_end_offset: end,
      known_name_offsets: knownNameOffsets,
    });
    decodeHnsAuthoritativeDnsRdataNameWithOffsetsV1({
      message_bytes: bytes,
      initial_offset: mname.next_offset,
      encoded_end_offset: end,
      known_name_offsets: knownNameOffsets,
    });
  } else if (type === 46 && rdataLength >= 19) {
    decodeHnsAuthoritativeDnsRdataNameWithOffsetsV1({
      message_bytes: bytes,
      initial_offset: rdataOffset + 18,
      encoded_end_offset: end,
      known_name_offsets: knownNameOffsets,
    });
  } else if (type === 47 && rdataLength > 0) {
    decodeHnsAuthoritativeDnsRdataNameWithOffsetsV1({
      message_bytes: bytes,
      initial_offset: rdataOffset,
      encoded_end_offset: end,
      known_name_offsets: knownNameOffsets,
    });
  }
}

function parseDnsRecords(
  bytes: Uint8Array,
  initialOffset: number,
  count: number,
  knownNameOffsets: Set<number>,
  section: HnsAuthoritativeDnsDecodedRecordV1["section"],
): Readonly<{
  readonly records: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>;
  readonly next_offset: number;
}> {
  const records: HnsAuthoritativeDnsDecodedRecordV1[] = [];
  let offset = initialOffset;
  for (let index = 0; index < count; index += 1) {
    const owner = readCompressedName(bytes, offset, knownNameOffsets);
    offset = owner.next_offset;
    if (offset + 10 > bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS record header is truncated");
    }
    const type = readUint16(bytes, offset);
    const recordClass = readUint16(bytes, offset + 2);
    const ttl = readUint32(bytes, offset + 4);
    const rdataLength = readUint16(bytes, offset + 8);
    offset += 10;
    if (offset + rdataLength > bytes.byteLength) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS RDATA crosses the message");
    }
    try {
      registerKnownRdataNameOffsets(bytes, type, offset, rdataLength, knownNameOffsets);
    } catch {
      // Semantic validators reject malformed named RDATA. The response grammar still consumes it.
    }
    records.push({
      section,
      section_index: index,
      owner: owner.name,
      owner_label_count: owner.label_count,
      owner_canonical_wire: owner.canonical_wire,
      owner_original_wire: owner.original_wire,
      type,
      record_class: recordClass,
      ttl,
      rdata: new Uint8Array(bytes.subarray(offset, offset + rdataLength)),
      rdata_offset: offset,
    });
    offset += rdataLength;
  }
  return { records, next_offset: offset };
}

export function decodeHnsAuthoritativeDnsResponseV1(
  value: Uint8Array,
): HnsAuthoritativeDnsDecodedResponseV1 {
  const bytes = new Uint8Array(value);
  if (bytes.byteLength < 12 || bytes.byteLength > 65_535) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS response length is invalid");
  }
  const flags = readUint16(bytes, 2);
  if (
    (flags & 0x8000) === 0 ||
    (flags & 0x7800) !== 0 ||
    (flags & 0x0200) !== 0 ||
    (flags & 0x0100) !== 0 ||
    (flags & 0x0040) !== 0 ||
    (flags & 0x0010) !== 0 ||
    readUint16(bytes, 4) !== 1
  ) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS response header is invalid");
  }
  const answerCount = readUint16(bytes, 6);
  const authorityCount = readUint16(bytes, 8);
  const additionalCount = readUint16(bytes, 10);
  const knownNameOffsets = new Set<number>();
  const questionName = readResponseQuestionName(bytes, 12, knownNameOffsets);
  let offset = questionName.next_offset;
  const question: HnsAuthoritativeDnsDecodedQuestionV1 = {
    name: questionName.name,
    type: readUint16(bytes, offset),
    record_class: readUint16(bytes, offset + 2),
  };
  offset += 4;
  const answers = parseDnsRecords(bytes, offset, answerCount, knownNameOffsets, "answer");
  offset = answers.next_offset;
  const authorities = parseDnsRecords(bytes, offset, authorityCount, knownNameOffsets, "authority");
  offset = authorities.next_offset;
  const additionals = parseDnsRecords(
    bytes,
    offset,
    additionalCount,
    knownNameOffsets,
    "additional",
  );
  if (additionals.next_offset !== bytes.byteLength) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS response has trailing bytes");
  }
  return {
    message_bytes: bytes,
    known_name_offsets: new Set(knownNameOffsets),
    message_id: readUint16(bytes, 0),
    flags,
    rcode: flags & 0x000f,
    question,
    answers: answers.records,
    authorities: authorities.records,
    additionals: additionals.records,
  };
}

function expectedQuestionName(query: HnsAuthoritativeDnsDecodedQueryV1): string {
  return query.query_kind === "dnskey" ? query.root_label : `_pirate.${query.root_label}`;
}

function validResponseOpt(record: HnsAuthoritativeDnsDecodedRecordV1): boolean {
  return (
    record.owner === "" &&
    record.type === 41 &&
    record.record_class >= 512 &&
    record.record_class <= 65_535 &&
    record.ttl >>> 16 === 0 &&
    (record.ttl & 0xffff) === 0x8000 &&
    record.rdata.byteLength === 0
  );
}

function rrsigCovers(
  record: HnsAuthoritativeDnsDecodedRecordV1,
  owner: string,
  type: number,
): boolean {
  return (
    record.owner === owner &&
    record.type === 46 &&
    record.record_class === 1 &&
    record.rdata.byteLength >= 18 &&
    readUint16(record.rdata, 0) === type
  );
}

function parseTxtRecord(record: HnsAuthoritativeDnsDecodedRecordV1): HnsObservedTxtRecord {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < record.rdata.byteLength) {
    const length = record.rdata[offset] ?? 0;
    offset += 1;
    if (offset + length > record.rdata.byteLength) {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS TXT chunk is truncated");
    }
    try {
      chunks.push(decoder.decode(record.rdata.subarray(offset, offset + length)));
    } catch {
      throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS TXT chunk is not UTF-8");
    }
    offset += length;
  }
  if (chunks.length === 0) {
    throw new HnsAuthoritativeDnsWireError("HNS authoritative DNS TXT record is empty");
  }
  return { chunks };
}

export function classifyHnsAuthoritativeDnsResponseV1(
  input: Readonly<{
    readonly request_bytes: Uint8Array;
    readonly response_bytes: Uint8Array;
  }>,
): HnsAuthoritativeDnsResponseClassificationV1 {
  let query: HnsAuthoritativeDnsDecodedQueryV1;
  let response: HnsAuthoritativeDnsDecodedResponseV1;
  try {
    query = decodeHnsAuthoritativeDnsQueryV1(input.request_bytes);
    response = decodeHnsAuthoritativeDnsResponseV1(input.response_bytes);
  } catch {
    return { kind: "inconclusive" };
  }
  if (
    response.message_id !== query.message_id ||
    response.question.name !== expectedQuestionName(query) ||
    response.question.type !== (query.query_kind === "dnskey" ? 48 : 16) ||
    response.question.record_class !== 1 ||
    response.additionals.length !== 1 ||
    !validResponseOpt(response.additionals[0] as HnsAuthoritativeDnsDecodedRecordV1)
  ) {
    return { kind: "inconclusive" };
  }
  if (response.rcode === 2) return { kind: "servfail" };
  if ((response.rcode !== 0 && response.rcode !== 3) || (response.flags & 0x0400) === 0) {
    return { kind: "inconclusive" };
  }
  const hasAlias = [...response.answers, ...response.authorities].some(
    (record) => record.type === 5 || record.type === 39,
  );
  const hasReferral = response.authorities.some((record) => record.type === 2);
  const misplacedOpt = [...response.answers, ...response.authorities].some(
    (record) => record.type === 41,
  );
  if (hasAlias || hasReferral || misplacedOpt) return { kind: "inconclusive" };

  if (query.query_kind === "dnskey") {
    if (response.rcode !== 0) return { kind: "inconclusive" };
    if (
      response.authorities.some(
        (record) =>
          record.type === 48 ||
          (record.type === 46 &&
            record.rdata.byteLength >= 2 &&
            readUint16(record.rdata, 0) === 48),
      )
    ) {
      return { kind: "inconclusive" };
    }
    const keys = response.answers.filter(
      (record) =>
        record.owner === query.root_label && record.type === 48 && record.record_class === 1,
    );
    const signatures = response.answers.filter((record) =>
      rrsigCovers(record, query.root_label, 48),
    );
    return keys.length > 0 && signatures.length > 0 ? { kind: "dnskey" } : { kind: "inconclusive" };
  }

  const queriedName = expectedQuestionName(query);
  if (
    [...response.authorities, ...response.additionals].some(
      (record) =>
        record.owner === queriedName &&
        (record.type === 16 ||
          (record.type === 46 &&
            record.rdata.byteLength >= 2 &&
            readUint16(record.rdata, 0) === 16)),
    )
  ) {
    return { kind: "inconclusive" };
  }
  const txtRecords = response.answers.filter(
    (record) => record.owner === queriedName && record.type === 16 && record.record_class === 1,
  );
  if (txtRecords.length > 0) {
    if (
      response.rcode !== 0 ||
      !response.answers.some((record) => rrsigCovers(record, queriedName, 16))
    ) {
      return { kind: "inconclusive" };
    }
    try {
      return { kind: "txt_values", observed_txt_records: txtRecords.map(parseTxtRecord) };
    } catch {
      return { kind: "inconclusive" };
    }
  }
  if (response.answers.length !== 0) return { kind: "inconclusive" };
  const hasSoa = response.authorities.some(
    (record) => record.type === 6 && record.record_class === 1,
  );
  const denialTypes = response.authorities
    .filter((record) => (record.type === 47 || record.type === 50) && record.record_class === 1)
    .map((record) => record.type);
  const soaOwners = response.authorities
    .filter((record) => record.type === 6 && record.record_class === 1)
    .map((record) => record.owner);
  const denialRecords = response.authorities.filter(
    (record) => (record.type === 47 || record.type === 50) && record.record_class === 1,
  );
  const hasSoaSignature = soaOwners.some((owner) =>
    response.authorities.some((record) => rrsigCovers(record, owner, 6)),
  );
  const hasDenialSignature = denialRecords.some((denial) =>
    response.authorities.some((record) => rrsigCovers(record, denial.owner, denial.type)),
  );
  if (!hasSoa || denialTypes.length === 0 || !hasSoaSignature || !hasDenialSignature) {
    return { kind: "inconclusive" };
  }
  return response.rcode === 3 ? { kind: "nxdomain" } : { kind: "nodata" };
}

export function selectHnsAuthoritativeDnsAuthorityTupleV1(
  authorityRecords: ReadonlyArray<HnsChainAuthorityRecord>,
  viewOrdinal: number,
): HnsAuthoritativeDnsAuthorityTupleV1 | null {
  if (!Number.isSafeInteger(viewOrdinal) || viewOrdinal < 0) {
    throw new TypeError("HNS authoritative DNS view ordinal is invalid");
  }
  const records = hnsChainAuthorityRecords("owner_authoritative_dns_txt", authorityRecords);
  const nameservers = new Set(
    records.filter((record) => record[0] === "NS").map((record) => record[1]),
  );
  const tuples = new Map<string, HnsAuthoritativeDnsAuthorityTupleV1>();
  for (const record of records) {
    if ((record[0] !== "GLUE4" && record[0] !== "GLUE6") || !nameservers.has(record[1])) {
      continue;
    }
    const tuple: HnsAuthoritativeDnsAuthorityTupleV1 = {
      authority_nameserver: record[1],
      authority_address_family: record[0],
      authority_address: record[2],
    };
    tuples.set(JSON.stringify(tuple), tuple);
  }
  const ordered = [...tuples.values()].sort((left, right) => {
    const byNameserver = compareUtf8(left.authority_nameserver, right.authority_nameserver);
    if (byNameserver !== 0) return byNameserver;
    if (left.authority_address_family !== right.authority_address_family) {
      return left.authority_address_family === "GLUE4" ? -1 : 1;
    }
    return compareUtf8(left.authority_address, right.authority_address);
  });
  return ordered.length === 0 ? null : (ordered[viewOrdinal % ordered.length] ?? null);
}

async function sha256Bytes(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Schema.decodeUnknownSync(Sha256Hex)(hex);
}

function isExactObject(
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

export async function validateHnsAuthoritativeDnsValidationResultV1(
  input: Readonly<{
    readonly value: unknown;
    readonly dnskey_response_bytes: Uint8Array;
    readonly control_response_bytes: Uint8Array;
    readonly chain_authority_digest: Sha256HexValue;
  }>,
): Promise<HnsAuthoritativeDnsValidationResultV1> {
  if (!isExactObject(input.value, validationResultKeys)) {
    throw new HnsAuthoritativeDnsAdapterResultError(
      "HNS authoritative DNS validator result members are invalid",
    );
  }
  const value = input.value;
  if (
    !validationValues.includes(value.dnssec_validation as HnsAuthoritativeDnsValidationV1) ||
    !Schema.is(Sha256Hex)(value.validated_dnskey_response_sha256) ||
    !Schema.is(Sha256Hex)(value.validated_control_response_sha256) ||
    !Schema.is(Sha256Hex)(value.validated_chain_authority_digest)
  ) {
    throw new HnsAuthoritativeDnsAdapterResultError(
      "HNS authoritative DNS validator result values are invalid",
    );
  }
  const dnskeyHash = await sha256Bytes(input.dnskey_response_bytes);
  const controlHash = await sha256Bytes(input.control_response_bytes);
  if (
    value.validated_dnskey_response_sha256 !== dnskeyHash ||
    value.validated_control_response_sha256 !== controlHash ||
    value.validated_chain_authority_digest !== input.chain_authority_digest
  ) {
    throw new HnsAuthoritativeDnsAdapterResultError(
      "HNS authoritative DNS validator result authority does not match exact inputs",
    );
  }
  return {
    dnssec_validation: value.dnssec_validation as HnsAuthoritativeDnsValidationV1,
    validated_dnskey_response_sha256: dnskeyHash,
    validated_control_response_sha256: controlHash,
    validated_chain_authority_digest: input.chain_authority_digest,
  };
}

function assertSemanticView(view: HnsAuthoritativeDnsSemanticViewV1): void {
  let canonicalTuple = false;
  try {
    const records = hnsChainAuthorityRecords("owner_authoritative_dns_txt", [
      ["NS", view.authority_nameserver],
      [
        view.authority_address_family,
        view.authority_nameserver,
        view.authority_address,
      ] as HnsChainAuthorityRecord,
    ]);
    canonicalTuple =
      records.some((record) => record[0] === "NS" && record[1] === view.authority_nameserver) &&
      records.some(
        (record) =>
          record[0] === view.authority_address_family &&
          record[1] === view.authority_nameserver &&
          record[2] === view.authority_address,
      );
  } catch {
    canonicalTuple = false;
  }
  if (
    !viewIdPattern.test(view.view_id) ||
    !canonicalTuple ||
    !Schema.is(Sha256Hex)(view.dnskey_request_sha256) ||
    !Schema.is(Sha256Hex)(view.dnskey_response_sha256) ||
    !Schema.is(Sha256Hex)(view.control_request_sha256) ||
    !Schema.is(Sha256Hex)(view.control_response_sha256) ||
    !Schema.is(Sha256Hex)(view.chain_authority_digest) ||
    !canonicalInstantPattern.test(view.validation_database_time) ||
    new Date(view.validation_database_time).toISOString() !== view.validation_database_time ||
    !validationValues.includes(view.dnssec_validation)
  ) {
    throw new TypeError("HNS authoritative DNS semantic view is invalid");
  }
  if (view.dnssec_validation === "secure") {
    if (
      (view.semantic_class !== "txt_values" &&
        view.semantic_class !== "nxdomain" &&
        view.semantic_class !== "nodata") ||
      (view.semantic_class === "txt_values") !== (view.observed_txt_values_digest !== null) ||
      (view.observed_txt_values_digest !== null &&
        !Schema.is(Sha256Hex)(view.observed_txt_values_digest))
    ) {
      throw new TypeError("HNS authoritative DNS secure semantic view is inconsistent");
    }
  } else if (view.semantic_class !== null || view.observed_txt_values_digest !== null) {
    throw new TypeError("HNS authoritative DNS non-secure semantic view contains authority");
  }
}

export function encodeHnsAuthoritativeDnsSemanticFactsV1(
  views: ReadonlyArray<HnsAuthoritativeDnsSemanticViewV1>,
): Uint8Array {
  if (views.length > HNS_AUTHORITATIVE_DNS_OWNER_VIEW_MAX_COUNT) {
    throw new TypeError("HNS authoritative DNS semantic view limit was exceeded");
  }
  const seen = new Set<string>();
  const retained = views.map((view) => {
    assertSemanticView(view);
    if (seen.has(view.view_id)) {
      throw new TypeError("HNS authoritative DNS semantic views are duplicated");
    }
    seen.add(view.view_id);
    return {
      view_id: view.view_id,
      authority_nameserver: view.authority_nameserver,
      authority_address_family: view.authority_address_family,
      authority_address: view.authority_address,
      dnskey_request_sha256: view.dnskey_request_sha256,
      dnskey_response_sha256: view.dnskey_response_sha256,
      control_request_sha256: view.control_request_sha256,
      control_response_sha256: view.control_response_sha256,
      chain_authority_digest: view.chain_authority_digest,
      validation_database_time: view.validation_database_time,
      dnssec_validation: view.dnssec_validation,
      semantic_class: view.semantic_class,
      observed_txt_values_digest: view.observed_txt_values_digest,
    };
  });
  return encoder.encode(
    JSON.stringify({ version: HNS_AUTHORITATIVE_DNS_SEMANTIC_FACTS_VERSION, views: retained }),
  );
}

export function decodeHnsAuthoritativeDnsSemanticFactsV1(
  value: unknown,
): HnsAuthoritativeDnsDecodedSemanticFactsV1 {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("HNS authoritative DNS semantic facts must be exact bytes");
  }
  const bytes = new Uint8Array(value);
  const decoded = decodeStrictHnsJsonBytes(bytes, HNS_AUTHORITATIVE_DNS_SEMANTIC_FACTS_MAX_BYTES);
  if (!isExactObject(decoded, ["version", "views"])) {
    throw new TypeError("HNS authoritative DNS semantic-facts members are invalid");
  }
  if (
    decoded.version !== HNS_AUTHORITATIVE_DNS_SEMANTIC_FACTS_VERSION ||
    !Array.isArray(decoded.views) ||
    decoded.views.length > HNS_AUTHORITATIVE_DNS_OWNER_VIEW_MAX_COUNT
  ) {
    throw new TypeError("HNS authoritative DNS semantic-facts authority is invalid");
  }
  const viewKeys = [
    "view_id",
    "authority_nameserver",
    "authority_address_family",
    "authority_address",
    "dnskey_request_sha256",
    "dnskey_response_sha256",
    "control_request_sha256",
    "control_response_sha256",
    "chain_authority_digest",
    "validation_database_time",
    "dnssec_validation",
    "semantic_class",
    "observed_txt_values_digest",
  ] as const;
  const views = decoded.views.map((view) => {
    if (!isExactObject(view, viewKeys)) {
      throw new TypeError("HNS authoritative DNS semantic-view members are invalid");
    }
    const typed = view as HnsAuthoritativeDnsSemanticViewV1;
    assertSemanticView(typed);
    return typed;
  });
  const canonical = encodeHnsAuthoritativeDnsSemanticFactsV1(views);
  if (
    canonical.byteLength !== bytes.byteLength ||
    canonical.some((byte, index) => byte !== bytes[index])
  ) {
    throw new TypeError("HNS authoritative DNS semantic facts are not canonical bytes");
  }
  return { semantic_facts_bytes: bytes, views };
}
