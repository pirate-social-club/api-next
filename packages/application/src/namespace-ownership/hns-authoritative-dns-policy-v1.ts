import {
  classifyHnsAuthoritativeDnsResponseV1,
  decodeHnsAuthoritativeDnsQueryV1,
  decodeHnsAuthoritativeDnsRdataNameV1,
  decodeHnsAuthoritativeDnsResponseV1,
  HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID,
  type HnsAuthoritativeDnsDecodedRecordV1,
  type HnsAuthoritativeDnsDecodedResponseV1,
  type HnsAuthoritativeDnsValidationResultV1,
  type HnsAuthoritativeDnsValidationV1,
  type HnsAuthoritativeDnsValidatorInputV1,
  type HnsAuthoritativeDnsValidatorPortV1,
} from "./hns-authoritative-dns.ts";
import { type HnsChainAuthorityRecord, hnsChainAuthorityRecords } from "./hns-control-observer.ts";

type Sha256HexValue = HnsAuthoritativeDnsValidationResultV1["validated_chain_authority_digest"];

const ACCEPTED_ALGORITHMS = new Set([8, 10, 13, 14, 15]);
const DEPRECATED_SHA1_ALGORITHMS = new Set([5, 7]);
const ACCEPTED_DS_DIGESTS = new Set([2, 4]);
const MAXIMUM_RESOURCE_RECORDS_PER_RESPONSE = 256;
const MAXIMUM_DS_RECORDS = 16;
const MAXIMUM_DNSKEY_RECORDS = 16;
const MAXIMUM_RRSIG_RECORDS_PER_RRSET = 8;
const MAXIMUM_NSEC_RECORDS = 8;
const MAXIMUM_CANONICAL_RRSET_BYTES = 65_535;
const MAXIMUM_DS_DIGEST_COMPARISONS = 16;
const MAXIMUM_SIGNATURE_VERIFICATIONS = 32;
const MINIMUM_RSA_MODULUS_BITS = 2_048;
const MAXIMUM_RSA_MODULUS_BITS = 4_096;

export function hnsAuthoritativeDnsPolicyV1RequiresChildQuery(
  records: ReadonlyArray<HnsChainAuthorityRecord>,
): boolean {
  return records.some(
    (record) =>
      record[0] === "DS" &&
      ACCEPTED_ALGORITHMS.has(record[2]) &&
      ACCEPTED_DS_DIGESTS.has(record[3]),
  );
}

type Dnskey = Readonly<{
  readonly record: HnsAuthoritativeDnsDecodedRecordV1;
  readonly flags: number;
  readonly algorithm: number;
  readonly key_tag: number;
  readonly public_key: Uint8Array;
  readonly rsa_modulus_bytes: number | null;
  readonly rsa_modulus_bits: number | null;
}>;

type Ds = Readonly<{
  readonly key_tag: number;
  readonly algorithm: number;
  readonly digest_type: number;
  readonly digest: Uint8Array;
}>;

type Rrsig = Readonly<{
  readonly record: HnsAuthoritativeDnsDecodedRecordV1;
  readonly type_covered: number;
  readonly algorithm: number;
  readonly labels: number;
  readonly original_ttl: number;
  readonly expiration: number;
  readonly inception: number;
  readonly key_tag: number;
  readonly signer_name: string;
  readonly signed_header: Uint8Array;
  readonly signature: Uint8Array;
}>;

type RequiredRrset = Readonly<{
  readonly owner: string;
  readonly type: number;
  readonly records: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>;
  readonly signatures: ReadonlyArray<Rrsig>;
  readonly response: HnsAuthoritativeDnsDecodedResponseV1;
}>;

type Nsec = Readonly<{
  readonly record: HnsAuthoritativeDnsDecodedRecordV1;
  readonly next_name: string;
  readonly next_name_canonical_wire: Uint8Array;
  readonly types: ReadonlySet<number>;
}>;

type VerificationOutcome = "valid" | "bogus" | "insecure" | "indeterminate";

function abortIfSet(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("HNS DNSSEC validation aborted");
}

function uint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new RangeError("uint16");
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new RangeError("uint32");
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function writeUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) throw new TypeError("hex");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function canonicalNameWire(name: string): Uint8Array {
  const labels = name === "" ? [] : name.split(".");
  const encoded = labels.map((label) => new TextEncoder().encode(label.toLowerCase()));
  const result = new Uint8Array(encoded.reduce((total, label) => total + label.byteLength + 1, 1));
  let offset = 0;
  for (const label of encoded) {
    if (label.byteLength === 0 || label.byteLength > 63) throw new TypeError("DNS name");
    result[offset] = label.byteLength;
    result.set(label, offset + 1);
    offset += label.byteLength + 1;
  }
  return result;
}

function dnskeyTag(rdata: Uint8Array): number {
  let accumulator = 0;
  for (let index = 0; index < rdata.byteLength; index += 1) {
    accumulator += index & 1 ? (rdata[index] ?? 0) : (rdata[index] ?? 0) << 8;
  }
  accumulator += (accumulator >>> 16) & 0xffff;
  return accumulator & 0xffff;
}

function rsaParts(publicKey: Uint8Array): Readonly<{
  readonly exponent: Uint8Array;
  readonly modulus: Uint8Array;
  readonly modulus_bits: number;
}> | null {
  if (publicKey.byteLength < 3) return null;
  let offset = 1;
  let exponentLength = publicKey[0] ?? 0;
  if (exponentLength === 0) {
    if (publicKey.byteLength < 4) return null;
    exponentLength = uint16(publicKey, 1);
    offset = 3;
    if (exponentLength <= 255) return null;
  }
  if (
    exponentLength === 0 ||
    offset + exponentLength >= publicKey.byteLength ||
    publicKey[offset] === 0 ||
    publicKey[offset + exponentLength] === 0
  ) {
    return null;
  }
  const exponent = new Uint8Array(publicKey.subarray(offset, offset + exponentLength));
  const modulus = new Uint8Array(publicKey.subarray(offset + exponentLength));
  const exponentBits = (exponent.byteLength - 1) * 8 + (32 - Math.clz32(exponent[0] ?? 0));
  if (exponentBits > 4_096) return null;
  const first = modulus[0] ?? 0;
  const modulusBits = (modulus.byteLength - 1) * 8 + (32 - Math.clz32(first));
  return { exponent, modulus, modulus_bits: modulusBits };
}

