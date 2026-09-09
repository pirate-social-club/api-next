import type { HnsRootResourceRecordV1 } from "./hns-root-import-plan.ts";

/**
 * HSD-compatible resource wire codec — spec 012 "Plan construction and
 * exposure" (2026-09-09 amendment). The final complete resource is encoded
 * with the same wire format hsd's `Resource.encode` produces (version byte
 * 0 followed by type-prefixed records, DNS label names with shared
 * compression, consensus limit `rules.MAX_RESOURCE_SIZE = 512`), the limit
 * is enforced on the real encoded output, and the specified round trip is
 * verified before a plan is exposed. HSD `validateresource` is only a
 * parser check; preflight includes encoding.
 */

export const HNS_RESOURCE_WIRE_VERSION_V1 = 0;
/** hsd covenants/rules.js: rules.MAX_RESOURCE_SIZE. */
export const HNS_RESOURCE_MAX_WIRE_BYTES_V1 = 512;

const wireType = {
  DS: 0,
  NS: 1,
  GLUE4: 2,
  GLUE6: 3,
  SYNTH4: 4,
  SYNTH6: 5,
  TXT: 6,
} as const;

const wireTypeByName = new Map<string, number>(
  Object.entries(wireType).map(([name, value]) => [name, value]),
);
const wireNameByType = new Map<number, string>(
  Object.entries(wireType).map(([name, value]) => [value, name]),
);

export type HnsResourceCodecErrorReason =
  | "invalid_record"
  | "invalid_name"
  | "invalid_string"
  | "invalid_address"
  | "invalid_digest"
  | "unknown_record_type"
  | "invalid_wire"
  | "resource_too_large";

export class HnsResourceCodecError extends Error {
  override readonly name = "HnsResourceCodecError";

  constructor(readonly reason: HnsResourceCodecErrorReason) {
    super(`HNS resource codec refused: ${reason}`);
  }
}

const pointerFlag = 0xc000;
const maxLabelBytes = 63;
const maxStringBytes = 255;

function requireObject(record: HnsRootResourceRecordV1, key: string): unknown {
  const value = Reflect.get(record, key);
  if (value === undefined) throw new HnsResourceCodecError("invalid_record");
  return value;
}

function requireString(record: HnsRootResourceRecordV1, key: string): string {
  const value = requireObject(record, key);
  if (typeof value !== "string" || value.length === 0) {
    throw new HnsResourceCodecError("invalid_record");
  }
  return value;
}

/** Printable ASCII without escapes; the wire format has no escape syntax. */
function plainAscii(value: string): boolean {
  return (
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && point <= 0x7e;
    }) && !value.includes("\\")
  );
}

class WireWriter {
  private bytes: number[] = [];

  get offset(): number {
    return this.bytes.length;
  }

  push(...values: number[]): void {
    for (const value of values) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
        throw new HnsResourceCodecError("invalid_wire");
      }
      this.bytes.push(value);
    }
  }

  pushU16BE(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
      throw new HnsResourceCodecError("invalid_wire");
    }
    this.push(value >>> 8, value & 0xff);
  }

  result(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * DNS name encoding with the shared suffix-compression map, matching bns
 * `encoding.writeName`: every label boundary's suffix is recorded at its
 * absolute offset; a later occurrence of the same suffix is replaced by a
 * two-byte pointer. The root name "." is one zero byte.
 */
function writeName(writer: WireWriter, name: string, map: Map<string, number>): void {
  if (!plainAscii(name) || !name.endsWith(".")) {
    throw new HnsResourceCodecError("invalid_name");
  }
  if (name.length > 255) throw new HnsResourceCodecError("invalid_name");
  if (name === ".") {
    writer.push(0x00);
    return;
  }
  const labels = name.slice(0, -1).split(".");
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    if (label === undefined) throw new HnsResourceCodecError("invalid_name");
    const labelBytes = [...label].map((character) => character.charCodeAt(0));
    if (labelBytes.length < 1 || labelBytes.length > maxLabelBytes) {
      throw new HnsResourceCodecError("invalid_name");
    }
    const suffix = `${labels.slice(index).join(".")}.`;
    const pointer = map.get(suffix);
    if (pointer !== undefined) {
      writer.pushU16BE(pointer | pointerFlag);
      return;
    }
    if (writer.offset < 1 << 14) map.set(suffix, writer.offset);
    writer.push(labelBytes.length, ...labelBytes);
  }
  writer.push(0x00);
}

