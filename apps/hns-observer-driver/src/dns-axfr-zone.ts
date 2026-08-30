import {
  canonicalHnsDnsNameV1,
  decodeHnsDnsTcpMessageSequenceV1,
  type HnsDnsParsedRecordV1,
  HnsDnsTsigAxfrError,
  parseHnsDnsTsigAxfrResponseV1,
  readHnsDnsNameV1,
} from "./dns-tsig-axfr.ts";

export const HNS_CANONICAL_AUTHORITY_ZONE_VERSION =
  "pirate-hns-canonical-authority-zone-v1" as const;

type HnsCanonicalAuthorityZoneRecordV1 = readonly [
  owner: string,
  type: number,
  record_class: 1,
  ttl: number,
  rdata_hex: string,
];

const encoder = new TextEncoder();
const IN_CLASS = 1;
const SOA_TYPE = 6;
const RRSIG_TYPE = 46;

function failed(message: string): HnsDnsTsigAxfrError {
  return new HnsDnsTsigAxfrError(message);
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function encodeName(value: string): Uint8Array {
  const labels = canonicalHnsDnsNameV1(value)
    .split(".")
    .map((label) => encoder.encode(label));
  return concat([
    ...labels.map((label) => new Uint8Array([label.byteLength, ...label])),
    new Uint8Array([0]),
  ]);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw failed("truncated DNS integer");
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function canonicalSingleNameRdata(bytes: Uint8Array, record: HnsDnsParsedRecordV1): Uint8Array {
  const target = readHnsDnsNameV1(bytes, record.rdata_offset);
  if (target.next_offset !== record.end_offset) throw failed("invalid AXFR domain-name data");
  return encodeName(target.name);
}

function canonicalPrefixedNameRdata(
  bytes: Uint8Array,
  record: HnsDnsParsedRecordV1,
  prefixBytes: number,
): Uint8Array {
  if (record.rdata_offset + prefixBytes >= record.end_offset) {
    throw failed("invalid AXFR prefixed domain-name data");
  }
  const target = readHnsDnsNameV1(bytes, record.rdata_offset + prefixBytes);
  if (target.next_offset !== record.end_offset) {
    throw failed("invalid AXFR prefixed domain-name data");
  }
  return concat([
    bytes.slice(record.rdata_offset, record.rdata_offset + prefixBytes),
    encodeName(target.name),
  ]);
}

function canonicalSoaRdata(bytes: Uint8Array, record: HnsDnsParsedRecordV1): Uint8Array {
  const mname = readHnsDnsNameV1(bytes, record.rdata_offset);
  const rname = readHnsDnsNameV1(bytes, mname.next_offset);
  if (rname.next_offset + 20 !== record.end_offset) throw failed("invalid AXFR SOA data");
  return concat([
    encodeName(mname.name),
    encodeName(rname.name),
    bytes.slice(rname.next_offset, record.end_offset),
  ]);
}

function validateTxtRdata(bytes: Uint8Array, record: HnsDnsParsedRecordV1): Uint8Array {
  let offset = record.rdata_offset;
  while (offset < record.end_offset) {
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (offset + length > record.end_offset) throw failed("invalid AXFR TXT data");
    offset += length;
  }
  return bytes.slice(record.rdata_offset, record.end_offset);
}

function canonicalNsecRdata(bytes: Uint8Array, record: HnsDnsParsedRecordV1): Uint8Array {
  const nextName = readHnsDnsNameV1(bytes, record.rdata_offset);
  if (nextName.next_offset >= record.end_offset) throw failed("invalid AXFR NSEC data");
  return concat([encodeName(nextName.name), bytes.slice(nextName.next_offset, record.end_offset)]);
}

function canonicalRecordRdata(bytes: Uint8Array, record: HnsDnsParsedRecordV1): Uint8Array | null {
  if (record.record_class !== IN_CLASS) throw failed("AXFR answer is not IN class");
  const length = record.end_offset - record.rdata_offset;
  switch (record.type) {
    case RRSIG_TYPE:
      return null;
    case 1:
      if (length !== 4) throw failed("invalid AXFR A data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 2:
    case 5:
    case 12:
    case 39:
      return canonicalSingleNameRdata(bytes, record);
    case SOA_TYPE:
      return canonicalSoaRdata(bytes, record);
    case 15:
      return canonicalPrefixedNameRdata(bytes, record, 2);
    case 16:
      return validateTxtRdata(bytes, record);
    case 28:
      if (length !== 16) throw failed("invalid AXFR AAAA data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 33:
      return canonicalPrefixedNameRdata(bytes, record, 6);
    case 43:
      if (length < 5) throw failed("invalid AXFR DS data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 44:
      if (length < 3) throw failed("invalid AXFR SSHFP data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 47:
      return canonicalNsecRdata(bytes, record);
    case 48:
      if (length < 5) throw failed("invalid AXFR DNSKEY data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 50:
      if (length < 6) throw failed("invalid AXFR NSEC3 data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 51:
      if (length < 5) throw failed("invalid AXFR NSEC3PARAM data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 52:
      if (length < 4) throw failed("invalid AXFR TLSA data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    case 257: {
      if (length < 3) throw failed("invalid AXFR CAA data");
      const tagLength = bytes[record.rdata_offset + 1] ?? 0;
      if (tagLength === 0 || tagLength + 2 > length) throw failed("invalid AXFR CAA data");
      return bytes.slice(record.rdata_offset, record.end_offset);
    }
    default:
      throw failed("unsupported AXFR record type");
  }
}

function canonicalZoneRecord(
  bytes: Uint8Array,
  record: HnsDnsParsedRecordV1,
): HnsCanonicalAuthorityZoneRecordV1 | null {
  const rdata = canonicalRecordRdata(bytes, record);
  return rdata === null ? null : [record.name, record.type, IN_CLASS, record.ttl, hex(rdata)];
}

function compareRecords(
  left: HnsCanonicalAuthorityZoneRecordV1,
  right: HnsCanonicalAuthorityZoneRecordV1,
): number {
  const leftBytes = JSON.stringify(left);
  const rightBytes = JSON.stringify(right);
  return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
}

/**
 * Reconstructs stable canonical zone content from a TSIG-bearing AXFR after
 * the acquisition session has authenticated its MAC chain. Online RRSIG
 * records are omitted because signature timing may differ between authorities.
 */
export function deriveCanonicalHnsAuthorityZoneBytesV1(
  input: Readonly<{
    zone_name: string;
    response_sequence_bytes: Uint8Array;
  }>,
): Uint8Array {
  const zoneName = canonicalHnsDnsNameV1(input.zone_name);
  const messages = decodeHnsDnsTcpMessageSequenceV1(input.response_sequence_bytes);
  const firstMessage = messages[0];
  if (firstMessage === undefined || firstMessage.byteLength < 2) {
    throw failed("invalid AXFR message sequence");
  }
  const messageId = readUint16(firstMessage, 0);
  const records: HnsCanonicalAuthorityZoneRecordV1[] = [];
  let openingSoa: Uint8Array | undefined;
  let closingSoaSeen = false;
  let apexNsCount = 0;
  for (const [messageIndex, message] of messages.entries()) {
    const parsed = parseHnsDnsTsigAxfrResponseV1(message, messageId, zoneName, messageIndex);
    apexNsCount += parsed.apex_ns_count;
    for (const record of parsed.answer_records) {
      const canonical = canonicalZoneRecord(message, record);
      if (canonical !== null) records.push(canonical);
    }
    for (const soa of parsed.soa_records) {
      if (openingSoa === undefined) {
        if (messageIndex !== 0 || soa.answer_index !== 0) {
          throw failed("AXFR does not begin with SOA");
        }
        openingSoa = soa.bytes;
      } else {
        if (
          !equalBytes(openingSoa, soa.bytes) ||
          messageIndex !== messages.length - 1 ||
          soa.answer_index !== parsed.answer_count - 1 ||
          closingSoaSeen
        ) {
          throw failed("AXFR terminal SOA mismatch");
        }
        closingSoaSeen = true;
      }
    }
  }
  const soaIndexes = records.flatMap((record, index) => (record[1] === SOA_TYPE ? [index] : []));
  const closingSoaIndex = soaIndexes[1];
  if (
    openingSoa === undefined ||
    !closingSoaSeen ||
    soaIndexes.length !== 2 ||
    closingSoaIndex === undefined ||
    apexNsCount === 0
  ) {
    throw failed("incomplete AXFR message sequence");
  }
  records.splice(closingSoaIndex, 1);
  records.sort(compareRecords);
  if (
    records.some((record, index) => {
      const previous = index > 0 ? records[index - 1] : undefined;
      return previous !== undefined && compareRecords(record, previous) === 0;
    })
  ) {
    throw failed("duplicate AXFR zone record");
  }
  const bytes = encoder.encode(
    JSON.stringify({
      version: HNS_CANONICAL_AUTHORITY_ZONE_VERSION,
      root_label: zoneName,
      records,
    }),
  );
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) {
    throw failed("canonical AXFR zone is too large");
  }
  return bytes;
}