function parseDnskeys(
  records: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>,
): ReadonlyArray<Dnskey> | null {
  const result: Dnskey[] = [];
  for (const record of records) {
    if (record.rdata.byteLength < 4) return null;
    const flags = uint16(record.rdata, 0);
    const protocol = record.rdata[2] ?? 0;
    const algorithm = record.rdata[3] ?? 0;
    const publicKey = new Uint8Array(record.rdata.subarray(4));
    if (protocol !== 3) return null;
    let rsaModulusBytes: number | null = null;
    let rsaModulusBits: number | null = null;
    if (algorithm === 8 || algorithm === 10) {
      const parts = rsaParts(publicKey);
      if (parts === null) return null;
      rsaModulusBytes = parts.modulus.byteLength;
      rsaModulusBits = parts.modulus_bits;
    } else if (
      (algorithm === 13 && publicKey.byteLength !== 64) ||
      (algorithm === 14 && publicKey.byteLength !== 96) ||
      (algorithm === 15 && publicKey.byteLength !== 32)
    ) {
      return null;
    }
    result.push({
      record,
      flags,
      algorithm,
      key_tag: dnskeyTag(record.rdata),
      public_key: publicKey,
      rsa_modulus_bytes: rsaModulusBytes,
      rsa_modulus_bits: rsaModulusBits,
    });
  }
  return result.sort((left, right) => compareBytes(left.record.rdata, right.record.rdata));
}

function parseDs(records: ReadonlyArray<HnsChainAuthorityRecord>): ReadonlyArray<Ds> | null {
  const result: Ds[] = [];
  for (const record of records) {
    if (record[0] !== "DS") continue;
    let digest: Uint8Array;
    try {
      digest = fromHex(record[4]);
    } catch {
      return null;
    }
    if (
      (record[3] === 2 && digest.byteLength !== 32) ||
      (record[3] === 4 && digest.byteLength !== 48)
    ) {
      if (ACCEPTED_DS_DIGESTS.has(record[3])) return null;
    }
    result.push({ key_tag: record[1], algorithm: record[2], digest_type: record[3], digest });
  }
  return result;
}

function recordsInResponse(response: HnsAuthoritativeDnsDecodedResponseV1): number {
  return response.answers.length + response.authorities.length + response.additionals.length;
}

function rrsigBudgetStatus(
  responses: ReadonlyArray<HnsAuthoritativeDnsDecodedResponseV1>,
): "ok" | "malformed" | "capacity" {
  const counts = new Map<string, number>();
  for (const response of responses) {
    for (const record of [...response.answers, ...response.authorities, ...response.additionals]) {
      if (record.type !== 46) continue;
      if (record.rdata.byteLength < 2) return "malformed";
      const key = `${record.section}\u0000${record.owner}\u0000${record.record_class}\u0000${uint16(record.rdata, 0)}`;
      const count = (counts.get(key) ?? 0) + 1;
      if (count > MAXIMUM_RRSIG_RECORDS_PER_RRSET) return "capacity";
      counts.set(key, count);
    }
  }
  return "ok";
}

function recordsFor(
  records: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>,
  owner: string,
  type: number,
): ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1> {
  return records.filter(
    (record) => record.owner === owner && record.type === type && record.record_class === 1,
  );
}

function parseRrsig(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  record: HnsAuthoritativeDnsDecodedRecordV1,
): Rrsig | null {
  if (record.type !== 46 || record.record_class !== 1 || record.rdata.byteLength < 19) return null;
  const rdataEnd = record.rdata_offset + record.rdata.byteLength;
  let signer: ReturnType<typeof decodeHnsAuthoritativeDnsRdataNameV1>;
  try {
    signer = decodeHnsAuthoritativeDnsRdataNameV1({
      message_bytes: response.message_bytes,
      initial_offset: record.rdata_offset + 18,
      encoded_end_offset: rdataEnd,
      known_name_offsets: response.known_name_offsets,
    });
  } catch {
    return null;
  }
  if (signer.next_offset >= rdataEnd) return null;
  const signature = new Uint8Array(response.message_bytes.subarray(signer.next_offset, rdataEnd));
  return {
    record,
    type_covered: uint16(record.rdata, 0),
    algorithm: record.rdata[2] ?? 0,
    labels: record.rdata[3] ?? 0,
    original_ttl: uint32(record.rdata, 4),
    expiration: uint32(record.rdata, 8),
    inception: uint32(record.rdata, 12),
    key_tag: uint16(record.rdata, 16),
    signer_name: signer.name,
    signed_header: concatBytes([record.rdata.subarray(0, 18), signer.canonical_wire]),
    signature,
  };
}

function signaturesFor(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  section: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>,
  owner: string,
  type: number,
): ReadonlyArray<Rrsig> | null {
  const candidates = section.filter(
    (record) =>
      record.owner === owner &&
      record.type === 46 &&
      record.record_class === 1 &&
      record.rdata.byteLength >= 2 &&
      uint16(record.rdata, 0) === type,
  );
  if (candidates.length > MAXIMUM_RRSIG_RECORDS_PER_RRSET) return null;
  const signatures = candidates.map((record) => parseRrsig(response, record));
  if (signatures.some((signature) => signature === null)) return null;
  return [...(signatures as ReadonlyArray<Rrsig>)].sort((left, right) =>
    compareBytes(
      concatBytes([left.signed_header, left.signature]),
      concatBytes([right.signed_header, right.signature]),
    ),
  );
}