function readName(
  bytes: Uint8Array,
  offset: number,
  visited: ReadonlySet<number>,
): { readonly name: string; readonly next: number } {
  const labels: string[] = [];
  let cursor = offset;
  let jumped = false;
  let next = offset;
  let hops = 0;
  while (true) {
    if (cursor >= bytes.length) throw new HnsResourceCodecError("invalid_wire");
    if (visited.has(cursor) || hops > 64) throw new HnsResourceCodecError("invalid_wire");
    const length = bytes[cursor];
    if (length === undefined) throw new HnsResourceCodecError("invalid_wire");
    if (length === 0x00) {
      if (!jumped) next = cursor + 1;
      return { name: labels.length === 0 ? "." : `${labels.join(".")}.`, next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= bytes.length) throw new HnsResourceCodecError("invalid_wire");
      const pointer = ((length & 0x3f) << 8) | (bytes[cursor + 1] ?? 0);
      if (!jumped) next = cursor + 2;
      jumped = true;
      cursor = pointer;
      hops += 1;
      continue;
    }
    if (length > maxLabelBytes) throw new HnsResourceCodecError("invalid_wire");
    if (cursor + 1 + length > bytes.length) throw new HnsResourceCodecError("invalid_wire");
    let label = "";
    for (let index = 0; index < length; index += 1) {
      const byte = bytes[cursor + 1 + index];
      if (byte === undefined || byte < 0x20 || byte > 0x7e) {
        throw new HnsResourceCodecError("invalid_name");
      }
      label += String.fromCharCode(byte);
    }
    labels.push(label);
    cursor += 1 + length;
    if (!jumped) next = cursor;
  }
}

function writeString(writer: WireWriter, value: string): void {
  if (!plainAscii(value)) throw new HnsResourceCodecError("invalid_string");
  const encoded = [...value].map((character) => character.charCodeAt(0));
  if (encoded.length > maxStringBytes) throw new HnsResourceCodecError("invalid_string");
  writer.push(encoded.length, ...encoded);
}

function readString(
  bytes: Uint8Array,
  offset: number,
): { readonly value: string; readonly next: number } {
  const length = bytes[offset];
  if (length === undefined || offset + 1 + length > bytes.length) {
    throw new HnsResourceCodecError("invalid_wire");
  }
  let value = "";
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + 1 + index];
    if (byte === undefined || byte < 0x20 || byte > 0x7e) {
      throw new HnsResourceCodecError("invalid_string");
    }
    value += String.fromCharCode(byte);
  }
  return { value, next: offset + 1 + length };
}

function ipv4Bytes(address: string): number[] {
  const parts = address.split(".");
  if (parts.length !== 4) throw new HnsResourceCodecError("invalid_address");
  const octets = parts.map((part) => Number(part));
  if (
    !octets.every((octet) => Number.isSafeInteger(octet) && octet >= 0 && octet <= 255) ||
    !parts.every((part) => /^\d{1,3}$/u.test(part))
  ) {
    throw new HnsResourceCodecError("invalid_address");
  }
  return octets;
}

