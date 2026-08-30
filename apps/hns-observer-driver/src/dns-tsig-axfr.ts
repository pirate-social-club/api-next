import { createHmac, timingSafeEqual } from "node:crypto";
import { exchangeDirectHnsDnsTcpSequence, type HnsDnsTcpConnector } from "./dns-tcp.ts";

export const HNS_DNS_TSIG_AXFR_ALGORITHM = "hmac-sha256" as const;

export type HnsDnsTsigCredentialV1 = Readonly<{
  readonly key_name: string;
  readonly algorithm: typeof HNS_DNS_TSIG_AXFR_ALGORITHM;
  readonly secret_bytes: Uint8Array;
}>;

export type HnsDnsTsigAxfrSessionV1 = Readonly<{
  readonly request_bytes: Uint8Array;
  readonly accept_response: (message: Uint8Array, message_index: number) => boolean;
}>;

export type HnsDnsTsigAxfrExchangeResultV1 = Readonly<{
  readonly request_bytes: Uint8Array;
  readonly response_messages: ReadonlyArray<Uint8Array>;
}>;

export class HnsDnsTsigAxfrError extends Error {
  readonly name = "HnsDnsTsigAxfrError";
}

type ParsedName = Readonly<{ name: string; next_offset: number }>;
type ParsedRecord = Readonly<{
  name: string;
  type: number;
  record_class: number;
  ttl: number;
  start_offset: number;
  rdata_offset: number;
  end_offset: number;
}>;

type ParsedTsig = Readonly<{
  key_name: string;
  algorithm_name: string;
  time_signed: number;
  time_bytes: Uint8Array;
  fudge: number;
  fudge_bytes: Uint8Array;
  mac: Uint8Array;
  original_id: number;
  error: number;
  other_data: Uint8Array;
  start_offset: number;
}>;

const encoder = new TextEncoder();
const canonicalNamePattern =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/u;
const AXFR_TYPE = 252;
const SOA_TYPE = 6;
const TSIG_TYPE = 250;
const IN_CLASS = 1;
const ANY_CLASS = 255;
const HMAC_SHA256_NAME = "hmac-sha256";

function failed(message: string): HnsDnsTsigAxfrError {
  return new HnsDnsTsigAxfrError(message);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw failed("truncated DNS integer");
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw failed("truncated DNS integer");
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  writeUint16(bytes, 0, value);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  writeUint32(bytes, 0, value);
  return bytes;
}