function soaCanonicalRdata(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  record: HnsAuthoritativeDnsDecodedRecordV1,
): Uint8Array | null {
  const end = record.rdata_offset + record.rdata.byteLength;
  try {
    const mname = decodeHnsAuthoritativeDnsRdataNameV1({
      message_bytes: response.message_bytes,
      initial_offset: record.rdata_offset,
      encoded_end_offset: end,
      known_name_offsets: response.known_name_offsets,
    });
    const rname = decodeHnsAuthoritativeDnsRdataNameV1({
      message_bytes: response.message_bytes,
      initial_offset: mname.next_offset,
      encoded_end_offset: end,
      known_name_offsets: response.known_name_offsets,
    });
    if (rname.next_offset + 20 !== end) return null;
    return concatBytes([
      mname.canonical_wire,
      rname.canonical_wire,
      response.message_bytes.subarray(rname.next_offset, end),
    ]);
  } catch {
    return null;
  }
}

function parseNsec(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  record: HnsAuthoritativeDnsDecodedRecordV1,
): Nsec | null {
  const end = record.rdata_offset + record.rdata.byteLength;
  try {
    const next = decodeHnsAuthoritativeDnsRdataNameV1({
      message_bytes: response.message_bytes,
      initial_offset: record.rdata_offset,
      encoded_end_offset: end,
      known_name_offsets: response.known_name_offsets,
    });
    const types = new Set<number>();
    let offset = next.next_offset;
    let priorWindow = -1;
    while (offset < end) {
      if (offset + 2 > end) return null;
      const window = response.message_bytes[offset] ?? 0;
      const length = response.message_bytes[offset + 1] ?? 0;
      offset += 2;
      if (window <= priorWindow || length < 1 || length > 32 || offset + length > end) return null;
      if ((response.message_bytes[offset + length - 1] ?? 0) === 0) return null;
      for (let byteIndex = 0; byteIndex < length; byteIndex += 1) {
        const bitmap = response.message_bytes[offset + byteIndex] ?? 0;
        for (let bit = 0; bit < 8; bit += 1) {
          if ((bitmap & (0x80 >>> bit)) !== 0) types.add(window * 256 + byteIndex * 8 + bit);
        }
      }
      offset += length;
      priorWindow = window;
    }
    return {
      record,
      next_name: next.name,
      next_name_canonical_wire: next.canonical_wire,
      types,
    };
  } catch {
    return null;
  }
}

function nsecCanonicalRdata(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  record: HnsAuthoritativeDnsDecodedRecordV1,
): Uint8Array | null {
  const end = record.rdata_offset + record.rdata.byteLength;
  try {
    const next = decodeHnsAuthoritativeDnsRdataNameV1({
      message_bytes: response.message_bytes,
      initial_offset: record.rdata_offset,
      encoded_end_offset: end,
      known_name_offsets: response.known_name_offsets,
    });
    return concatBytes([
      next.original_wire,
      response.message_bytes.subarray(next.next_offset, end),
    ]);
  } catch {
    return null;
  }
}

function canonicalRdata(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  record: HnsAuthoritativeDnsDecodedRecordV1,
): Uint8Array | null {
  if (record.type === 6) return soaCanonicalRdata(response, record);
  if (record.type === 47) return nsecCanonicalRdata(response, record);
  if (record.type === 16 || record.type === 48) return new Uint8Array(record.rdata);
  return null;
}

type CanonicalRrsetResult =
  | Readonly<{ readonly kind: "ok"; readonly bytes: Uint8Array }>
  | Readonly<{ readonly kind: "malformed" | "capacity" }>;

function canonicalRrsetBytes(rrset: RequiredRrset, originalTtl: number): CanonicalRrsetResult {
  const firstRecord = rrset.records[0];
  if (firstRecord === undefined) return { kind: "malformed" };
  const owner = firstRecord.owner_canonical_wire;
  const canonicalRdatas: Uint8Array[] = [];
  for (const record of rrset.records) {
    if (!equalBytes(record.owner_canonical_wire, owner)) return { kind: "malformed" };
    const rdata = canonicalRdata(rrset.response, record);
    if (rdata === null) return { kind: "malformed" };
    if (!canonicalRdatas.some((candidate) => equalBytes(candidate, rdata)))
      canonicalRdatas.push(rdata);
  }
  canonicalRdatas.sort(compareBytes);
  const records = canonicalRdatas.map((rdata) =>
    concatBytes([
      owner,
      writeUint16(rrset.type),
      writeUint16(1),
      writeUint32(originalTtl),
      writeUint16(rdata.byteLength),
      rdata,
    ]),
  );
  const result = concatBytes(records);
  return result.byteLength <= MAXIMUM_CANONICAL_RRSET_BYTES
    ? { kind: "ok", bytes: result }
    : { kind: "capacity" };
}

function labelCount(name: string): number {
  return name === "" ? 0 : name.split(".").length;
}

function signatureTime(
  signature: Rrsig,
  validationSeconds: number,
): "valid" | "invalid" | "indeterminate" {
  if (
    !Number.isSafeInteger(validationSeconds) ||
    validationSeconds < 0 ||
    validationSeconds > 0xffff_ffff
  ) {
    return "indeterminate";
  }
  const interval = (signature.expiration - signature.inception) >>> 0;
  if (interval >= 0x80000000) return "indeterminate";
  const now = validationSeconds;
  const sinceInception = (now - signature.inception) >>> 0;
  const untilExpiration = (signature.expiration - now) >>> 0;
  if (sinceInception === 0x80000000 || untilExpiration === 0x80000000) {
    return "indeterminate";
  }
  if (sinceInception >= 0x80000000 || untilExpiration >= 0x80000000) return "invalid";
  return "valid";
}

function requiredSignatureShape(signature: Rrsig, rrset: RequiredRrset, apex: string): boolean {
  const expectedSignatureLength =
    signature.algorithm === 13
      ? 64
      : signature.algorithm === 14
        ? 96
        : signature.algorithm === 15
          ? 64
          : null;
  return (
    signature.record.owner === rrset.owner &&
    signature.record.record_class === 1 &&
    signature.type_covered === rrset.type &&
    signature.signer_name === apex &&
    signature.labels === labelCount(rrset.owner) &&
    (expectedSignatureLength === null || signature.signature.byteLength === expectedSignatureLength)
  );
}