function ipv6Bytes(address: string): number[] {
  if (!address.includes(":")) throw new HnsResourceCodecError("invalid_address");
  if (address.split("::").length > 2) throw new HnsResourceCodecError("invalid_address");
  const doubleColon = address.includes("::");
  const parts = address.split("::");
  const head = parts[0] ?? "";
  const tail = parts.length > 1 ? (parts[1] ?? "") : "";
  const parseGroup = (group: string): number => {
    if (/^[0-9a-fA-F]{1,4}$/u.test(group)) return Number.parseInt(group, 16);
    throw new HnsResourceCodecError("invalid_address");
  };
  const headGroups = head === "" ? [] : head.split(":").map(parseGroup);
  // HSD accepts an embedded dotted-quad tail (e.g. "::ffff:192.0.2.1").
  let embeddedIpv4: number[] | null = null;
  let tailGroups: number[] = [];
  if (tail !== "") {
    const tailParts = tail.split(":");
    const last = tailParts[tailParts.length - 1] ?? "";
    if (last.includes(".")) {
      embeddedIpv4 = ipv4Bytes(last);
      tailParts.pop();
    }
    tailGroups = tailParts.map(parseGroup);
  }
  const groups: number[] = [...headGroups, ...tailGroups];
  if (embeddedIpv4 !== null) {
    groups.push(
      ((embeddedIpv4[0] ?? 0) << 8) | (embeddedIpv4[1] ?? 0),
      ((embeddedIpv4[2] ?? 0) << 8) | (embeddedIpv4[3] ?? 0),
    );
  }
  const missing = 8 - groups.length;
  if (doubleColon) {
    if (missing < 1) throw new HnsResourceCodecError("invalid_address");
    groups.splice(headGroups.length, 0, ...Array.from({ length: missing }, () => 0));
  }
  if (groups.length !== 8) throw new HnsResourceCodecError("invalid_address");
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push(group >>> 8, group & 0xff);
  }
  return bytes;
}

function formatIpv6(bytes: ReadonlyArray<number> | Uint8Array): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  }
  let bestStart = -1;
  let bestLength = 0;
  let index = 0;
  while (index < 8) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestLength < 2) return groups.map((group) => group.toString(16)).join(":");
  const head = groups
    .slice(0, bestStart)
    .map((group) => group.toString(16))
    .join(":");
  const tail = groups
    .slice(bestStart + bestLength)
    .map((group) => group.toString(16))
    .join(":");
  return `${head}::${tail}`;
}

function requireInteger(record: HnsRootResourceRecordV1, key: string, maximum: number): number {
  const value = requireObject(record, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new HnsResourceCodecError("invalid_record");
  }
  return value;
}

function requireDigest(record: HnsRootResourceRecordV1): number[] {
  const digest = requireString(record, "digest");
  if (
    !/^[0-9a-fA-F]+$/u.test(digest) ||
    digest.length % 2 !== 0 ||
    digest.length / 2 > maxStringBytes
  ) {
    throw new HnsResourceCodecError("invalid_digest");
  }
  const bytes: number[] = [];
  for (let index = 0; index < digest.length; index += 2) {
    bytes.push(Number.parseInt(digest.slice(index, index + 2), 16));
  }
  return bytes;
}

/**
 * Encodes complete resource records into the HSD wire format. The caller
 * enforces `HNS_RESOURCE_MAX_WIRE_BYTES_V1` on the returned length; the
 * encoder itself does not bound its output, matching hsd, where the
 * consensus limit is enforced by the wallet before broadcast.
 */