function uint48(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffffffff) {
    throw failed("invalid TSIG time");
  }
  const bytes = new Uint8Array(6);
  bytes[0] = Math.floor(value / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(value / 0x100000000) & 0xff;
  writeUint32(bytes, 2, value >>> 0);
  return bytes;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function canonicalName(value: string): string {
  const name = value.endsWith(".") ? value.slice(0, -1) : value;
  const lowered = name.toLowerCase();
  if (
    lowered.length === 0 ||
    lowered.length > 253 ||
    lowered !== name ||
    !canonicalNamePattern.test(lowered) ||
    lowered.split(".").some((label) => encoder.encode(label).byteLength > 63)
  ) {
    throw failed("invalid canonical DNS name");
  }
  return lowered;
}

function encodeName(value: string): Uint8Array {
  const name = canonicalName(value);
  const labels = name.split(".").map((label) => encoder.encode(label));
  const bytes = new Uint8Array(labels.reduce((total, label) => total + label.byteLength + 1, 1));
  let offset = 0;
  for (const label of labels) {
    bytes[offset] = label.byteLength;
    bytes.set(label, offset + 1);
    offset += label.byteLength + 1;
  }
  return bytes;
}

function readName(bytes: Uint8Array, initialOffset: number): ParsedName {
  const labels: string[] = [];
  const visited = new Set<number>();
  let offset = initialOffset;
  let nextOffset: number | undefined;
  let expandedLength = 1;
  while (true) {
    if (offset >= bytes.byteLength || visited.has(offset)) throw failed("malformed DNS name");
    visited.add(offset);
    const length = bytes[offset] ?? 0;
    if ((length & 0xc0) === 0xc0) {
      if (offset + 2 > bytes.byteLength) throw failed("truncated DNS compression pointer");
      const pointer = ((length & 0x3f) << 8) | (bytes[offset + 1] ?? 0);
      if (pointer >= bytes.byteLength) throw failed("invalid DNS compression pointer");
      nextOffset ??= offset + 2;
      offset = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0 || length > 63) throw failed("invalid DNS label length");
    offset += 1;
    if (length === 0) {
      nextOffset ??= offset;
      break;
    }
    if (offset + length > bytes.byteLength) throw failed("truncated DNS label");
    const labelBytes = bytes.subarray(offset, offset + length);
    if ([...labelBytes].some((byte) => byte < 0x21 || byte > 0x7e)) {
      throw failed("unsupported DNS label encoding");
    }
    labels.push(String.fromCharCode(...labelBytes).toLowerCase());
    expandedLength += length + 1;
    if (expandedLength > 255) throw failed("expanded DNS name is too long");
    offset += length;
  }
  if (labels.length === 0) throw failed("root DNS name is outside the AXFR policy");
  return { name: labels.join("."), next_offset: nextOffset };
}

function readRecord(bytes: Uint8Array, offset: number): ParsedRecord {
  const startOffset = offset;
  const owner = readName(bytes, offset);
  offset = owner.next_offset;
  if (offset + 10 > bytes.byteLength) throw failed("truncated DNS resource record");
  const type = readUint16(bytes, offset);
  const recordClass = readUint16(bytes, offset + 2);
  const ttl = readUint32(bytes, offset + 4);
  const rdlength = readUint16(bytes, offset + 8);
  const rdataOffset = offset + 10;
  const endOffset = rdataOffset + rdlength;
  if (endOffset > bytes.byteLength) throw failed("DNS resource data crosses the message");
  return {
    name: owner.name,
    type,
    record_class: recordClass,
    ttl,
    start_offset: startOffset,
    rdata_offset: rdataOffset,
    end_offset: endOffset,
  };
}

function parseTsig(bytes: Uint8Array, record: ParsedRecord): ParsedTsig {
  if (record.type !== TSIG_TYPE || record.record_class !== ANY_CLASS || record.ttl !== 0) {
    throw failed("AXFR response lacks a canonical TSIG record");
  }
  let offset = record.rdata_offset;
  const algorithm = readName(bytes, offset);
  offset = algorithm.next_offset;
  if (offset + 10 > record.end_offset) throw failed("truncated TSIG data");
  const timeBytes = bytes.slice(offset, offset + 6);
  const timeSigned =
    (timeBytes[0] ?? 0) * 0x10000000000 +
    (timeBytes[1] ?? 0) * 0x100000000 +
    readUint32(timeBytes, 2);
  offset += 6;
  const fudgeBytes = bytes.slice(offset, offset + 2);
  const fudge = readUint16(fudgeBytes, 0);
  offset += 2;
  const macSize = readUint16(bytes, offset);
  offset += 2;
  if (macSize < 16 || macSize > 32 || offset + macSize + 6 > record.end_offset) {
    throw failed("invalid TSIG MAC length");
  }
  const mac = bytes.slice(offset, offset + macSize);
  offset += macSize;
  const originalId = readUint16(bytes, offset);
  const error = readUint16(bytes, offset + 2);
  const otherLength = readUint16(bytes, offset + 4);
  offset += 6;
  if (offset + otherLength !== record.end_offset) throw failed("invalid TSIG other data");
  return {
    key_name: record.name,
    algorithm_name: algorithm.name,
    time_signed: timeSigned,
    time_bytes: timeBytes,
    fudge,
    fudge_bytes: fudgeBytes,
    mac,
    original_id: originalId,
    error,
    other_data: bytes.slice(offset, record.end_offset),
    start_offset: record.start_offset,
  };
}

function canonicalSoa(bytes: Uint8Array, record: ParsedRecord): Uint8Array {
  if (record.type !== SOA_TYPE || record.record_class !== IN_CLASS)
    throw failed("invalid AXFR SOA");
  const mname = readName(bytes, record.rdata_offset);
  const rname = readName(bytes, mname.next_offset);
  if (rname.next_offset + 20 !== record.end_offset) throw failed("invalid AXFR SOA data");
  const rdata = concat([
    encodeName(mname.name),
    encodeName(rname.name),
    bytes.slice(rname.next_offset, record.end_offset),
  ]);
  return concat([
    encodeName(record.name),
    uint16(record.type),
    uint16(record.record_class),
    uint32(record.ttl),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function hmac(secret: Uint8Array, parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const digest = createHmac("sha256", secret);
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

function tsigVariables(
  keyName: string,
  timeBytes: Uint8Array,
  fudgeBytes: Uint8Array,
  error: number,
  otherData: Uint8Array,
): Uint8Array {
  return concat([
    encodeName(keyName),
    uint16(ANY_CLASS),
    uint32(0),
    encodeName(HMAC_SHA256_NAME),
    timeBytes,
    fudgeBytes,
    uint16(error),
    uint16(otherData.byteLength),
    otherData,
  ]);
}

function appendTsig(
  message: Uint8Array,
  input: Readonly<{
    key_name: string;
    time_bytes: Uint8Array;
    fudge_bytes: Uint8Array;
    mac: Uint8Array;
    original_id: number;
  }>,
): Uint8Array {
  const rdata = concat([
    encodeName(HMAC_SHA256_NAME),
    input.time_bytes,
    input.fudge_bytes,
    uint16(input.mac.byteLength),
    input.mac,
    uint16(input.original_id),
    uint16(0),
    uint16(0),
  ]);
  const record = concat([
    encodeName(input.key_name),
    uint16(TSIG_TYPE),
    uint16(ANY_CLASS),
    uint32(0),
    uint16(rdata.byteLength),
    rdata,
  ]);
  const result = concat([message, record]);
  writeUint16(result, 10, readUint16(message, 10) + 1);
  return result;
}

function requestWithoutTsig(messageId: number, zoneName: string): Uint8Array {
  const question = concat([encodeName(zoneName), uint16(AXFR_TYPE), uint16(IN_CLASS)]);
  const bytes = new Uint8Array(12 + question.byteLength);
  writeUint16(bytes, 0, messageId);
  writeUint16(bytes, 4, 1);
  bytes.set(question, 12);
  return bytes;
}

function messageWithoutTsig(message: Uint8Array, tsig: ParsedTsig): Uint8Array {
  if (tsig.start_offset <= 12 || tsig.start_offset >= message.byteLength) {
    throw failed("invalid TSIG position");
  }
  const result = message.slice(0, tsig.start_offset);
  const additionalCount = readUint16(message, 10);
  if (additionalCount !== 1) throw failed("unexpected AXFR additional records");
  writeUint16(result, 10, 0);
  writeUint16(result, 0, tsig.original_id);
  return result;
}

function parseAxfrResponse(
  message: Uint8Array,
  messageId: number,
  zoneName: string,
  messageIndex: number,
): Readonly<{
  tsig: ParsedTsig;
  soa_records: ReadonlyArray<Readonly<{ bytes: Uint8Array; answer_index: number }>>;
  answer_count: number;
}> {
  if (message.byteLength < 12 || readUint16(message, 0) !== messageId) {
    throw failed("AXFR response id mismatch");
  }
  const flags = readUint16(message, 2);
  if ((flags & 0x8000) === 0 || (flags & 0x0400) === 0 || (flags & 0x7a7f) !== 0) {
    throw failed("invalid AXFR response flags");
  }
  const questionCount = readUint16(message, 4);
  const answerCount = readUint16(message, 6);
  const authorityCount = readUint16(message, 8);
  const additionalCount = readUint16(message, 10);
  if (
    (messageIndex === 0 ? questionCount !== 1 : questionCount !== 0 && questionCount !== 1) ||
    answerCount === 0 ||
    authorityCount !== 0 ||
    additionalCount !== 1
  ) {
    throw failed("invalid AXFR section counts");
  }
  let offset = 12;
  if (questionCount === 1) {
    const question = readName(message, offset);
    offset = question.next_offset;
    if (
      question.name !== zoneName ||
      readUint16(message, offset) !== AXFR_TYPE ||
      readUint16(message, offset + 2) !== IN_CLASS
    ) {
      throw failed("AXFR question mismatch");
    }
    offset += 4;
  }
  const soaRecords: Array<Readonly<{ bytes: Uint8Array; answer_index: number }>> = [];
  for (let answerIndex = 0; answerIndex < answerCount; answerIndex += 1) {
    const record = readRecord(message, offset);
    offset = record.end_offset;
    if (record.type === SOA_TYPE) {
      soaRecords.push({ bytes: canonicalSoa(message, record), answer_index: answerIndex });
    }
  }
  const tsigRecord = readRecord(message, offset);
  offset = tsigRecord.end_offset;
  if (offset !== message.byteLength) throw failed("trailing AXFR response bytes");
  return {
    tsig: parseTsig(message, tsigRecord),
    soa_records: soaRecords,
    answer_count: answerCount,
  };
}

export function makeHnsDnsTsigAxfrSessionV1(
  input: Readonly<{
    readonly message_id: number;
    readonly zone_name: string;
    readonly credential: HnsDnsTsigCredentialV1;
    readonly signed_at_seconds: number;
    readonly fudge_seconds: number;
    readonly now_seconds: () => number;
  }>,
): HnsDnsTsigAxfrSessionV1 {
  if (
    !Number.isSafeInteger(input.message_id) ||
    input.message_id < 0 ||
    input.message_id > 65_535 ||
    input.credential.algorithm !== HNS_DNS_TSIG_AXFR_ALGORITHM ||
    input.credential.secret_bytes.byteLength < 16 ||
    input.credential.secret_bytes.byteLength > 512 ||
    !Number.isSafeInteger(input.fudge_seconds) ||
    input.fudge_seconds <= 0 ||
    input.fudge_seconds > 3_600
  ) {
    throw failed("invalid AXFR session input");
  }
  const zoneName = canonicalName(input.zone_name);
  const keyName = canonicalName(input.credential.key_name);
  const secret = Uint8Array.from(input.credential.secret_bytes);
  const timeBytes = uint48(input.signed_at_seconds);
  const fudgeBytes = uint16(input.fudge_seconds);
  const unsignedRequest = requestWithoutTsig(input.message_id, zoneName);
  const requestMac = hmac(secret, [
    unsignedRequest,
    tsigVariables(keyName, timeBytes, fudgeBytes, 0, new Uint8Array()),
  ]);
  const requestBytes = appendTsig(unsignedRequest, {
    key_name: keyName,
    time_bytes: timeBytes,
    fudge_bytes: fudgeBytes,
    mac: requestMac,
    original_id: input.message_id,
  });
  let priorMac = requestMac;
  let priorResponseTime: number | undefined;
  let openingSoa: Uint8Array | undefined;
  let completed = false;
  let nextMessageIndex = 0;

  return {
    request_bytes: requestBytes,
    accept_response: (message, messageIndex) => {
      if (
        completed ||
        messageIndex !== nextMessageIndex ||
        messageIndex < 0 ||
        !Number.isSafeInteger(messageIndex)
      ) {
        throw failed("invalid AXFR response sequence");
      }
      const parsed = parseAxfrResponse(message, input.message_id, zoneName, messageIndex);
      const tsig = parsed.tsig;
      const nowSeconds = input.now_seconds();
      if (
        tsig.key_name !== keyName ||
        tsig.algorithm_name !== HMAC_SHA256_NAME ||
        tsig.original_id !== input.message_id ||
        tsig.error !== 0 ||
        tsig.other_data.byteLength !== 0 ||
        (priorResponseTime !== undefined && tsig.time_signed < priorResponseTime) ||
        tsig.fudge > input.fudge_seconds ||
        !Number.isSafeInteger(nowSeconds) ||
        Math.abs(nowSeconds - tsig.time_signed) > tsig.fudge
      ) {
        throw failed("invalid AXFR TSIG metadata");
      }
      const unsignedMessage = messageWithoutTsig(message, tsig);
      const expectedMac =
        messageIndex === 0
          ? hmac(secret, [
              uint16(priorMac.byteLength),
              priorMac,
              unsignedMessage,
              tsigVariables(keyName, tsig.time_bytes, tsig.fudge_bytes, 0, new Uint8Array()),
            ])
          : hmac(secret, [
              uint16(priorMac.byteLength),
              priorMac,
              unsignedMessage,
              tsig.time_bytes,
              tsig.fudge_bytes,
            ]);
      if (!equalBytes(expectedMac.subarray(0, tsig.mac.byteLength), tsig.mac)) {
        throw failed("AXFR TSIG verification failed");
      }
      priorMac = Uint8Array.from(tsig.mac);
      priorResponseTime = tsig.time_signed;
      nextMessageIndex += 1;

      for (const soa of parsed.soa_records) {
        if (openingSoa === undefined) {
          if (messageIndex !== 0 || soa.answer_index !== 0) {
            throw failed("AXFR does not begin with SOA");
          }
          openingSoa = soa.bytes;
          continue;
        }
        if (!equalBytes(openingSoa, soa.bytes) || soa.answer_index !== parsed.answer_count - 1) {
          throw failed("AXFR terminal SOA mismatch");
        }
        completed = true;
      }
      if (messageIndex === 0 && openingSoa === undefined) {
        throw failed("AXFR does not begin with SOA");
      }
      if (parsed.soa_records.length > (messageIndex === 0 ? 2 : 1)) {
        throw failed("AXFR contains an intermediate SOA");
      }
      return completed;
    },
  };
}

/**
 * Performs one credential-bound, bounded AXFR acquisition. Returned messages
 * have already passed the complete RFC 8945 running-MAC chain and RFC 5936
 * opening/terminal SOA checks, but remain exact upstream wire bytes.
 */
export async function exchangeDirectHnsDnsTsigAxfrV1(
  input: Readonly<{
    readonly connector: HnsDnsTcpConnector;
    readonly host: string;
    readonly family: 4 | 6;
    readonly zone_name: string;
    readonly credential: HnsDnsTsigCredentialV1;
    readonly message_id: number;
    readonly signed_at_seconds: number;
    readonly fudge_seconds: number;
    readonly now_seconds: () => number;
    readonly response_message_max_bytes: number;
    readonly response_total_max_bytes: number;
    readonly response_max_messages: number;
    readonly timeout_ms: number;
    readonly signal: AbortSignal;
  }>,
): Promise<HnsDnsTsigAxfrExchangeResultV1> {
  const session = makeHnsDnsTsigAxfrSessionV1({
    message_id: input.message_id,
    zone_name: input.zone_name,
    credential: input.credential,
    signed_at_seconds: input.signed_at_seconds,
    fudge_seconds: input.fudge_seconds,
    now_seconds: input.now_seconds,
  });
  const responseMessages = await exchangeDirectHnsDnsTcpSequence({
    connector: input.connector,
    host: input.host,
    family: input.family,
    request_bytes: session.request_bytes,
    response_message_max_bytes: input.response_message_max_bytes,
    response_total_max_bytes: input.response_total_max_bytes,
    response_max_messages: input.response_max_messages,
    is_complete: session.accept_response,
    timeout_ms: input.timeout_ms,
    signal: input.signal,
  });
  return {
    request_bytes: Uint8Array.from(session.request_bytes),
    response_messages: responseMessages.map((message) => Uint8Array.from(message)),
  };
}
