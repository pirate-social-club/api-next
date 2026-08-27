import type {
  IpfsPinningAdapter,
  IpfsPinningInput,
  IpfsPinningLimits,
  IpfsPinningResult,
} from "@pirate/application/data/ipfs-pinning";
import {
  IPFS_PINNING_MAX_CONTENT_TYPE_BYTES,
  IPFS_PINNING_MAX_CONVERGENCE_ATTEMPTS,
  IPFS_PINNING_MAX_CONVERGENCE_DELAY_MS,
  IPFS_PINNING_MAX_FILENAME_BYTES,
  IPFS_PINNING_MAX_IDENTIFIER_BYTES,
  IPFS_PINNING_MAX_RESPONSE_BYTES,
  IPFS_PINNING_MAX_SECRET_BYTES,
  IPFS_PINNING_MAX_TIMEOUT_MS,
  IpfsPinningRequestInvalid,
} from "@pirate/application/data/ipfs-pinning";
import { Effect, Predicate } from "effect";

export const FILEBASE_IPFS_RPC_ORIGIN = "https://rpc.filebase.io" as const;
export const FILEBASE_IPFS_ADD_PATH = "/api/v0/add" as const;
export const FILEBASE_IPFS_PIN_ADD_PATH = "/api/v0/pin/add" as const;
export const FILEBASE_IPFS_PIN_LS_PATH = "/api/v0/pin/ls" as const;
export const FILEBASE_IPFS_CAT_PATH = "/api/v0/cat" as const;
export const FILEBASE_IPFS_ADD_QUERY = "?cid-version=1&wrap-with-directory=false" as const;
export const FILEBASE_IPFS_MULTIPART_BOUNDARY_PREFIX = "----pirate-filebase-ipfs-v1-" as const;
export const FILEBASE_IPFS_BOUNDARY_RANDOM_BYTES = 18 as const;
export const FILEBASE_IPFS_ADAPTER_REVISION = "filebase-ipfs-pinning-v1" as const;
export const FILEBASE_IPFS_MAX_JSON_BYTES = 2 * 1024 * 1024;
export const FILEBASE_IPFS_MAX_CID_BYTES = 128;
/** Internal transport safety cap; accepted product limits are always injected. */
export const FILEBASE_IPFS_INTERNAL_MAX_SOURCE_BYTES = 512 * 1024 * 1024;

export type FilebaseIpfsRequestBody = Readonly<{
  readonly byte_length: number;
  readonly content_type: string;
  /** The body is replayable only in the sense that the transport may inspect it once. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type FilebaseIpfsTransportRequest = Readonly<{
  readonly method: "POST";
  readonly url: string;
  readonly path:
    | typeof FILEBASE_IPFS_ADD_PATH
    | typeof FILEBASE_IPFS_PIN_ADD_PATH
    | typeof FILEBASE_IPFS_PIN_LS_PATH
    | typeof FILEBASE_IPFS_CAT_PATH;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: FilebaseIpfsRequestBody;
  readonly signal: AbortSignal;
  readonly redirect: "error";
}>;

export type FilebaseIpfsResponseBody = Readonly<{
  readonly open: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
  readonly cancel: (reason?: unknown) => void | PromiseLike<void>;
}>;

export type FilebaseIpfsTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Headers | Readonly<Record<string, string>>;
  readonly body: FilebaseIpfsResponseBody;
}>;

export type FilebaseIpfsTransport = (
  request: FilebaseIpfsTransportRequest,
) => PromiseLike<FilebaseIpfsTransportResponse>;

export type FilebaseIpfsRandomBytes = (length: number) => Uint8Array;

export type FilebaseIpfsAdapterOptions = Readonly<{
  /** Disabled is the safe default and makes no transport call. */
  readonly enabled?: boolean;
  /** Opaque bucket-scoped bearer token. It never appears in a result. */
  readonly token?: string;
  readonly transport?: FilebaseIpfsTransport;
  /** Test-only entropy injection; production uses crypto.getRandomValues. */
  readonly random_bytes?: (length: number) => Uint8Array;
  readonly limits?: IpfsPinningLimits;
}>;

type Config = Readonly<{
  readonly token: string;
  readonly transport: FilebaseIpfsTransport;
  readonly limits: IpfsPinningLimits;
  readonly random_bytes: FilebaseIpfsRandomBytes;
}>;

class OperationAbort extends Error {
  readonly reason: "timeout" | "cancelled";