async function importVerificationKey(key: Dnskey): Promise<CryptoKey | null> {
  try {
    if (key.algorithm === 8 || key.algorithm === 10) {
      const parts = rsaParts(key.public_key);
      if (parts === null) return null;
      return await crypto.subtle.importKey(
        "jwk",
        {
          kty: "RSA",
          n: toBase64Url(parts.modulus),
          e: toBase64Url(parts.exponent),
          ext: true,
          key_ops: ["verify"],
        },
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: key.algorithm === 8 ? "SHA-256" : "SHA-512",
        },
        false,
        ["verify"],
      );
    }
    if (key.algorithm === 13 || key.algorithm === 14) {
      const coordinateLength = key.algorithm === 13 ? 32 : 48;
      const curve = key.algorithm === 13 ? "P-256" : "P-384";
      return await crypto.subtle.importKey(
        "jwk",
        {
          kty: "EC",
          crv: curve,
          x: toBase64Url(key.public_key.subarray(0, coordinateLength)),
          y: toBase64Url(key.public_key.subarray(coordinateLength)),
          ext: true,
          key_ops: ["verify"],
        },
        { name: "ECDSA", namedCurve: curve },
        false,
        ["verify"],
      );
    }
    if (key.algorithm === 15) {
      return await crypto.subtle.importKey("raw", key.public_key, "Ed25519", false, ["verify"]);
    }
    return null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") throw error;
    return null;
  }
}

async function verifyCryptographicSignature(
  signature: Rrsig,
  key: Dnskey,
  signedData: Uint8Array,
  importedKeys: Map<string, Promise<CryptoKey | null>>,
): Promise<boolean> {
  if (
    signature.algorithm !== key.algorithm ||
    signature.key_tag !== key.key_tag ||
    (key.rsa_modulus_bytes !== null && signature.signature.byteLength !== key.rsa_modulus_bytes)
  ) {
    return false;
  }
  const cacheKey = toHex(key.record.rdata);
  let imported = importedKeys.get(cacheKey);
  if (imported === undefined) {
    imported = importVerificationKey(key);
    importedKeys.set(cacheKey, imported);
  }
  const cryptoKey = await imported;
  if (cryptoKey === null) return false;
  try {
    if (signature.algorithm === 13) {
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        signature.signature,
        signedData,
      );
    }
    if (signature.algorithm === 14) {
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-384" },
        cryptoKey,
        signature.signature,
        signedData,
      );
    }
    return await crypto.subtle.verify(
      signature.algorithm === 15 ? "Ed25519" : "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature.signature,
      signedData,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") throw error;
    return false;
  }
}

async function verifyRrset(
  input: Readonly<{
    readonly rrset: RequiredRrset;
    readonly keys: ReadonlyArray<Dnskey>;
    readonly apex: string;
    readonly validation_seconds: number;
    readonly imported_keys: Map<string, Promise<CryptoKey | null>>;
    readonly signal: AbortSignal;
  }>,
): Promise<VerificationOutcome> {
  let sawAccepted = false;
  let sawDeprecatedOnly = input.rrset.signatures.length > 0;
  let sawIndeterminate = false;
  for (const signature of input.rrset.signatures) {
    if (!DEPRECATED_SHA1_ALGORITHMS.has(signature.algorithm)) sawDeprecatedOnly = false;
    if (!ACCEPTED_ALGORITHMS.has(signature.algorithm)) continue;
    sawAccepted = true;
    if (
      input.rrset.type === 16 &&
      input.rrset.owner === `_pirate.${input.apex}` &&
      signature.record.owner === input.rrset.owner &&
      signature.type_covered === input.rrset.type &&
      signature.signer_name === input.apex &&
      signature.labels < labelCount(input.rrset.owner)
    ) {
      sawIndeterminate = true;
      continue;
    }
    if (!requiredSignatureShape(signature, input.rrset, input.apex)) continue;
    const time = signatureTime(signature, input.validation_seconds);
    if (time === "indeterminate") {
      sawIndeterminate = true;
      continue;
    }
    if (time === "invalid") continue;
    const rrset = canonicalRrsetBytes(input.rrset, signature.original_ttl);
    if (rrset.kind !== "ok") continue;
    const signedData = concatBytes([signature.signed_header, rrset.bytes]);
    for (const key of input.keys) {
      if (key.algorithm !== signature.algorithm || key.key_tag !== signature.key_tag) continue;
      abortIfSet(input.signal);
      if (await verifyCryptographicSignature(signature, key, signedData, input.imported_keys)) {
        abortIfSet(input.signal);
        return "valid";
      }
    }
  }
  if (sawDeprecatedOnly) return "insecure";
  if (sawIndeterminate) return "indeterminate";
  return sawAccepted ? "bogus" : "bogus";
}

async function digestMatches(ds: Ds, key: Dnskey, apex: string): Promise<boolean> {
  const algorithm = ds.digest_type === 2 ? "SHA-256" : ds.digest_type === 4 ? "SHA-384" : null;
  if (algorithm === null) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest(algorithm, concatBytes([canonicalNameWire(apex), key.record.rdata])),
  );
  return equalBytes(digest, ds.digest);
}

function rrsetKey(owner: string, type: number): string {
  return `${owner}\u0000${type}`;
}

function signatureAttemptCount(
  rrsets: ReadonlyArray<RequiredRrset>,
  keys: ReadonlyArray<Dnskey>,
  apex: string,
): number {
  let count = 0;
  for (const rrset of rrsets) {
    for (const signature of rrset.signatures) {
      if (
        !ACCEPTED_ALGORITHMS.has(signature.algorithm) ||
        !requiredSignatureShape(signature, rrset, apex)
      ) {
        continue;
      }
      count += keys.filter(
        (key) =>
          key.algorithm === signature.algorithm &&
          key.key_tag === signature.key_tag &&
          (key.rsa_modulus_bytes === null ||
            key.rsa_modulus_bytes === signature.signature.byteLength),
      ).length;
    }
  }
  return count;
}

