import type { MediaIdentificationInvalidReason } from "@pirate/application/media-identification-provider";
import { Data, type Effect, Predicate } from "effect";

export const ACRCLOUD_PROVIDER_ID = "acrcloud" as const;
export const ACRCLOUD_IDENTIFY_PATH = "/v1/identify" as const;
export const ACRCLOUD_SIGNATURE_VERSION = "1" as const;
export const ACRCLOUD_DATA_TYPE = "audio" as const;
export const ACRCLOUD_MULTIPART_BOUNDARY = "----pirate-acrcloud-v1" as const;

/**
 * Protocol/runtime safety caps only. ACRCloud's sample_bytes field is
 * documented below 5 MB; this adapter keeps a 4 MB internal ceiling so the
 * stream, multipart body, and request snapshot stay well below isolate memory
 * limits. Product/provider limits are still injected separately.
 */
const ACRCLOUD_INTERNAL_MAX_SAMPLE_BYTES = 4_000_000;
export const ACRCLOUD_INTERNAL_MAX_REQUEST_BYTES = 4_100_000;
const ACRCLOUD_INTERNAL_MAX_RESPONSE_BYTES = 1_048_576;
export const ACRCLOUD_INTERNAL_MAX_TIMEOUT_MS = 120_000;
const ACRCLOUD_INTERNAL_MAX_ID_BYTES = 128;
const ACRCLOUD_INTERNAL_MAX_ADAPTER_REVISION_BYTES = 64;
const ACRCLOUD_INTERNAL_MAX_FILENAME_BYTES = 128;
const ACRCLOUD_INTERNAL_MAX_CONTENT_TYPE_BYTES = 128;
export const ACRCLOUD_INTERNAL_MAX_JSON_DEPTH = 10;
export const ACRCLOUD_INTERNAL_MAX_JSON_PROPERTIES = 256;
export const ACRCLOUD_INTERNAL_MAX_JSON_ARRAY_ITEMS = 64;

const textEncoder = new TextEncoder();
const ACRCLOUD_REGIONAL_HOSTS = new Set([
  "identify-eu-west-1.acrcloud.com",
  "identify-us-west-2.acrcloud.com",
  "identify-ap-southeast-1.acrcloud.com",
]);

export type AcrCloudClock = Readonly<{
  /** Unix timestamp in seconds. */
  readonly nowSeconds: () => number;
}>;

export type AcrCloudCredentials = Readonly<{
  readonly accessKey: string;
  readonly accessSecret: string;
}>;

export type AcrCloudTransportRequest = Readonly<{
  readonly requestId: string;
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
  /** Credential-bearing requests must never follow a redirect. */
  readonly redirect: "error";
}>;

export type AcrCloudTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Headers | Readonly<Record<string, string>>;
  /** Transport must expose a stream so the adapter can enforce the byte bound while reading. */
  readonly body: ReadableStream<Uint8Array>;
}>;

export class AcrCloudTransportFailure extends Data.TaggedError("AcrCloudTransportFailure")<{
  readonly reason: "network" | "aborted" | "timeout";
}> {}

export class AcrCloudMultipartBoundaryCollision extends Data.TaggedError(
  "AcrCloudMultipartBoundaryCollision",
)<Record<never, never>> {}

export class AcrCloudResponseStreamFailure extends Data.TaggedError(
  "AcrCloudResponseStreamFailure",
)<Record<never, never>> {}

export class AcrCloudResponseReadAborted extends Data.TaggedError("AcrCloudResponseReadAborted")<
  Record<never, never>
> {}

export class AcrCloudResponseBodyTooLarge extends Data.TaggedError("AcrCloudResponseBodyTooLarge")<
  Record<never, never>
> {}

export type AcrCloudTransportResult =
  | Effect.Effect<AcrCloudTransportResponse, AcrCloudTransportFailure>
  | PromiseLike<AcrCloudTransportResponse>;

export type AcrCloudTransport = Readonly<{
  readonly request: (request: AcrCloudTransportRequest) => AcrCloudTransportResult;
}>;

/** Product/provider policy, supplied by the enabled composition. */
export type AcrCloudAcceptedLimits = Readonly<{
  readonly maxSampleBytes: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}>;