  constructor(reason: "timeout" | "cancelled") {
    super(reason);
    this.name = "OperationAbort";
    this.reason = reason;
  }
}

class MultipartBodyError extends Error {
  readonly reason: "length" | "sha256";

  constructor(reason: "length" | "sha256") {
    super(reason);
    this.name = "MultipartBodyError";
    this.reason = reason;
  }
}

class ResponseBodyError extends Error {
  readonly reason: "malformed" | "oversized" | "aborted" | "wrong_content_type";

  constructor(reason: "malformed" | "oversized" | "aborted" | "wrong_content_type") {
    super(reason);
    this.name = "ResponseBodyError";
    this.reason = reason;
  }
}

class InvalidCidResponseError extends Error {
  constructor() {
    super("invalid_cid");
    this.name = "InvalidCidResponseError";
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validBoundedText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > maximum) return false;
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  });
}

function validIdentifier(value: unknown): value is string {
  return (
    validBoundedText(value, IPFS_PINNING_MAX_IDENTIFIER_BYTES) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function validFilename(value: unknown): value is string {
  return (
    validBoundedText(value, IPFS_PINNING_MAX_FILENAME_BYTES) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

function validContentType(value: unknown): value is string {
  return (
    validBoundedText(value, IPFS_PINNING_MAX_CONTENT_TYPE_BYTES) &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validLimits(value: unknown): value is IpfsPinningLimits {
  if (!Predicate.isObject(value)) return false;
  const limits = value as Record<string, unknown>;
  return (
    validPositiveInteger(limits.max_source_bytes, FILEBASE_IPFS_INTERNAL_MAX_SOURCE_BYTES) &&
    validPositiveInteger(limits.max_response_bytes, IPFS_PINNING_MAX_RESPONSE_BYTES) &&
    validPositiveInteger(limits.timeout_ms, IPFS_PINNING_MAX_TIMEOUT_MS) &&
    validPositiveInteger(limits.pin_convergence_attempts, IPFS_PINNING_MAX_CONVERGENCE_ATTEMPTS) &&
    typeof limits.pin_convergence_delay_ms === "number" &&
    Number.isSafeInteger(limits.pin_convergence_delay_ms) &&
    limits.pin_convergence_delay_ms >= 0 &&
    limits.pin_convergence_delay_ms <= IPFS_PINNING_MAX_CONVERGENCE_DELAY_MS
  );
}

function validToken(value: unknown): value is string {
  return (
    validBoundedText(value, IPFS_PINNING_MAX_SECRET_BYTES) &&
    !/[\r\n]/u.test(value) &&
    !/\s/u.test(value)
  );
}

function defaultRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function randomBoundary(randomBytes: FilebaseIpfsRandomBytes): string | null {
  try {
    const bytes = randomBytes(FILEBASE_IPFS_BOUNDARY_RANDOM_BYTES);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== FILEBASE_IPFS_BOUNDARY_RANDOM_BYTES
    ) {
      return null;
    }
    const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${FILEBASE_IPFS_MULTIPART_BOUNDARY_PREFIX}${suffix}`;
  } catch {
    return null;
  }
}

function snapshotInput(input: IpfsPinningInput): IpfsPinningInput | null {
  try {
    if (!Predicate.isObject(input) || !Predicate.isObject(input.source)) return null;
    return Object.freeze({
      version: input.version,
      request_id: input.request_id,
      filename: input.filename,
      content_type: input.content_type,
      source: Object.freeze({
        byte_length: input.source.byte_length,
        open: input.source.open,
      }),
      expected_byte_length: input.expected_byte_length,
      expected_sha256: input.expected_sha256,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return null;
  }
}

function validateInput(input: IpfsPinningInput, limits: IpfsPinningLimits): void {
  if (input.version !== "ipfs-pinning-v1") {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_version" });
  }
  if (!validIdentifier(input.request_id)) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_request_id" });
  }
  if (!validFilename(input.filename)) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_filename" });
  }
  if (!validContentType(input.content_type)) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_content_type" });
  }
  if (
    !Predicate.isObject(input.source) ||
    typeof input.source.open !== "function" ||
    !Number.isSafeInteger(input.source.byte_length) ||
    input.source.byte_length < 0
  ) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_source" });
  }
  if (
    !Number.isSafeInteger(input.expected_byte_length) ||
    input.expected_byte_length < 0 ||
    input.expected_byte_length !== input.source.byte_length ||
    input.expected_byte_length > limits.max_source_bytes
  ) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_expected_length" });
  }
  if (!validSha256(input.expected_sha256)) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_expected_sha256" });
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw new IpfsPinningRequestInvalid({ reason: "invalid_signal" });
  }
}

function headersToMap(headers: Headers | Readonly<Record<string, string>>): Map<string, string> {
  if (headers instanceof Headers) {
    return new Map([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function mediaType(headers: Headers | Readonly<Record<string, string>>): string | null {
  const value = headersToMap(headers).get("content-type");
  return value === undefined ? null : (value.split(";", 1)[0]?.trim().toLowerCase() ?? null);
}

function responseHeaders(
  response: FilebaseIpfsTransportResponse,
  allowed: readonly string[],
): boolean {
  const type = mediaType(response.headers);
  return type !== null && allowed.includes(type);
}

async function cancelResponse(
  response: FilebaseIpfsTransportResponse,
  reason: string,
): Promise<void> {
  try {
    void Promise.resolve(response.body.cancel(reason)).catch(() => undefined);
  } catch {
    // Cancellation is best effort; the selected closed result must win.
  }
}

function abortError(signal: AbortSignal): OperationAbort {
  return new OperationAbort(signal.reason === "timeout" ? "timeout" : "cancelled");
}

function disposeIterator<T>(iterator: AsyncIterator<T>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  } catch {
    // Hostile iterator cleanup must never replace the selected result.
  }
}

function bytesToString(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ResponseBodyError("malformed");
  }
}

async function readBounded(
  response: FilebaseIpfsTransportResponse,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) {
    await cancelResponse(response, "aborted");
    throw abortError(signal);
  }
  const iterator = response.body.open(signal)[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((error: OperationAbort) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void cancelResponse(response, "aborted");
    rejectAbort?.(abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const part = await Promise.race([iterator.next(), abortPromise]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new ResponseBodyError("malformed");
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await cancelResponse(response, "response_too_large");
        throw new ResponseBodyError("oversized");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof OperationAbort) {
      await cancelResponse(response, "aborted");
      throw error;
    }
    if (error instanceof ResponseBodyError) {
      await cancelResponse(response, error.reason);
      throw error;
    }
    await cancelResponse(response, "response_stream_failure");
    throw new ResponseBodyError("malformed");
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      disposeIterator(iterator);
    } catch {
      // A hostile iterator may reject cleanup; no bytes are retained here.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length && index < offset + 5; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (index > offset && byte === 0) return null;
      return Number.isSafeInteger(value) ? { value, next: index + 1 } : null;
    }
    shift += 7;
  }
  return null;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function decodeBase58(value: string): Uint8Array | null {
  const digits: number[] = [];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    digits.push(digit);
  }
  const bytes: number[] = [0];
  for (const digit of digits) {
    let carry = digit;
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      const current = (bytes[index] ?? 0) * 58 + carry;
      bytes[index] = current & 0xff;
      carry = current >> 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") leadingZeroes += 1;
  return new Uint8Array([
    ...new Array(leadingZeroes).fill(0),
    ...bytes.slice(bytes[0] === 0 ? 1 : 0),
  ]);
}

function decodeBase32(value: string): Uint8Array | null {
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    buffer = buffer * 32 + digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
      buffer &= 2 ** bits - 1;
    }
  }
  if (bits >= 5 || (bits > 0 && buffer !== 0)) return null;
  return new Uint8Array(output);
}

/** Strict canonical CIDv0/CIDv1 structural validation. */
export function isValidFilebaseCid(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Length(value) > FILEBASE_IPFS_MAX_CID_BYTES
  ) {
    return false;
  }
  if (value.startsWith("Qm")) {
    if (value.length !== 46) return false;
    const decoded = decodeBase58(value);
    return decoded !== null && decoded.length === 34 && decoded[0] === 0x12 && decoded[1] === 0x20;
  }
  if (!value.startsWith("b") || value.length < 4 || value !== value.toLowerCase()) return false;
  const decoded = decodeBase32(value.slice(1));
  if (decoded === null) return false;
  const version = readVarint(decoded, 0);
  if (version === null || version.value !== 1) return false;
  const codec = readVarint(decoded, version.next);
  if (codec === null || codec.value === 0) return false;
  const hashCode = readVarint(decoded, codec.next);
  if (hashCode === null || hashCode.value === 0) return false;
  const digestLength = readVarint(decoded, hashCode.next);
  return (
    digestLength !== null &&
    digestLength.value > 0 &&
    digestLength.next + digestLength.value === decoded.length
  );
}

function toUint32(value: number): number {
  return value >>> 0;
}

/** Small incremental SHA-256 implementation for bounded streams. */
class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private byteLength = 0;

  update(bytes: Uint8Array): void {
    this.byteLength += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = Math.min(64 - this.blockLength, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === 64) {
        this.compress(this.block, this.state);
        this.blockLength = 0;
      }
    }
  }

  digest(): string {
    const state = new Uint32Array(this.state);
    const tail = new Uint8Array(128);
    tail.set(this.block.subarray(0, this.blockLength));
    tail[this.blockLength] = 0x80;
    const bitLength = this.byteLength * 8;
    const end = this.blockLength < 56 ? 64 : 128;
    const view = new DataView(tail.buffer);
    view.setUint32(end - 8, Math.floor(bitLength / 2 ** 32), false);
    view.setUint32(end - 4, bitLength >>> 0, false);
    for (let offset = 0; offset < end; offset += 64)
      this.compress(tail.subarray(offset, offset + 64), state);
    return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array, state: Uint32Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15] ?? 0;
      const value2 = words[index - 2] ?? 0;
      const s0 = ((value >>> 7) | (value << 25)) ^ ((value >>> 18) | (value << 14)) ^ (value >>> 3);
      const s1 =
        ((value2 >>> 17) | (value2 << 15)) ^ ((value2 >>> 19) | (value2 << 13)) ^ (value2 >>> 10);
      words[index] = toUint32((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1);
    }
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
      0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
      0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
      0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
      0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
      0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
      0xc67178f2,
    ];
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temp1 = toUint32(h + s1 + choice + (constants[index] ?? 0) + (words[index] ?? 0));
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = toUint32(s0 + majority);
      h = g;
      g = f;
      f = e;
      e = toUint32(d + temp1);
      d = c;
      c = b;
      b = a;
      a = toUint32(temp1 + temp2);
    }
    state[0] = toUint32((state[0] ?? 0) + a);
    state[1] = toUint32((state[1] ?? 0) + b);
    state[2] = toUint32((state[2] ?? 0) + c);
    state[3] = toUint32((state[3] ?? 0) + d);
    state[4] = toUint32((state[4] ?? 0) + e);
    state[5] = toUint32((state[5] ?? 0) + f);
    state[6] = toUint32((state[6] ?? 0) + g);
    state[7] = toUint32((state[7] ?? 0) + h);
  }
}

function emptyBody(): FilebaseIpfsRequestBody {
  return {
    byte_length: 0,
    content_type: "application/octet-stream",
    open: async function* (signal) {
      if (signal.aborted) throw abortError(signal);
      yield new Uint8Array(0);
    },
  };
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function boundaryCollisionGuard(boundary: string): (chunk: Uint8Array) => void {
  const marker = new TextEncoder().encode(`--${boundary}`);
  let suffix = new Uint8Array(0);
  return (chunk) => {
    const combined = new Uint8Array(suffix.byteLength + chunk.byteLength);
    combined.set(suffix);
    combined.set(chunk, suffix.byteLength);
    if (containsBytes(combined, marker)) throw new MultipartBodyError("length");
    suffix = combined.slice(Math.max(0, combined.byteLength - marker.byteLength + 1));
  };
}

function multipartBody(
  input: IpfsPinningInput,
  limits: IpfsPinningLimits,
  boundary: string,
): FilebaseIpfsRequestBody {
  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\nContent-Type: ${input.content_type}\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);
  let opened = false;
  return {
    byte_length: preamble.byteLength + input.expected_byte_length + epilogue.byteLength,
    content_type: `multipart/form-data; boundary=${boundary}`,
    open: async function* (signal) {
      if (opened) throw new MultipartBodyError("length");
      opened = true;
      if (signal.aborted) throw abortError(signal);
      yield preamble;
      const hash = new Sha256();
      const guardBoundaryCollision = boundaryCollisionGuard(boundary);
      let total = 0;
      const sourceIterator = input.source.open(signal)[Symbol.asyncIterator]();
      let rejectAbort: ((error: OperationAbort) => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => {
        disposeIterator(sourceIterator);
        rejectAbort?.(new OperationAbort(signal.reason === "timeout" ? "timeout" : "cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          const part = await Promise.race([sourceIterator.next(), abortPromise]);
          if (part.done) break;
          const chunk = part.value;
          if (signal.aborted) throw abortError(signal);
          if (!(chunk instanceof Uint8Array)) throw new MultipartBodyError("length");
          guardBoundaryCollision(chunk);
          total += chunk.byteLength;
          if (total > input.expected_byte_length || total > limits.max_source_bytes) {
            throw new MultipartBodyError("length");
          }
          hash.update(chunk);
          yield chunk;
        }
      } catch (error) {
        if (error instanceof OperationAbort || error instanceof MultipartBodyError) throw error;
        throw new MultipartBodyError("length");
      } finally {
        signal.removeEventListener("abort", onAbort);
        disposeIterator(sourceIterator);
      }
      if (total !== input.expected_byte_length) throw new MultipartBodyError("length");
      if (hash.digest() !== input.expected_sha256) throw new MultipartBodyError("sha256");
      yield epilogue;
    },
  };
}

function parseJsonLine(bytes: Uint8Array): Record<string, unknown> {
  const text = bytesToString(bytes).trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) throw new ResponseBodyError("malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] ?? "");
  } catch {
    throw new ResponseBodyError("malformed");
  }
  if (!Predicate.isObject(parsed) || Array.isArray(parsed))
    throw new ResponseBodyError("malformed");
  return parsed as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseAddResponse(value: Record<string, unknown>): string {
  if (!hasOnlyKeys(value, ["Hash"], ["Bytes", "Mode", "Mtime", "MtimeNsecs", "Name", "Size"])) {
    throw new ResponseBodyError("malformed");
  }
  if (Object.hasOwn(value, "Name") && !validPinName(value.Name)) {
    throw new ResponseBodyError("malformed");
  }
  for (const key of ["Size", "Bytes"] as const)
    if (
      Object.hasOwn(value, key) &&
      !boundedUnsignedInteger(value[key], FILEBASE_IPFS_INTERNAL_MAX_SOURCE_BYTES)
    )
      throw new ResponseBodyError("malformed");
  if (Object.hasOwn(value, "Mode") && !validBoundedText(value.Mode, 32))
    throw new ResponseBodyError("malformed");
  if (Object.hasOwn(value, "Mtime") && !boundedSignedInteger(value.Mtime, Number.MAX_SAFE_INTEGER))
    throw new ResponseBodyError("malformed");
  if (Object.hasOwn(value, "MtimeNsecs") && !boundedUnsignedInteger(value.MtimeNsecs, 999_999_999))
    throw new ResponseBodyError("malformed");
  const cid = stringField(value, "Hash");
  if (cid === null || !isValidFilebaseCid(cid)) {
    throw new InvalidCidResponseError();
  }
  return cid;
}

function boundedUnsignedInteger(value: unknown, maximum: number): boolean {
  return (
    (typeof value === "string" && /^[0-9]+$/u.test(value) && Number(value) <= maximum) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum)
  );
}

function boundedSignedInteger(value: unknown, maximum: number): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && Math.abs(value) <= maximum;
  }
  return (
    typeof value === "string" && /^-?[0-9]+$/u.test(value) && Math.abs(Number(value)) <= maximum
  );
}

function validPinName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8Length(value) <= IPFS_PINNING_MAX_IDENTIFIER_BYTES &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
  );
}

function parsePinAddResponse(value: Record<string, unknown>, cid: string): void {
  if (!hasOnlyKeys(value, ["Pins"], ["Bytes", "Progress"])) {
    throw new ResponseBodyError("malformed");
  }
  if (
    !Array.isArray(value.Pins) ||
    value.Pins.length === 0 ||
    !value.Pins.every((pin) => typeof pin === "string" && isValidFilebaseCid(pin)) ||
    !value.Pins.includes(cid)
  ) {
    throw new ResponseBodyError("malformed");
  }
  if (
    (Object.hasOwn(value, "Bytes") &&
      !boundedUnsignedInteger(value.Bytes, FILEBASE_IPFS_INTERNAL_MAX_SOURCE_BYTES)) ||
    (Object.hasOwn(value, "Progress") &&
      !boundedUnsignedInteger(value.Progress, FILEBASE_IPFS_INTERNAL_MAX_SOURCE_BYTES))
  ) {
    throw new ResponseBodyError("malformed");
  }
}

function parsePinLsResponse(value: Record<string, unknown>, cid: string): boolean {
  if (
    !hasOnlyKeys(value, ["Keys"]) ||
    !Predicate.isObject(value.Keys) ||
    Array.isArray(value.Keys)
  ) {
    throw new ResponseBodyError("malformed");
  }
  // Kubo's PinLsList is the typed output value; its non-stream JSON encoder
  // emits that value directly, so the wire body is {"Keys": ...}.
  const keys = value.Keys as Record<string, unknown>;
  for (const [key, entry] of Object.entries(keys)) {
    if (!isValidFilebaseCid(key) || !Predicate.isObject(entry) || Array.isArray(entry)) {
      throw new ResponseBodyError("malformed");
    }
    const pinEntry = entry as Record<string, unknown>;
    if (!hasOnlyKeys(pinEntry, ["Type"], ["Name"])) {
      throw new ResponseBodyError("malformed");
    }
    if (
      pinEntry.Type !== "direct" &&
      pinEntry.Type !== "indirect" &&
      pinEntry.Type !== "recursive"
    ) {
      throw new ResponseBodyError("malformed");
    }
    if (Object.hasOwn(pinEntry, "Name") && !validPinName(pinEntry.Name)) {
      throw new ResponseBodyError("malformed");
    }
  }
  const matchingEntry = keys[cid];
  if (matchingEntry === undefined) return false;
  return Predicate.isObject(matchingEntry) && matchingEntry.Type === "recursive";
}

function resultForHttpStatus(
  status: number,
  path: FilebaseIpfsTransportRequest["path"],
): IpfsPinningResult {
  if (status === 404)
    return path === FILEBASE_IPFS_CAT_PATH
      ? { status: "not_found", outcome: "not_found" }
      : { status: "retryable", outcome: "retryable", reason: "pin_not_converged" };
  if (status === 401 || status === 403)
    return { status: "permanent", outcome: "permanent", reason: "unauthorized" };
  if (status === 429) return { status: "retryable", outcome: "retryable", reason: "throttled" };
  if (status >= 500)
    return { status: "retryable", outcome: "retryable", reason: "provider_unavailable" };
  return { status: "permanent", outcome: "permanent", reason: "provider_rejected" };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function statusPath(
  path: FilebaseIpfsTransportRequest["path"],
  status: number,
): IpfsPinningResult | null {
  if (status >= 200 && status < 300) return null;
  if (path === FILEBASE_IPFS_PIN_ADD_PATH && status === 409) return null;
  return resultForHttpStatus(status, path);
}

export function makeFilebaseIpfsPinningAdapter(
  options: FilebaseIpfsAdapterOptions = {},
): IpfsPinningAdapter {
  const enabled = options.enabled === true;
  const token = options.token;
  const transport = options.transport;
  const randomBytes = options.random_bytes ?? defaultRandomBytes;
  const limits = options.limits;
  const config: Config | null =
    enabled &&
    validToken(token) &&
    transport !== undefined &&
    typeof randomBytes === "function" &&
    validLimits(limits)
      ? Object.freeze({
          token,
          transport,
          limits: Object.freeze({ ...limits }),
          random_bytes: randomBytes,
        })
      : null;

  const pin = (input: IpfsPinningInput) => {
    const capturedInput = snapshotInput(input);
    return Effect.tryPromise<IpfsPinningResult, IpfsPinningRequestInvalid>({
      try: async () => {
        if (!enabled) return { status: "disabled", outcome: "disabled" };
        if (config === null)
          return { status: "permanent", outcome: "permanent", reason: "configuration" };
        if (capturedInput === null)
          throw new IpfsPinningRequestInvalid({ reason: "invalid_source" });
        const requestInput = capturedInput;
        validateInput(requestInput, config.limits);
        const boundary = randomBoundary(config.random_bytes);
        if (boundary === null)
          return { status: "permanent", outcome: "permanent", reason: "configuration" };
        if (requestInput.signal?.aborted) return { status: "cancelled", outcome: "cancelled" };

        const controller = new AbortController();
        let abortReason: "timeout" | "cancelled" | undefined;
        const callerAbort = () => {
          abortReason = "cancelled";
          controller.abort(abortReason);
        };
        requestInput.signal?.addEventListener("abort", callerAbort, { once: true });
        const timer = setTimeout(() => {
          abortReason = "timeout";
          controller.abort(abortReason);
        }, config.limits.timeout_ms);
        let operationFinished = false;
        const request = (
          path: FilebaseIpfsTransportRequest["path"],
          body: FilebaseIpfsRequestBody,
          query = "",
        ) => ({
          method: "POST" as const,
          url: `${FILEBASE_IPFS_RPC_ORIGIN}${path}${query}`,
          path,
          headers: {
            accept:
              path === FILEBASE_IPFS_CAT_PATH ? "application/octet-stream" : "application/json",
            authorization: `Bearer ${config.token}`,
            "content-type": body.content_type,
            "content-length": String(body.byte_length),
          },
          body,
          signal: controller.signal,
          redirect: "error" as const,
        });
        const call = async (
          path: FilebaseIpfsTransportRequest["path"],
          body: FilebaseIpfsRequestBody,
          query = "",
        ): Promise<FilebaseIpfsTransportResponse> => {
          if (controller.signal.aborted) throw new OperationAbort(abortReason ?? "cancelled");
          const transportPromise = Promise.resolve(config.transport(request(path, body, query)));
          let rejectAbort: ((error: OperationAbort) => void) | undefined;
          const abortPromise = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
          const onAbort = () => rejectAbort?.(new OperationAbort(abortReason ?? "cancelled"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          void transportPromise.then(
            (response) => {
              if (operationFinished || controller.signal.aborted)
                void cancelResponse(response, "late_response");
            },
            () => undefined,
          );
          try {
            return await Promise.race([transportPromise, abortPromise]);
          } finally {
            controller.signal.removeEventListener("abort", onAbort);
          }
        };
        const parseJsonResponse = async (
          response: FilebaseIpfsTransportResponse,
          allowedTypes: readonly string[],
        ): Promise<Record<string, unknown>> => {
          if (!responseHeaders(response, allowedTypes)) {
            await cancelResponse(response, "wrong_content_type");
            throw new ResponseBodyError("wrong_content_type");
          }
          return parseJsonLine(
            await readBounded(response, config.limits.max_response_bytes, controller.signal),
          );
        };
        try {
          const addResponse = await call(
            FILEBASE_IPFS_ADD_PATH,
            multipartBody(requestInput, config.limits, boundary),
            FILEBASE_IPFS_ADD_QUERY,
          );
          const addStatus = statusPath(FILEBASE_IPFS_ADD_PATH, addResponse.status);
          if (addStatus !== null) {
            await cancelResponse(addResponse, "http_status");
            return addStatus;
          }
          const add = await parseJsonResponse(addResponse, [
            "application/json",
            "application/x-ndjson",
          ]);
          let cid: string;
          try {
            cid = parseAddResponse(add);
          } catch (error) {
            if (error instanceof InvalidCidResponseError) {
              return { status: "malformed", outcome: "malformed", reason: "invalid_cid" };
            }
            throw error;
          }
          const pinAdd = await call(
            FILEBASE_IPFS_PIN_ADD_PATH,
            emptyBody(),
            `?arg=${encodeURIComponent(cid)}`,
          );
          const pinAddStatus = statusPath(FILEBASE_IPFS_PIN_ADD_PATH, pinAdd.status);
          if (pinAddStatus !== null) {
            await cancelResponse(pinAdd, "http_status");
            return pinAddStatus;
          }
          if (pinAdd.status !== 409) {
            const pinAddBody = await parseJsonResponse(pinAdd, ["application/json"]);
            parsePinAddResponse(pinAddBody, cid);
          } else {
            await cancelResponse(pinAdd, "duplicate_pin");
          }

          let recursive = false;
          let lastPinLsRetryable:
            | Extract<IpfsPinningResult, { readonly status: "retryable" }>
            | undefined;
          for (let attempt = 0; attempt < config.limits.pin_convergence_attempts; attempt += 1) {
            const pinLs = await call(
              FILEBASE_IPFS_PIN_LS_PATH,
              emptyBody(),
              `?arg=${encodeURIComponent(cid)}&stream=false&names=false`,
            );
            const pinLsStatus = statusPath(FILEBASE_IPFS_PIN_LS_PATH, pinLs.status);
            if (pinLsStatus !== null) {
              await cancelResponse(pinLs, "http_status");
              if (pinLsStatus.status === "retryable") {
                lastPinLsRetryable = pinLsStatus;
                if (attempt + 1 < config.limits.pin_convergence_attempts) {
                  await delay(config.limits.pin_convergence_delay_ms, controller.signal);
                }
                continue;
              }
              return pinLsStatus;
            }
            const listing = await parseJsonResponse(pinLs, ["application/json"]);
            recursive = parsePinLsResponse(listing, cid);
            if (recursive) break;
            if (attempt + 1 < config.limits.pin_convergence_attempts) {
              await delay(config.limits.pin_convergence_delay_ms, controller.signal);
            }
          }
          if (!recursive)
            return (
              lastPinLsRetryable ?? {
                status: "retryable",
                outcome: "retryable",
                reason: "pin_not_converged",
              }
            );

          const cat = await call(
            FILEBASE_IPFS_CAT_PATH,
            emptyBody(),
            `?arg=${encodeURIComponent(cid)}`,
          );
          const catStatus = statusPath(FILEBASE_IPFS_CAT_PATH, cat.status);
          if (catStatus !== null) {
            await cancelResponse(cat, "http_status");
            return catStatus;
          }
          if (!responseHeaders(cat, ["application/octet-stream", "text/plain"])) {
            await cancelResponse(cat, "wrong_content_type");
            return { status: "malformed", outcome: "malformed", reason: "wrong_content_type" };
          }
          let catIterator: AsyncIterator<Uint8Array> | undefined;
          let catFullyConsumed = false;
          try {
            const catHash = new Sha256();
            let catBytes = 0;
            let rejectCatAbort: ((error: OperationAbort) => void) | undefined;
            const catAbort = new Promise<never>((_resolve, reject) => {
              rejectCatAbort = reject;
            });
            const onCatAbort = () => {
              void cancelResponse(cat, "aborted");
              rejectCatAbort?.(new OperationAbort(abortReason ?? "cancelled"));
            };
            controller.signal.addEventListener("abort", onCatAbort, { once: true });
            try {
              catIterator = cat.body.open(controller.signal)[Symbol.asyncIterator]();
              while (true) {
                const part = await Promise.race([catIterator.next(), catAbort]);
                if (part.done) break;
                if (!(part.value instanceof Uint8Array)) {
                  throw new ResponseBodyError("malformed");
                }
                catBytes += part.value.byteLength;
                if (
                  catBytes > requestInput.expected_byte_length ||
                  catBytes > config.limits.max_source_bytes
                ) {
                  return {
                    status: "integrity_mismatch",
                    outcome: "integrity_mismatch",
                    reason: "length",
                  };
                }
                catHash.update(part.value);
              }
            } catch (error) {
              if (error instanceof OperationAbort || error instanceof ResponseBodyError)
                throw error;
              throw new ResponseBodyError("malformed");
            } finally {
              controller.signal.removeEventListener("abort", onCatAbort);
              if (catIterator !== undefined) disposeIterator(catIterator);
            }
            if (catBytes !== requestInput.expected_byte_length)
              return {
                status: "integrity_mismatch",
                outcome: "integrity_mismatch",
                reason: "length",
              };
            if (catHash.digest() !== requestInput.expected_sha256)
              return {
                status: "integrity_mismatch",
                outcome: "integrity_mismatch",
                reason: "sha256",
              };
            catFullyConsumed = true;
            return {
              status: "pinned",
              outcome: "pinned",
              cid,
              byte_length: catBytes,
              sha256: requestInput.expected_sha256,
              recursive: true,
            };
          } finally {
            if (!catFullyConsumed) void cancelResponse(cat, "cat_discard");
          }
        } catch (error) {
          if (error instanceof OperationAbort) {
            return error.reason === "timeout"
              ? { status: "timeout", outcome: "retryable", reason: "timeout" }
              : { status: "cancelled", outcome: "cancelled" };
          }
          if (error instanceof MultipartBodyError)
            return {
              status: "integrity_mismatch",
              outcome: "integrity_mismatch",
              reason: error.reason,
            };
          if (error instanceof ResponseBodyError) {
            if (error.reason === "wrong_content_type") {
              return { status: "malformed", outcome: "malformed", reason: "wrong_content_type" };
            }
            return error.reason === "oversized"
              ? { status: "malformed", outcome: "malformed", reason: "oversized_response" }
              : { status: "malformed", outcome: "malformed", reason: "malformed_response" };
          }
          return { status: "retryable", outcome: "retryable", reason: "transport" };
        } finally {
          operationFinished = true;
          controller.abort("finished");
          clearTimeout(timer);
          requestInput.signal?.removeEventListener("abort", callerAbort);
        }
      },
      catch: (error) =>
        error instanceof IpfsPinningRequestInvalid
          ? error
          : new IpfsPinningRequestInvalid({ reason: "invalid_transport" }),
    });
  };
  return { pin };
}