function acceptedSignatureEncodingsAreValid(
  rrsets: ReadonlyArray<RequiredRrset>,
  keys: ReadonlyArray<Dnskey>,
): boolean {
  for (const rrset of rrsets) {
    for (const signature of rrset.signatures) {
      if (!ACCEPTED_ALGORITHMS.has(signature.algorithm)) continue;
      const expectedFixedLength =
        signature.algorithm === 13
          ? 64
          : signature.algorithm === 14
            ? 96
            : signature.algorithm === 15
              ? 64
              : null;
      if (expectedFixedLength !== null && signature.signature.byteLength !== expectedFixedLength) {
        return false;
      }
      if (signature.algorithm === 8 || signature.algorithm === 10) {
        const matchingKeys = keys.filter(
          (key) => key.algorithm === signature.algorithm && key.key_tag === signature.key_tag,
        );
        if (
          matchingKeys.length > 0 &&
          !matchingKeys.some((key) => key.rsa_modulus_bytes === signature.signature.byteLength)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function wireNameLabels(wire: Uint8Array): ReadonlyArray<Uint8Array> {
  const labels: Uint8Array[] = [];
  let offset = 0;
  while (offset < wire.byteLength) {
    const length = wire[offset] ?? 0;
    offset += 1;
    if (length === 0) {
      if (offset !== wire.byteLength) throw new TypeError("canonical DNS name wire");
      return labels;
    }
    if (length > 63 || offset + length > wire.byteLength) {
      throw new TypeError("canonical DNS name wire");
    }
    labels.push(new Uint8Array(wire.subarray(offset, offset + length)));
    offset += length;
  }
  throw new TypeError("canonical DNS name wire");
}

function canonicalDnsNameCompare(left: Uint8Array, right: Uint8Array): number {
  const leftLabels = wireNameLabels(left).slice().reverse();
  const rightLabels = wireNameLabels(right).slice().reverse();
  const length = Math.min(leftLabels.length, rightLabels.length);
  for (let index = 0; index < length; index += 1) {
    const leftLabel = leftLabels[index] ?? new Uint8Array();
    const rightLabel = rightLabels[index] ?? new Uint8Array();
    const comparison = compareBytes(
      concatBytes([new Uint8Array([leftLabel.byteLength]), leftLabel]),
      concatBytes([new Uint8Array([rightLabel.byteLength]), rightLabel]),
    );
    if (comparison !== 0) return comparison;
  }
  return leftLabels.length - rightLabels.length;
}

function nsecCovers(nsec: Nsec, name: string): boolean {
  const target = canonicalNameWire(name);
  if (equalBytes(target, nsec.record.owner_canonical_wire)) return false;
  const ownerToNext = canonicalDnsNameCompare(
    nsec.record.owner_canonical_wire,
    nsec.next_name_canonical_wire,
  );
  const ownerToName = canonicalDnsNameCompare(nsec.record.owner_canonical_wire, target);
  const nameToNext = canonicalDnsNameCompare(target, nsec.next_name_canonical_wire);
  if (ownerToNext < 0) return ownerToName < 0 && nameToNext < 0;
  if (ownerToNext > 0) return ownerToName < 0 || nameToNext < 0;
  return true;
}

function nameIsInDelegatedZone(name: Uint8Array, apex: Uint8Array): boolean {
  const nameLabels = wireNameLabels(name);
  const apexLabels = wireNameLabels(apex);
  if (nameLabels.length < apexLabels.length) return false;
  return apexLabels.every((label, index) =>
    equalBytes(label, nameLabels[nameLabels.length - apexLabels.length + index] as Uint8Array),
  );
}

function requiredRrset(
  response: HnsAuthoritativeDnsDecodedResponseV1,
  section: ReadonlyArray<HnsAuthoritativeDnsDecodedRecordV1>,
  owner: string,
  type: number,
): RequiredRrset | null {
  const records = recordsFor(section, owner, type);
  if (records.length === 0) return null;
  const signatures = signaturesFor(response, section, owner, type);
  if (signatures === null || signatures.length === 0) return null;
  return { owner, type, records, signatures, response };
}

async function sha256Hex(bytes: Uint8Array): Promise<Sha256HexValue> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) as Sha256HexValue;
}

async function validationResult(
  status: HnsAuthoritativeDnsValidationV1,
  input: HnsAuthoritativeDnsValidatorInputV1,
): Promise<HnsAuthoritativeDnsValidationResultV1> {
  abortIfSet(input.signal);
  const dnskeyHash = await sha256Hex(input.dnskey_response_bytes);
  abortIfSet(input.signal);
  const controlHash = await sha256Hex(input.control_response_bytes);
  abortIfSet(input.signal);
  return {
    dnssec_validation: status,
    validated_dnskey_response_sha256: dnskeyHash,
    validated_control_response_sha256: controlHash,
    validated_chain_authority_digest: input.chain_authority_digest,
  };
}

async function validatePolicy(
  input: HnsAuthoritativeDnsValidatorInputV1,
): Promise<HnsAuthoritativeDnsValidationV1> {
  abortIfSet(input.signal);
  const dnskeyClass = classifyHnsAuthoritativeDnsResponseV1({
    request_bytes: input.dnskey_request_bytes,
    response_bytes: input.dnskey_response_bytes,
  });
  const controlClass = classifyHnsAuthoritativeDnsResponseV1({
    request_bytes: input.control_request_bytes,
    response_bytes: input.control_response_bytes,
  });
  if (
    dnskeyClass.kind !== "dnskey" ||
    (controlClass.kind !== "txt_values" &&
      controlClass.kind !== "nodata" &&
      controlClass.kind !== "nxdomain")
  ) {
    return "indeterminate";
  }
  const dnskeyQuery = decodeHnsAuthoritativeDnsQueryV1(input.dnskey_request_bytes);
  const controlQuery = decodeHnsAuthoritativeDnsQueryV1(input.control_request_bytes);
  if (
    dnskeyQuery.query_kind !== "dnskey" ||
    controlQuery.query_kind !== "control_txt" ||
    dnskeyQuery.root_label !== input.root_label ||
    controlQuery.root_label !== input.root_label
  ) {
    return "indeterminate";
  }
  const dnskeyResponse = decodeHnsAuthoritativeDnsResponseV1(input.dnskey_response_bytes);
  const controlResponse = decodeHnsAuthoritativeDnsResponseV1(input.control_response_bytes);
  if (
    recordsInResponse(dnskeyResponse) > MAXIMUM_RESOURCE_RECORDS_PER_RESPONSE ||
    recordsInResponse(controlResponse) > MAXIMUM_RESOURCE_RECORDS_PER_RESPONSE
  ) {
    return "indeterminate";
  }
  if (input.authority_records.filter((record) => record[0] === "DS").length > MAXIMUM_DS_RECORDS) {
    return "indeterminate";
  }
  const rrsigBudget = rrsigBudgetStatus([dnskeyResponse, controlResponse]);
  if (rrsigBudget === "capacity") return "indeterminate";
  if (rrsigBudget === "malformed") return "bogus";
  let authorityRecords: ReadonlyArray<HnsChainAuthorityRecord>;
  try {
    authorityRecords = hnsChainAuthorityRecords(
      "owner_authoritative_dns_txt",
      input.authority_records,
    );
  } catch {
    return "indeterminate";
  }
  const dsRecords = authorityRecords.filter((record) => record[0] === "DS");
  if (dsRecords.length > MAXIMUM_DS_RECORDS) return "indeterminate";
  const parsedDs = parseDs(authorityRecords);
  if (parsedDs === null) return "bogus";
  const supportedDs = parsedDs.filter(
    (ds) => ACCEPTED_ALGORITHMS.has(ds.algorithm) && ACCEPTED_DS_DIGESTS.has(ds.digest_type),
  );
  if (supportedDs.length === 0) return "insecure";

  const apex = input.root_label;
  const dnskeyRecords = recordsFor(dnskeyResponse.answers, apex, 48);
  if (dnskeyRecords.length === 0) return "bogus";
  if (dnskeyRecords.length > MAXIMUM_DNSKEY_RECORDS) return "indeterminate";
  const keys = parseDnskeys(dnskeyRecords);
  if (keys === null) return "bogus";
  const usableKeys = keys.filter(
    (key) =>
      ACCEPTED_ALGORITHMS.has(key.algorithm) &&
      (key.flags & 0x0100) !== 0 &&
      (key.rsa_modulus_bits === null ||
        (key.rsa_modulus_bits >= MINIMUM_RSA_MODULUS_BITS &&
          key.rsa_modulus_bits <= MAXIMUM_RSA_MODULUS_BITS)),
  );
  const digestPairs = supportedDs.flatMap((ds) =>
    usableKeys
      .filter((key) => key.algorithm === ds.algorithm && key.key_tag === ds.key_tag)
      .map((key) => ({ ds, key })),
  );
  if (digestPairs.length > MAXIMUM_DS_DIGEST_COMPARISONS) return "indeterminate";

  const dnskeyRrset = requiredRrset(dnskeyResponse, dnskeyResponse.answers, apex, 48);
  if (dnskeyRrset === null) return "bogus";
  const requiredRrsets: RequiredRrset[] = [dnskeyRrset];

  const controlName = `_pirate.${apex}`;
  let positiveRrset: RequiredRrset | null = null;
  let soaRrset: RequiredRrset | null = null;
  const candidateNsecRrsets = new Map<string, RequiredRrset>();
  if (controlClass.kind === "txt_values") {
    positiveRrset = requiredRrset(controlResponse, controlResponse.answers, controlName, 16);
    if (positiveRrset === null) return "bogus";
    requiredRrsets.push(positiveRrset);
  } else {
    const allNsecRecords = controlResponse.authorities.filter((record) => record.type === 47);
    if (allNsecRecords.length > MAXIMUM_NSEC_RECORDS) return "indeterminate";
    const nsecRecords = allNsecRecords
      .filter((record) => record.record_class === 1)
      .sort(
        (left, right) =>
          canonicalDnsNameCompare(left.owner_canonical_wire, right.owner_canonical_wire) ||
          compareBytes(left.rdata, right.rdata),
      );
    if (
      nsecRecords.length === 0 &&
      controlResponse.authorities.some((record) => record.type === 50)
    ) {
      return "indeterminate";
    }
    soaRrset = requiredRrset(controlResponse, controlResponse.authorities, apex, 6);
    if (soaRrset === null) return "bogus";
    requiredRrsets.push(soaRrset);
    for (const record of nsecRecords) {
      const key = rrsetKey(record.owner, 47);
      if (candidateNsecRrsets.has(key)) continue;
      const rrset = requiredRrset(controlResponse, controlResponse.authorities, record.owner, 47);
      if (rrset !== null) {
        candidateNsecRrsets.set(key, rrset);
        requiredRrsets.push(rrset);
      }
    }
    if (candidateNsecRrsets.size === 0) return "bogus";
  }

  if (signatureAttemptCount(requiredRrsets, usableKeys, apex) > MAXIMUM_SIGNATURE_VERIFICATIONS) {
    return "indeterminate";
  }
  if (!acceptedSignatureEncodingsAreValid(requiredRrsets, usableKeys)) return "bogus";
  for (const rrset of requiredRrsets) {
    for (const signature of rrset.signatures) {
      const canonical = canonicalRrsetBytes(rrset, signature.original_ttl);
      if (canonical.kind === "capacity") return "indeterminate";
      if (canonical.kind === "malformed") return "bogus";
    }
  }

  const dsMatchedKeySet = new Set<Dnskey>();
  for (const pair of digestPairs) {
    abortIfSet(input.signal);
    if (await digestMatches(pair.ds, pair.key, apex)) dsMatchedKeySet.add(pair.key);
  }
  const dsMatchedKeys = usableKeys.filter((key) => dsMatchedKeySet.has(key));
  if (dsMatchedKeys.length === 0) return "bogus";

  const validationMs = Date.parse(input.validation_database_time);
  if (!Number.isFinite(validationMs)) return "indeterminate";
  const validationSeconds = Math.floor(validationMs / 1_000);
  const importedKeys = new Map<string, Promise<CryptoKey | null>>();
  const dnskeyOutcome = await verifyRrset({
    rrset: dnskeyRrset,
    keys: dsMatchedKeys,
    apex,
    validation_seconds: validationSeconds,
    imported_keys: importedKeys,
    signal: input.signal,
  });
  if (dnskeyOutcome !== "valid") return dnskeyOutcome;

  if (positiveRrset !== null) {
    return verifyRrset({
      rrset: positiveRrset,
      keys: usableKeys,
      apex,
      validation_seconds: validationSeconds,
      imported_keys: importedKeys,
      signal: input.signal,
    }).then((outcome) => (outcome === "valid" ? "secure" : outcome));
  }

  if (soaRrset === null) return "bogus";
  const soaOutcome = await verifyRrset({
    rrset: soaRrset,
    keys: usableKeys,
    apex,
    validation_seconds: validationSeconds,
    imported_keys: importedKeys,
    signal: input.signal,
  });
  if (soaOutcome !== "valid") return soaOutcome;

  const authenticatedNsec: Nsec[] = [];
  const nsecOutcomes: Array<
    Readonly<{ readonly records: ReadonlyArray<Nsec>; readonly outcome: VerificationOutcome }>
  > = [];
  for (const rrset of candidateNsecRrsets.values()) {
    const outcome = await verifyRrset({
      rrset,
      keys: usableKeys,
      apex,
      validation_seconds: validationSeconds,
      imported_keys: importedKeys,
      signal: input.signal,
    });
    const parsed: Nsec[] = [];
    for (const record of rrset.records) {
      const nsec = parseNsec(controlResponse, record);
      if (
        nsec !== null &&
        nameIsInDelegatedZone(nsec.record.owner_canonical_wire, canonicalNameWire(apex)) &&
        nameIsInDelegatedZone(nsec.next_name_canonical_wire, canonicalNameWire(apex))
      ) {
        parsed.push(nsec);
        if (outcome === "valid") authenticatedNsec.push(nsec);
      }
    }
    nsecOutcomes.push({ records: parsed, outcome });
  }
  if (controlClass.kind === "nodata") {
    const provesNodata = (nsec: Nsec) =>
      nsec.record.owner === controlName && !nsec.types.has(16) && !nsec.types.has(5);
    if (authenticatedNsec.some(provesNodata)) return "secure";
    const relevant = nsecOutcomes.filter((candidate) => candidate.records.some(provesNodata));
    if (relevant.some((candidate) => candidate.outcome === "indeterminate")) {
      return "indeterminate";
    }
    return relevant.some((candidate) => candidate.outcome === "insecure") ? "insecure" : "bogus";
  }
  const wildcard = `*.${apex}`;
  const nameDenied = authenticatedNsec.some((nsec) => nsecCovers(nsec, controlName));
  const wildcardDenied = authenticatedNsec.some((nsec) => nsecCovers(nsec, wildcard));
  if (nameDenied && wildcardDenied) return "secure";
  const unresolvedStatuses = [
    ...(nameDenied
      ? []
      : nsecOutcomes
          .filter((candidate) => candidate.records.some((nsec) => nsecCovers(nsec, controlName)))
          .map((candidate) => candidate.outcome)),
    ...(wildcardDenied
      ? []
      : nsecOutcomes
          .filter((candidate) => candidate.records.some((nsec) => nsecCovers(nsec, wildcard)))
          .map((candidate) => candidate.outcome)),
  ];
  if (unresolvedStatuses.length === 0 || unresolvedStatuses.includes("bogus")) return "bogus";
  if (unresolvedStatuses.includes("indeterminate")) return "indeterminate";
  return unresolvedStatuses.includes("insecure") ? "insecure" : "bogus";
}

const RUNTIME_CAPABILITY_MESSAGE = new TextEncoder().encode(
  "pirate-hns-dnssec-policy-v1-capability",
);
const RUNTIME_CAPABILITY_VECTORS = [
  {
    algorithm: 8,
    jwk: {
      key_ops: ["verify"],
      ext: true,
      alg: "RS256",
      kty: "RSA",
      n: "lGiti5kRqL2qvaAV0IduDCLdBDerHvi4lDXLPcoC2NTAAiGjWOzsMZ0AXGpKaIdTkqMsGmH5PbVw7uF_nutyo56OpJ9V5MaPhCV4YQ6uF4vPhlthWTPxsoXCEWpEZ8DBLKhBXFXnbg3taVj8Zr0lKjYu2SAHz28Rt6JRuq6LQYxJEz60bbfkRCJI-PR3YAW7Yhk1EqXXiBSzhr2U8jA9dTFiDpCze3DZCu5tltqBYcXdSKzT8aVI9L8bZBhktWeSoWz4l3EJesQsabfKA9O6yPkDbGtg9a1OB-kx79wh8cZ_Gm0IuIJ1gr1FmmQxVF0mTHlGt4bhN2S4tAHggfbhLw",
      e: "AQAB",
    },
    signature:
      "7f1ef7e13f9efeb5703f44b5522603afcb0fe410ed3b6dbf3a8fbeb99de44ab17d518eae8b0e1dab25d36a947d67ca3c6a87f03a53f564fb0e332f754dd037d6dc9b7f8a2e08511d18f13b39a1635eb3e2b16d0af69372a2c5b6d16abfa7349874583d814eb937177c0feb97d0172e73ac38715d64a3203904d70d4b7f920a3b3b79d6f88ee3f762572a6cdb2196c17907bae2552eb40c05579d75b944fe06bd64d713d6f5c57aa8ce46a934ec59b05cca013e6c19c634fd2a72917b6665da38ecddcc19cd14c0acf46712a830ebf394827011de5730f04ed03a7cdb3d3313ffa025a31ed77cb46f4aadd203428d253ef1d50c01804fe95681f2c534c7f6f87d",
  },
  {
    algorithm: 10,
    jwk: {
      key_ops: ["verify"],
      ext: true,
      alg: "RS512",
      kty: "RSA",
      n: "u0jkdc7f8_UgPyuG_idwYN9zk8cTsxunDdlHrINUywSYbReD83UHR1498zlujg3s63oUeN38AnmzaVwZc99PqGXt4Bpi94BCOiavJKam-0iJ2XiwWJn-rrulb5oqAzPzyrXsQrZ5EvYq6fYnhpZOV8OlPLXFHagwb7vhckcj5xVEws8pRos3v7dvMY9TQCkhfhaDQLCVj3HNYxoerJ_mgV34bIotSB0SX5iCauTK5GyQ26lodpzIGqSy3mWqh0ToC8HfzDlI7KFQYgJDKsbYO4fyX0NUVs_Vt1nVymvvXBY59eCqlnT9Y979okbvEALIqm1jeLKefpoQDBJsW-1t3Q",
      e: "AQAB",
    },
    signature:
      "8bafcb93526d89ce36c6950bd53e1407552ceeec4054d4c5533ddd0885f6fa7bd9e222be91ad4d386298c995a1c7165651024511a7add43a593237a3b19cb0cb074a083b248db7a195155374b1f768e5cfe5ae118ca6beab727c9a9156f8674c6e760257cd5818ad2a779e23c61ab1015f0c3c81add36f32299c323d6409eacff2c9bcc47daaed2d2e7bc50331cd80a5a46912dfabcd84eb0add5c79d796b6870893c46e16622be052817d53a696845fd0d925e2713e2d1636d2be7aa213d4a219d8448269436f249b0b51d0fa6a3b8a29a1c2d5415ac05dd7b80f79cb479bdce675a9a5c38be11ef2f3e2526936a8a11d3d2b04596fc785016abaa9d7887a2c",
  },
  {
    algorithm: 13,
    jwk: {
      key_ops: ["verify"],
      ext: true,
      kty: "EC",
      x: "rVaKeBRDzY9-8lk_znThgrBPwGM8qujuexWdx3Axeb8",
      y: "K53Zp6X30RbFzLF-KlRPQwcqHHUk9l16dXTwRXlG2mk",
      crv: "P-256",
    },
    signature:
      "b3cb2cf30a10cde40ee91cc526ad92ece7b70ba5a9f69b0341d00b2306e954bb17dd1e59134545336016bfa4ba567b7c56b723592631eeb41fd05f6ca5727bde",
  },
  {
    algorithm: 14,
    jwk: {
      key_ops: ["verify"],
      ext: true,
      kty: "EC",
      x: "d6GVmaHjL4wKJot5aIbi0HiQGLb23zsFT2MnOCYiUjztaVOjwdRJqrMDnaabEgr8",
      y: "BMuK0uINibBBFRcfSPRVXdZWDNquWr5EP_vb-9_xCUZUIjKyDeX5yjRTU9y0xHQs",
      crv: "P-384",
    },
    signature:
      "63896758f693d932e4bfe34802b3e3676c4408741e506ae51a7944c88d72f98fcb4e4bc15d129feebf6c6b54e6bb0d887645678710444aab22dd39a85888d7b6011ae2339721b07c1920a648eab6b15b4b4010a3c39e19688cb97312ac87d169",
  },
  {
    algorithm: 15,
    jwk: {
      key_ops: ["verify"],
      ext: true,
      crv: "Ed25519",
      x: "zy8UZPp5DobHWbx5Dc5Vw0rjcjnwHPg7LrJKIS8VqGY",
      kty: "OKP",
    },
    signature:
      "4c664a78a910ebb5dbaeca3e3bc5d43bac201d3842a54ceac4c3fdd3d3aa19019cb77329bb2b88d3e34e68362aee076201bd7c2ab7c30edfd0412439c4c2e10d",
  },
] as const;

let runtimeCapabilityCheck: Promise<void> | undefined;

async function verifyRuntimeCapabilityVectors(): Promise<void> {
  for (const vector of RUNTIME_CAPABILITY_VECTORS) {
    let key: CryptoKey;
    let valid: boolean;
    if (vector.algorithm === 8 || vector.algorithm === 10) {
      key = await crypto.subtle.importKey(
        "jwk",
        vector.jwk as never,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: vector.algorithm === 8 ? "SHA-256" : "SHA-512",
        },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        fromHex(vector.signature),
        RUNTIME_CAPABILITY_MESSAGE,
      );
    } else if (vector.algorithm === 13 || vector.algorithm === 14) {
      key = await crypto.subtle.importKey(
        "jwk",
        vector.jwk as never,
        { name: "ECDSA", namedCurve: vector.algorithm === 13 ? "P-256" : "P-384" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: vector.algorithm === 13 ? "SHA-256" : "SHA-384" },
        key,
        fromHex(vector.signature),
        RUNTIME_CAPABILITY_MESSAGE,
      );
    } else {
      key = await crypto.subtle.importKey("jwk", vector.jwk as never, "Ed25519", false, ["verify"]);
      valid = await crypto.subtle.verify(
        "Ed25519",
        key,
        fromHex(vector.signature),
        RUNTIME_CAPABILITY_MESSAGE,
      );
    }
    if (!valid) throw new Error(`HNS DNSSEC algorithm ${vector.algorithm} is unavailable`);
  }
}

function assertHnsAuthoritativeDnsPolicyV1RuntimeCapabilities(): Promise<void> {
  runtimeCapabilityCheck ??= verifyRuntimeCapabilityVectors();
  return runtimeCapabilityCheck;
}

export async function makeHnsAuthoritativeDnsValidatorV1(): Promise<HnsAuthoritativeDnsValidatorPortV1> {
  await assertHnsAuthoritativeDnsPolicyV1RuntimeCapabilities();
  return Object.freeze({
    policy_id: HNS_AUTHORITATIVE_DNS_VALIDATOR_POLICY_ID,
    validate: async (input) => validationResult(await validatePolicy(input), input),
  });
}