export type AcrCloudAdapterOptions = Readonly<{
  readonly host: string;
  readonly credentials: AcrCloudCredentials;
  readonly transport: AcrCloudTransport;
  readonly clock: AcrCloudClock | (() => number);
  readonly adapterRevision: string;
  readonly limits: AcrCloudAcceptedLimits;
  /** Kept only for runtime rejection of stale compositions; the path is always exact. */
  readonly path?: string;
}>;

export type AcrCloudMultipartInput = Readonly<{
  readonly accessKey: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sampleBytes: Uint8Array;
}>;

export type AcrCloudMultipart = Readonly<{
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly sampleBytes: number;
}>;

export type AcrCloudConfigSnapshot = Readonly<{
  readonly host: string;
  readonly path: typeof ACRCLOUD_IDENTIFY_PATH;
  readonly credentials: AcrCloudCredentials;
  readonly request: AcrCloudTransport["request"];
  readonly nowSeconds: () => number;
  readonly adapterRevision: string;
  readonly limits: AcrCloudAcceptedLimits;
}>;

export type AcrCloudRequestSnapshot = Readonly<{
  readonly version: "media-identification-request-v1";
  readonly operationId: string;
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly canonicalAudioSha256: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
  readonly sample: Readonly<{
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  }>;
}>;

type ConfigurationFailure =
  | "invalid_adapter_revision"
  | "invalid_limits"
  | "invalid_provider_endpoint"
  | "invalid_credentials"
  | "invalid_transport"
  | "invalid_clock";

export type AcrCloudConfigurationResult =
  | Readonly<{ readonly ok: true; readonly value: AcrCloudConfigSnapshot }>
  | Readonly<{ readonly ok: false; readonly reason: ConfigurationFailure }>;