export function encodeHnsResourceV1(records: readonly HnsRootResourceRecordV1[]): Uint8Array {
  if (records.length > 255) throw new HnsResourceCodecError("invalid_record");
  const writer = new WireWriter();
  writer.push(HNS_RESOURCE_WIRE_VERSION_V1);
  const map = new Map<string, number>();
  for (const record of records) {
    const type = wireTypeByName.get(record.type);
    if (type === undefined) throw new HnsResourceCodecError("unknown_record_type");
    writer.push(type);
    switch (record.type) {
      case "DS": {
        const digest = requireDigest(record);
        writer.pushU16BE(requireInteger(record, "keyTag", 0xffff));
        writer.push(requireInteger(record, "algorithm", 0xff));
        writer.push(requireInteger(record, "digestType", 0xff));
        writer.push(digest.length, ...digest);
        break;
      }
      case "NS": {
        writeName(writer, requireString(record, "ns"), map);
        break;
      }
      case "GLUE4":
      case "GLUE6": {
        writeName(writer, requireString(record, "ns"), map);
        const address = requireString(record, "address");
        const bytes = record.type === "GLUE4" ? ipv4Bytes(address) : ipv6Bytes(address);
        writer.push(...bytes);
        break;
      }
      case "SYNTH4":
      case "SYNTH6": {
        const address = requireString(record, "address");
        const bytes = record.type === "SYNTH4" ? ipv4Bytes(address) : ipv6Bytes(address);
        writer.push(...bytes);
        break;
      }
      case "TXT": {
        const txt = requireObject(record, "txt");
        if (!Array.isArray(txt) || txt.length < 1 || txt.length > 255) {
          throw new HnsResourceCodecError("invalid_record");
        }
        if (!txt.every((chunk) => typeof chunk === "string")) {
          throw new HnsResourceCodecError("invalid_record");
        }
        writer.push(txt.length);
        for (const chunk of txt) writeString(writer, chunk);
        break;
      }
      default:
        throw new HnsResourceCodecError("unknown_record_type");
    }
  }
  return writer.result();
}

/** Decodes HSD wire bytes back into complete resource records, strictly. */
export function decodeHnsResourceV1(bytes: Uint8Array): HnsRootResourceRecordV1[] {
  if (bytes.length < 1 || bytes.length > HNS_RESOURCE_MAX_WIRE_BYTES_V1) {
    throw new HnsResourceCodecError("invalid_wire");
  }
  if (bytes[0] !== HNS_RESOURCE_WIRE_VERSION_V1) throw new HnsResourceCodecError("invalid_wire");
  const records: HnsRootResourceRecordV1[] = [];
  let offset = 1;
  while (offset < bytes.length) {
    const typeByte = bytes[offset];
    if (typeByte === undefined) throw new HnsResourceCodecError("invalid_wire");
    const typeName = wireNameByType.get(typeByte);
    if (typeName === undefined) throw new HnsResourceCodecError("unknown_record_type");
    offset += 1;
    switch (typeName) {
      case "DS": {
        if (offset + 4 > bytes.length) throw new HnsResourceCodecError("invalid_wire");
        const keyTag = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
        const algorithm = bytes[offset + 2] ?? 0;
        const digestType = bytes[offset + 3] ?? 0;
        const digestLength = bytes[offset + 4];
        if (digestLength === undefined || offset + 5 + digestLength > bytes.length) {
          throw new HnsResourceCodecError("invalid_wire");
        }
        let digest = "";
        for (let index = 0; index < digestLength; index += 1) {
          digest += (bytes[offset + 5 + index] ?? 0).toString(16).padStart(2, "0");
        }
        records.push({ type: "DS", keyTag, algorithm, digestType, digest });
        offset += 5 + digestLength;
        break;
      }
      case "NS": {
        const read = readName(bytes, offset, new Set());
        records.push({ type: "NS", ns: read.name });
        offset = read.next;
        break;
      }
      case "GLUE4":
      case "GLUE6": {
        const size = typeName === "GLUE4" ? 4 : 16;
        const read = readName(bytes, offset, new Set());
        if (read.next + size > bytes.length) throw new HnsResourceCodecError("invalid_wire");
        const addressBytes = bytes.slice(read.next, read.next + size);
        const address =
          typeName === "GLUE4" ? [...addressBytes].join(".") : formatIpv6(addressBytes);
        records.push({ type: typeName, ns: read.name, address });
        offset = read.next + size;
        break;
      }
      case "SYNTH4":
      case "SYNTH6": {
        const size = typeName === "SYNTH4" ? 4 : 16;
        if (offset + size > bytes.length) throw new HnsResourceCodecError("invalid_wire");
        const addressBytes = bytes.slice(offset, offset + size);
        const address =
          typeName === "SYNTH4" ? [...addressBytes].join(".") : formatIpv6(addressBytes);
        records.push({ type: typeName, address });
        offset += size;
        break;
      }
      case "TXT": {
        const count = bytes[offset];
        if (count === undefined) throw new HnsResourceCodecError("invalid_wire");
        offset += 1;
        const txt: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const read = readString(bytes, offset);
          txt.push(read.value);
          offset = read.next;
        }
        records.push({ type: "TXT", txt });
        break;
      }
      default:
        throw new HnsResourceCodecError("unknown_record_type");
    }
  }
  return records;
}