export type AcrCloudRequestResult =
  | Readonly<{ readonly ok: true; readonly value: AcrCloudRequestSnapshot }>
  | Readonly<{
      readonly ok: false;
      readonly reason: Exclude<MediaIdentificationInvalidReason, ConfigurationFailure>;
    }>;

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > maxBytes) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function boundedIdentifier(value: unknown, maxBytes: number): value is string {
  return boundedText(value, maxBytes) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isAcceptedLimit(value: unknown, hardCap: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= hardCap;
}

function validLimits(value: unknown): value is AcrCloudAcceptedLimits {
  if (!Predicate.isObject(value)) return false;
  const limits = value as Record<string, unknown>;
  return (
    isAcceptedLimit(limits.maxSampleBytes, ACRCLOUD_INTERNAL_MAX_SAMPLE_BYTES) &&
    isAcceptedLimit(limits.maxRequestBytes, ACRCLOUD_INTERNAL_MAX_REQUEST_BYTES) &&
    isAcceptedLimit(limits.maxResponseBytes, ACRCLOUD_INTERNAL_MAX_RESPONSE_BYTES) &&
    isAcceptedLimit(limits.timeoutMs, ACRCLOUD_INTERNAL_MAX_TIMEOUT_MS)
  );
}

function safeFilename(filename: unknown): string | null {
  if (typeof filename !== "string") return null;
  const trimmed = filename.trim();
  if (
    trimmed.length === 0 ||
    utf8Length(trimmed) > ACRCLOUD_INTERNAL_MAX_FILENAME_BYTES ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes('"')
  ) {
    return null;
  }
  return trimmed;
}

function safeContentType(contentType: unknown): string | null {
  if (typeof contentType !== "string") return null;
  const normalized = contentType.trim().toLowerCase();
  if (
    utf8Length(normalized) > ACRCLOUD_INTERNAL_MAX_CONTENT_TYPE_BYTES ||
    !/^audio\/[a-z0-9.+-]+$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeAcrCloudHost(host: unknown): string | null {
  if (typeof host !== "string" || host.trim().length === 0) return null;
  const value = host.trim();
  if (value.includes("\\") || value.includes("?") || value.includes("#")) return null;
  const authorityInput = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u, "");
  if (authorityInput.includes("/")) return null;
  const authority = authorityInput.split(/[/?#]/u, 1)[0];
  if (authority?.includes(":")) return null;
  const parsed = (() => {
    try {
      return new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      return null;
    }
  })();
  if (parsed === null) return null;
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !ACRCLOUD_REGIONAL_HOSTS.has(parsed.hostname)
  ) {
    return null;
  }
  return parsed.hostname;
}

function clockFunction(clock: AcrCloudAdapterOptions["clock"]): (() => number) | null {
  if (typeof clock === "function") return clock;
  if (!Predicate.isObject(clock) || typeof clock.nowSeconds !== "function") return null;
  return clock.nowSeconds;
}

export function clockSeconds(nowSeconds: () => number): number {
  const raw = nowSeconds();
  const seconds = raw >= 10_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("invalid clock value");
  return seconds;
}

export function snapshotAcrCloudOptions(
  options: AcrCloudAdapterOptions,
): AcrCloudConfigurationResult {
  const adapterRevision = options.adapterRevision;
  const rawLimits = options.limits;
  const rawCredentials = options.credentials;
  const rawTransport = options.transport;
  const rawHost = options.host;
  const rawPath = options.path;
  const rawClock = options.clock;
  if (!boundedIdentifier(adapterRevision, ACRCLOUD_INTERNAL_MAX_ADAPTER_REVISION_BYTES)) {
    return { ok: false, reason: "invalid_adapter_revision" };
  }
  if (!validLimits(rawLimits)) return { ok: false, reason: "invalid_limits" };
  if (!boundedText(rawCredentials?.accessKey, 512)) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (!boundedText(rawCredentials?.accessSecret, 512)) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (!Predicate.isObject(rawTransport) || typeof rawTransport.request !== "function") {
    return { ok: false, reason: "invalid_transport" };
  }
  const host = normalizeAcrCloudHost(rawHost);
  if (host === null || (rawPath !== undefined && rawPath.trim() !== ACRCLOUD_IDENTIFY_PATH)) {
    return { ok: false, reason: "invalid_provider_endpoint" };
  }
  const nowSeconds = clockFunction(rawClock);
  if (nowSeconds === null) return { ok: false, reason: "invalid_clock" };
  const credentials = Object.freeze({
    accessKey: rawCredentials.accessKey,
    accessSecret: rawCredentials.accessSecret,
  });
  const limits = Object.freeze({
    maxSampleBytes: rawLimits.maxSampleBytes,
    maxRequestBytes: rawLimits.maxRequestBytes,
    maxResponseBytes: rawLimits.maxResponseBytes,
    timeoutMs: rawLimits.timeoutMs,
  });
  return {
    ok: true,
    value: Object.freeze({
      host,
      path: ACRCLOUD_IDENTIFY_PATH,
      credentials,
      request: rawTransport.request,
      nowSeconds,
      adapterRevision,
      limits,
    }),
  };
}

export function snapshotAcrCloudRequest(
  input: unknown,
  limits: AcrCloudAcceptedLimits,
): AcrCloudRequestResult {
  if (!Predicate.isObject(input)) return { ok: false, reason: "invalid_sample" };
  const request = input as Record<string, unknown>;
  if (request.version !== "media-identification-request-v1") {
    return { ok: false, reason: "invalid_request_version" };
  }
  if (!boundedIdentifier(request.operationId, ACRCLOUD_INTERNAL_MAX_ID_BYTES)) {
    return { ok: false, reason: "invalid_operation_id" };
  }
  if (!boundedIdentifier(request.requestId, ACRCLOUD_INTERNAL_MAX_ID_BYTES)) {
    return { ok: false, reason: "invalid_request_id" };
  }
  if (
    typeof request.audioRevision !== "number" ||
    !Number.isSafeInteger(request.audioRevision) ||
    request.audioRevision <= 0
  ) {
    return { ok: false, reason: "invalid_audio_revision" };
  }
  if (
    typeof request.analysisRevision !== "number" ||
    !Number.isSafeInteger(request.analysisRevision) ||
    request.analysisRevision <= 0
  ) {
    return { ok: false, reason: "invalid_analysis_revision" };
  }
  if (
    typeof request.canonicalAudioSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(request.canonicalAudioSha256)
  ) {
    return { ok: false, reason: "invalid_audio_hash" };
  }
  if (!Predicate.isObject(request.sample)) return { ok: false, reason: "invalid_sample" };
  const sample = request.sample as Record<string, unknown>;
  if (!(sample.bytes instanceof Uint8Array) || sample.bytes.byteLength === 0) {
    return { ok: false, reason: "invalid_sample" };
  }
  if (sample.bytes.byteLength > limits.maxSampleBytes)
    return { ok: false, reason: "invalid_sample" };
  const filename = safeFilename(sample.filename);
  if (filename === null) return { ok: false, reason: "invalid_filename" };
  const contentType = safeContentType(sample.contentType);
  if (contentType === null) return { ok: false, reason: "invalid_content_type" };
  const signal = request.signal;
  if (
    signal !== undefined &&
    (!Predicate.isObject(signal) ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    return { ok: false, reason: "invalid_signal" };
  }
  const snapshot = {
    version: "media-identification-request-v1" as const,
    operationId: request.operationId,
    audioRevision: request.audioRevision,
    analysisRevision: request.analysisRevision,
    canonicalAudioSha256: request.canonicalAudioSha256,
    requestId: request.requestId,
    sample: Object.freeze({
      // One private snapshot copy; the multipart builder does not copy it again.
      bytes: new Uint8Array(sample.bytes),
      filename,
      contentType,
    }),
  };
  return {
    ok: true,
    value: Object.freeze(
      signal === undefined ? snapshot : { ...snapshot, signal: signal as unknown as AbortSignal },
    ),
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

function safeMultipartValue(value: string): string | null {
  if (utf8Length(value) > 512 || value.includes("\r") || value.includes("\n")) return null;
  return value;
}

function multipartField(name: string, value: string): Uint8Array {
  return textEncoder.encode(
    `--${ACRCLOUD_MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Deterministic ACRCloud HMAC-SHA1 signature, base64 encoded. */
export async function buildAcrCloudSignature(
  secret: string,
  stringToSign: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(stringToSign)),
  );
  let binary = "";
  for (const byte of signed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds the provider form body without FormData. The fixed boundary and
 * field order make the bytes deterministic under fixtures.
 */
export function encodeAcrCloudMultipart(input: AcrCloudMultipartInput): AcrCloudMultipart {
  const filename = safeFilename(input.filename);
  const contentType = safeContentType(input.contentType);
  const safeAccessKey = safeMultipartValue(input.accessKey);
  const safeTimestamp = safeMultipartValue(input.timestamp);
  const safeSignature = safeMultipartValue(input.signature);
  if (
    filename === null ||
    contentType === null ||
    safeAccessKey === null ||
    safeTimestamp === null ||
    safeSignature === null
  ) {
    throw new Error("invalid multipart field");
  }
  const fieldValues = [
    safeAccessKey,
    safeTimestamp,
    safeSignature,
    filename,
    contentType,
    ACRCLOUD_DATA_TYPE,
    ACRCLOUD_SIGNATURE_VERSION,
  ];
  const boundaryBytes = textEncoder.encode(ACRCLOUD_MULTIPART_BOUNDARY);
  if (
    containsBytes(input.sampleBytes, boundaryBytes) ||
    fieldValues.some((value) => containsBytes(textEncoder.encode(value), boundaryBytes))
  ) {
    throw new AcrCloudMultipartBoundaryCollision();
  }
  const fields = [
    multipartField("access_key", safeAccessKey),
    multipartField("sample_bytes", String(input.sampleBytes.byteLength)),
    multipartField("timestamp", safeTimestamp),
    multipartField("signature", safeSignature),
    multipartField("data_type", ACRCLOUD_DATA_TYPE),
    multipartField("signature_version", ACRCLOUD_SIGNATURE_VERSION),
  ];
  const fileHeader = textEncoder.encode(
    `--${ACRCLOUD_MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="sample"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const body = concatBytes([
    ...fields,
    fileHeader,
    input.sampleBytes,
    textEncoder.encode(`\r\n--${ACRCLOUD_MULTIPART_BOUNDARY}--\r\n`),
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${ACRCLOUD_MULTIPART_BOUNDARY}`,
    sampleBytes: input.sampleBytes.byteLength,
  };
}

export function endpointForAcrCloud(host: string): string {
  return `https://${host}${ACRCLOUD_IDENTIFY_PATH}`;
}