/**
 * Comparison normalization for plan/transaction resource comparison:
 * record order and multiplicity are preserved as a multiset (sorted keys,
 * duplicates counted), names are lowercased with their trailing dot
 * stripped, DS digests lowercased, and addresses canonicalized through the
 * wire form — so a harmless canonicalization is distinct from a changed
 * resource.
 */
export function normalizedHnsResourceMultisetKeyV1(
  records: readonly HnsRootResourceRecordV1[],
): string {
  const keys = records.map(normalizedHnsResourceRecordKeyV1);
  keys.sort();
  return keys.join("\n");
}

function normalizedHnsResourceRecordKeyV1(record: HnsRootResourceRecordV1): string {
  switch (record.type) {
    case "NS":
      return canonicalJsonOf({
        type: "NS",
        ns: canonicalName(String(record.ns)),
      });
    case "GLUE4":
    case "GLUE6": {
      const size = record.type === "GLUE4" ? 4 : 16;
      return canonicalJsonOf({
        type: record.type,
        ns: canonicalName(String(record.ns)),
        address: canonicalAddress(String(record.address), size),
      });
    }
    case "SYNTH4":
    case "SYNTH6": {
      const size = record.type === "SYNTH4" ? 4 : 16;
      return canonicalJsonOf({
        type: record.type,
        address: canonicalAddress(String(record.address), size),
      });
    }
    case "DS":
      return canonicalJsonOf({
        type: "DS",
        keyTag: Number(record.keyTag),
        algorithm: Number(record.algorithm),
        digestType: Number(record.digestType),
        digest: String(record.digest).toLowerCase(),
      });
    case "TXT":
      return canonicalJsonOf({ type: "TXT", txt: record.txt });
    default:
      return canonicalJsonOf(record);
  }
}

/** Ordered, normalization-aware per-record keys for exact round trips. */
function roundTripKeyV1(records: readonly HnsRootResourceRecordV1[]): string {
  return records.map(normalizedHnsResourceRecordKeyV1).join("\n");
}

function canonicalName(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1).toLowerCase() : name.toLowerCase();
}

function canonicalAddress(address: string, size: 4 | 16): string {
  const bytes = size === 4 ? ipv4Bytes(address) : ipv6Bytes(address);
  return size === 4 ? bytes.join(".") : formatIpv6(bytes);
}

function canonicalJsonOf(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJsonOf).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonOf(record[key])}`)
    .join(",")}}`;
}

/**
 * The preflight gate for an exposed plan: real encoding, the 512-byte
 * consensus limit on the actual output, and the exact round trip. Returns
 * the encoded bytes and their SHA-256 digest so the plan can carry the
 * encoded-resource hash distinct from the plan-document hash.
 */
export async function preflightEncodeHnsResourceV1(
  records: readonly HnsRootResourceRecordV1[],
): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const bytes = encodeHnsResourceV1(records);
  if (bytes.byteLength > HNS_RESOURCE_MAX_WIRE_BYTES_V1) {
    throw new HnsResourceCodecError("resource_too_large");
  }
  const decoded = decodeHnsResourceV1(bytes);
  if (roundTripKeyV1(decoded) !== roundTripKeyV1(records)) {
    throw new HnsResourceCodecError("invalid_wire");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer as ArrayBuffer,
  );
  return {
    bytes,
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
