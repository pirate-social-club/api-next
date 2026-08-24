import type {
  MediaIdentificationAttemptContext,
  MediaIdentificationOutcome,
  MediaIdentificationOutcomeKind,
  MediaIdentificationProviderService,
  MediaIdentificationRequest,
} from "@pirate/application/media-identification-provider";
import { MediaIdentificationRequestInvalid } from "@pirate/application/media-identification-provider";
import { Cause, Data, Effect, Option, Predicate, Schema } from "effect";

export const ACRCLOUD_PROVIDER_ID = "acrcloud" as const;
export const ACRCLOUD_IDENTIFY_PATH = "/v1/identify" as const;
export const ACRCLOUD_SIGNATURE_VERSION = "1" as const;
export const ACRCLOUD_DATA_TYPE = "audio" as const;
export const ACRCLOUD_MULTIPART_BOUNDARY = "----pirate-acrcloud-v1" as const;

/**
 * Immutable implementation hard caps. These are memory-safety ceilings only;
 * they are not ACRCloud or product policy. Accepted limits must be injected
 * by the enabled composition and remain at or below these caps.
 */
export const ACRCLOUD_INTERNAL_MAX_SAMPLE_BYTES = 32 * 1024 * 1024;
export const ACRCLOUD_INTERNAL_MAX_REQUEST_BYTES = 33 * 1024 * 1024;
export const ACRCLOUD_INTERNAL_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const ACRCLOUD_INTERNAL_MAX_TIMEOUT_MS = 120_000;
export const ACRCLOUD_INTERNAL_MAX_ID_BYTES = 128;
export const ACRCLOUD_INTERNAL_MAX_ADAPTER_REVISION_BYTES = 64;
export const ACRCLOUD_INTERNAL_MAX_FILENAME_BYTES = 128;
export const ACRCLOUD_INTERNAL_MAX_CONTENT_TYPE_BYTES = 128;
export const ACRCLOUD_INTERNAL_MAX_JSON_DEPTH = 10;
export const ACRCLOUD_INTERNAL_MAX_JSON_PROPERTIES = 256;
export const ACRCLOUD_INTERNAL_MAX_JSON_ARRAY_ITEMS = 64;

const EXACT_PARSE_OPTIONS = { onExcessProperty: "ignore" } as const;
const textEncoder = new TextEncoder();

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
}>;

export type AcrCloudTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Headers | Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}>;

export class AcrCloudTransportFailure extends Data.TaggedError("AcrCloudTransportFailure")<{
  readonly reason: "network" | "aborted" | "timeout";
}> {}

export class AcrCloudMultipartBoundaryCollision extends Data.TaggedError(
  "AcrCloudMultipartBoundaryCollision",
)<Record<never, never>> {}

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

const ProviderResponse = Schema.Struct({
  status: Schema.Struct({
    code: Schema.Number,
  }),
  metadata: Schema.optional(
    Schema.Struct({
      music: Schema.optional(Schema.Array(Schema.Unknown)),
      custom_files: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
});

type ProviderResponseValue = Schema.Schema.Type<typeof ProviderResponse>;

type Candidate = Readonly<{
  readonly id: string;
  readonly title: string | null;
  readonly artists: readonly string[];
  readonly score: number | null;
  readonly kind: "music" | "custom";
  readonly excludedVideoAudio: boolean;
}>;

type AcrCloudOutcomeKind = MediaIdentificationOutcomeKind;

function malformed(
  reason:
    | "wrong_content_type"
    | "response_too_large"
    | "malformed_json"
    | "unsupported_shape"
    | "duplicate_candidates",
): AcrCloudOutcomeKind {
  return { outcome: "malformed_or_unsupported_response", reason };
}

function retryable(
  reason: "transport" | "provider" | "timeout" | "cancelled" | "throttled",
): AcrCloudOutcomeKind {
  return { outcome: "retryable_failure", reason };
}

function permanent(
  reason: "provider_rejected" | "sample_too_large" | "unsupported_sample" | "unauthorized",
): AcrCloudOutcomeKind {
  return { outcome: "permanent_provider_rejection", reason };
}

function asBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function multipartField(name: string, value: string): Uint8Array {
  return textEncoder.encode(
    `--${ACRCLOUD_MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
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

function safeFilename(filename: string): string {
  if (typeof filename !== "string") throw new Error("invalid filename");
  const trimmed = filename.trim();
  if (
    trimmed.length === 0 ||
    utf8Length(trimmed) > ACRCLOUD_INTERNAL_MAX_FILENAME_BYTES ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes('"')
  ) {
    throw new Error("invalid filename");
  }
  return trimmed;
}

function safeContentType(contentType: string): string {
  if (typeof contentType !== "string") throw new Error("unsupported sample content type");
  const normalized = contentType.trim().toLowerCase();
  if (
    utf8Length(normalized) > ACRCLOUD_INTERNAL_MAX_CONTENT_TYPE_BYTES ||
    !/^audio\/[a-z0-9.+-]+$/u.test(normalized)
  ) {
    throw new Error("unsupported sample content type");
  }
  return normalized;
}

function safeMultipartValue(value: string): string {
  if (utf8Length(value) > 512 || value.includes("\r") || value.includes("\n")) {
    throw new Error("invalid multipart field");
  }
  return value;
}

/**
 * Builds the provider form body without FormData.  The fixed boundary and
 * fixed field order make the bytes deterministic under fixtures.
 */
export function encodeAcrCloudMultipart(input: AcrCloudMultipartInput): AcrCloudMultipart {
  const sampleBytes = asBytes(input.sampleBytes);
  const filename = safeFilename(input.filename);
  const contentType = safeContentType(input.contentType);
  const fieldValues = [
    input.accessKey,
    input.timestamp,
    input.signature,
    filename,
    contentType,
    ACRCLOUD_DATA_TYPE,
    ACRCLOUD_SIGNATURE_VERSION,
  ];
  const boundaryBytes = textEncoder.encode(ACRCLOUD_MULTIPART_BOUNDARY);
  if (
    containsBytes(sampleBytes, boundaryBytes) ||
    fieldValues.some((value) => containsBytes(textEncoder.encode(value), boundaryBytes))
  ) {
    throw new AcrCloudMultipartBoundaryCollision();
  }
  const fields = [
    multipartField("access_key", safeMultipartValue(input.accessKey)),
    multipartField("sample_bytes", String(sampleBytes.byteLength)),
    multipartField("timestamp", safeMultipartValue(input.timestamp)),
    multipartField("signature", safeMultipartValue(input.signature)),
    multipartField("data_type", ACRCLOUD_DATA_TYPE),
    multipartField("signature_version", ACRCLOUD_SIGNATURE_VERSION),
  ];
  const fileHeader = textEncoder.encode(
    `--${ACRCLOUD_MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="sample"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const body = concatBytes([
    ...fields,
    fileHeader,
    sampleBytes,
    textEncoder.encode(`\r\n--${ACRCLOUD_MULTIPART_BOUNDARY}--\r\n`),
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${ACRCLOUD_MULTIPART_BOUNDARY}`,
    sampleBytes: sampleBytes.byteLength,
  };
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

export const acrCloudSignature = buildAcrCloudSignature;

function normalizedPath(path: string | undefined): string {
  const value = path === undefined ? ACRCLOUD_IDENTIFY_PATH : path.trim();
  if (
    value.length === 0 ||
    value.length > 256 ||
    !value.startsWith("/") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("invalid identify path");
  }
  return value;
}

function normalizedHost(host: string): string {
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new Error("invalid provider host");
  }
  const value = host.trim();
  if (value.includes("\\") || value.includes("?") || value.includes("#")) {
    throw new Error("invalid provider host delimiters");
  }
  const authority = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u, "").split(/[/?#]/u, 1)[0] ?? "";
  if (authority.includes(":")) throw new Error("provider ports are not allowed");
  const parsed = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.hostname.length === 0 ||
    parsed.hostname.length > 253 ||
    /[\s\\\r\n]/u.test(parsed.hostname)
  ) {
    throw new Error("invalid provider host");
  }
  return parsed.hostname;
}

function clockSeconds(clock: AcrCloudAdapterOptions["clock"]): number {
  const raw = typeof clock === "function" ? clock() : clock.nowSeconds();
  // Accept the repository's millisecond Clock shape as well as the explicit
  // nowSeconds shape, while always signing the integer Unix-second value.
  const seconds = raw >= 10_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("invalid clock value");
  return seconds;
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

function isAcceptedLimit(value: unknown, hardCap: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= hardCap;
}

function validateOptions(
  options: AcrCloudAdapterOptions,
):
  | "invalid_adapter_revision"
  | "invalid_limits"
  | "invalid_provider_endpoint"
  | "invalid_credentials"
  | "invalid_transport"
  | null {
  if (!boundedIdentifier(options.adapterRevision, ACRCLOUD_INTERNAL_MAX_ADAPTER_REVISION_BYTES)) {
    return "invalid_adapter_revision";
  }
  if (!validLimits(options.limits)) return "invalid_limits";
  if (!boundedText(options.credentials?.accessKey, 512)) return "invalid_credentials";
  if (!boundedText(options.credentials?.accessSecret, 512)) return "invalid_credentials";
  if (!Predicate.isObject(options.transport) || typeof options.transport.request !== "function") {
    return "invalid_transport";
  }
  try {
    normalizedHost(options.host);
    normalizedPath(options.path);
  } catch {
    return "invalid_provider_endpoint";
  }
  return null;
}

function validateInput(
  input: unknown,
  limits: AcrCloudAcceptedLimits,
):
  | "invalid_request_version"
  | "invalid_operation_id"
  | "invalid_request_id"
  | "invalid_audio_revision"
  | "invalid_analysis_revision"
  | "invalid_audio_hash"
  | "invalid_sample"
  | "invalid_filename"
  | "invalid_content_type"
  | null {
  if (!Predicate.isObject(input)) return "invalid_sample";
  const request = input as Record<string, unknown>;
  if (request.version !== "media-identification-request-v1") return "invalid_request_version";
  if (!boundedIdentifier(request.operationId, ACRCLOUD_INTERNAL_MAX_ID_BYTES)) {
    return "invalid_operation_id";
  }
  if (!boundedIdentifier(request.requestId, ACRCLOUD_INTERNAL_MAX_ID_BYTES)) {
    return "invalid_request_id";
  }
  if (
    typeof request.audioRevision !== "number" ||
    !Number.isSafeInteger(request.audioRevision) ||
    request.audioRevision <= 0
  ) {
    return "invalid_audio_revision";
  }
  if (
    typeof request.analysisRevision !== "number" ||
    !Number.isSafeInteger(request.analysisRevision) ||
    request.analysisRevision <= 0
  ) {
    return "invalid_analysis_revision";
  }
  if (
    typeof request.canonicalAudioSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(request.canonicalAudioSha256)
  ) {
    return "invalid_audio_hash";
  }
  if (!Predicate.isObject(request.sample)) return "invalid_sample";
  const sample = request.sample as Record<string, unknown>;
  if (!(sample.bytes instanceof Uint8Array) || sample.bytes.byteLength === 0) {
    return "invalid_sample";
  }
  if (sample.bytes.byteLength > limits.maxSampleBytes) return "invalid_sample";
  try {
    safeFilename(sample.filename as string);
  } catch {
    return "invalid_filename";
  }
  try {
    safeContentType(sample.contentType as string);
  } catch {
    return "invalid_content_type";
  }
  return null;
}

function attemptContext(
  input: MediaIdentificationRequest,
  adapterRevision: string,
): MediaIdentificationAttemptContext {
  return Object.freeze({
    version: "media-identification-attempt-context-v1" as const,
    operationId: input.operationId,
    audioRevision: input.audioRevision,
    analysisRevision: input.analysisRevision,
    canonicalAudioSha256: input.canonicalAudioSha256,
    requestId: input.requestId,
    adapterRevision,
  });
}

function bindOutcome(
  context: MediaIdentificationAttemptContext,
  outcome: AcrCloudOutcomeKind,
): MediaIdentificationOutcome {
  return Object.freeze({ context, ...outcome });
}

function headerValue(
  headers: Headers | Readonly<Record<string, string>>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function isBoundedJson(value: unknown, depth = 0, properties = { count: 0 }): boolean {
  if (depth > ACRCLOUD_INTERNAL_MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) {
    if (value.length > ACRCLOUD_INTERNAL_MAX_JSON_ARRAY_ITEMS) return false;
    for (const item of value) {
      if (!isBoundedJson(item, depth + 1, properties)) return false;
    }
    return true;
  }
  if (!Predicate.isObject(value)) return true;
  const keys = Object.keys(value);
  properties.count += keys.length;
  if (properties.count > ACRCLOUD_INTERNAL_MAX_JSON_PROPERTIES) return false;
  for (const key of keys) {
    if (key.length > 128 || !isBoundedJson(value[key], depth + 1, properties)) return false;
  }
  return true;
}

function stringField(record: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") return value;
    if (value !== undefined && value !== null) return null;
  }
  return null;
}

function nullableScore(record: Record<string, unknown>): number | null | undefined {
  const value = record.score ?? record.confidence;
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
    return undefined;
  return value;
}

function candidate(value: unknown, kind: "music" | "custom"): Candidate | null {
  if (!Predicate.isObject(value)) return null;
  const record = value as Record<string, unknown>;
  const id = stringField(
    record,
    kind === "music" ? ["acrid", "acr_id", "id"] : ["acr_id", "acrid", "file_id", "id"],
  );
  if (id === null || id.length === 0 || id.length > 256) return null;
  const score = nullableScore(record);
  if (score === undefined) return null;
  const titleValue = stringField(record, ["title", "name", "file_name"]);
  if (titleValue !== null && titleValue.length > 512) return null;
  const artistsValue = record.artists;
  const artists: string[] = [];
  if (artistsValue !== undefined) {
    if (!Array.isArray(artistsValue) || artistsValue.length > 16) return null;
    for (const artist of artistsValue) {
      if (!Predicate.isObject(artist)) return null;
      const name = (artist as Record<string, unknown>).name;
      if (typeof name !== "string" || name.length === 0 || name.length > 256) return null;
      artists.push(name);
    }
  }
  const userDefined = record.user_defined;
  if (userDefined !== undefined && userDefined !== null && !Predicate.isObject(userDefined))
    return null;
  const userDefinedRecord = Predicate.isObject(userDefined)
    ? (userDefined as Record<string, unknown>)
    : record;
  const contentType = userDefinedRecord.content_type;
  if (contentType !== undefined && typeof contentType !== "string") return null;
  return {
    id,
    title: titleValue,
    artists,
    score,
    kind,
    excludedVideoAudio: contentType === "video_audio",
  };
}

function parseProviderResponse(body: Uint8Array, maxResponseBytes: number): AcrCloudOutcomeKind {
  if (body.byteLength > maxResponseBytes) {
    return malformed("response_too_large");
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    return malformed("malformed_json");
  }
  if (!isBoundedJson(document)) return malformed("unsupported_shape");
  const decoded = Schema.decodeUnknownOption(ProviderResponse, EXACT_PARSE_OPTIONS)(document);
  if (Option.isNone(decoded)) return malformed("unsupported_shape");
  const response: ProviderResponseValue = decoded.value;
  if (!Number.isInteger(response.status.code)) return malformed("unsupported_shape");
  if (response.status.code === 1001) return { outcome: "no_match" };
  if (response.status.code === 2004) return { outcome: "inconclusive_fingerprint" };
  if (response.status.code !== 0) return permanent("provider_rejected");

  const music = response.metadata?.music ?? [];
  const custom = response.metadata?.custom_files ?? [];
  const candidates: Candidate[] = [];
  for (const item of music) {
    const parsed = candidate(item, "music");
    if (parsed === null) return malformed("unsupported_shape");
    candidates.push(parsed);
  }
  for (const item of custom) {
    const parsed = candidate(item, "custom");
    if (parsed === null) return malformed("unsupported_shape");
    candidates.push(parsed);
  }
  const seen = new Set<string>();
  for (const item of candidates) {
    if (seen.has(item.id)) return malformed("duplicate_candidates");
    seen.add(item.id);
  }
  const retained = candidates.find((item) => !item.excludedVideoAudio);
  if (retained === undefined) return { outcome: "no_match" };
  return {
    outcome: "retained_reference_match",
    evidence: {
      version: "media-identification-match-evidence-v1",
      provider: ACRCLOUD_PROVIDER_ID,
      matchKind: retained.kind,
      providerMatchId: retained.id,
      title: retained.title,
      artists: retained.artists,
      score: retained.score,
    },
  };
}

function transportFailureReason(error: unknown): AcrCloudOutcomeKind {
  if (error instanceof AcrCloudTransportFailure) {
    if (error.reason === "aborted") return retryable("cancelled");
    if (error.reason === "timeout") return retryable("timeout");
  }
  return retryable("transport");
}

function endpointFor(host: string, path: string): string {
  return `https://${host}${path}`;
}

function toEffect(
  result: AcrCloudTransportResult,
): Effect.Effect<AcrCloudTransportResponse, AcrCloudTransportFailure> {
  if (Effect.isEffect(result)) return result;
  return Effect.tryPromise({
    try: () => result,
    catch: () => new AcrCloudTransportFailure({ reason: "network" }),
  });
}

function responseOutcome(
  response: AcrCloudTransportResponse,
  maxResponseBytes: number,
): AcrCloudOutcomeKind {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    return malformed("unsupported_shape");
  }
  if (response.status === 429) return retryable("throttled");
  if (response.status === 408 || response.status >= 500) return retryable("provider");
  if (response.status < 200 || response.status >= 300) {
    return response.status === 401 || response.status === 403
      ? permanent("unauthorized")
      : response.status === 413
        ? permanent("sample_too_large")
        : permanent("provider_rejected");
  }
  const contentType = headerValue(response.headers, "content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return malformed("wrong_content_type");
  return parseProviderResponse(response.body, maxResponseBytes);
}

/**
 * Isolated ACRCloud adapter.  Credentials are captured only by this private
 * adapter closure; they are never put in a request outcome, diagnostics, or
 * provider evidence.  All network behavior is supplied by the transport.
 */
export function makeAcrCloudAdapter(
  options: AcrCloudAdapterOptions,
): MediaIdentificationProviderService {
  const compositionReason = (() => {
    try {
      return validateOptions(options);
    } catch {
      return "invalid_transport" as const;
    }
  })();
  return {
    identify: (
      input: MediaIdentificationRequest,
    ): Effect.Effect<MediaIdentificationOutcome, MediaIdentificationRequestInvalid> => {
      if (compositionReason !== null) {
        return Effect.fail(new MediaIdentificationRequestInvalid({ reason: compositionReason }));
      }
      const limits = options.limits;
      const inputReason = validateInput(input, limits);
      if (inputReason !== null) {
        return Effect.fail(new MediaIdentificationRequestInvalid({ reason: inputReason }));
      }
      let host: string;
      let path: string;
      let timestamp: string;
      try {
        host = normalizedHost(options.host);
        path = normalizedPath(options.path);
      } catch {
        return Effect.fail(
          new MediaIdentificationRequestInvalid({ reason: "invalid_provider_endpoint" }),
        );
      }
      try {
        timestamp = String(clockSeconds(options.clock));
      } catch {
        return Effect.fail(new MediaIdentificationRequestInvalid({ reason: "invalid_clock" }));
      }
      const sample = asBytes(input.sample.bytes);
      const context = attemptContext(input, options.adapterRevision);
      const externalSignal = input.signal;
      if (externalSignal?.aborted)
        return Effect.succeed(bindOutcome(context, retryable("cancelled")));

      const controller = new AbortController();
      const abortFromExternal = () => controller.abort();
      externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
      const requestEffect = Effect.gen(function* () {
        const stringToSign = [
          "POST",
          path,
          options.credentials.accessKey,
          ACRCLOUD_DATA_TYPE,
          ACRCLOUD_SIGNATURE_VERSION,
          timestamp,
        ].join("\n");
        const signature = yield* Effect.tryPromise({
          try: () => buildAcrCloudSignature(options.credentials.accessSecret, stringToSign),
          catch: () => new AcrCloudTransportFailure({ reason: "network" }),
        });
        let multipart: AcrCloudMultipart;
        try {
          multipart = encodeAcrCloudMultipart({
            accessKey: options.credentials.accessKey,
            timestamp,
            signature,
            filename: input.sample.filename,
            contentType: input.sample.contentType,
            sampleBytes: sample,
          });
        } catch (error) {
          if (error instanceof AcrCloudMultipartBoundaryCollision) {
            return yield* Effect.fail(
              new MediaIdentificationRequestInvalid({ reason: "multipart_boundary_collision" }),
            );
          }
          return yield* Effect.fail(
            new MediaIdentificationRequestInvalid({ reason: "invalid_sample" }),
          );
        }
        if (multipart.body.byteLength > limits.maxRequestBytes) {
          return permanent("sample_too_large");
        }
        const response = yield* toEffect(
          options.transport.request({
            requestId: input.requestId,
            method: "POST",
            url: endpointFor(host, path),
            headers: {
              "content-type": multipart.contentType,
              "content-length": String(multipart.body.byteLength),
            },
            body: multipart.body,
            signal: controller.signal,
          }),
        );
        return responseOutcome(response, limits.maxResponseBytes);
      }).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            controller.abort();
            externalSignal?.removeEventListener("abort", abortFromExternal);
          }),
        ),
        Effect.timeout(limits.timeoutMs),
      );
      const cancellationEffect = externalSignal
        ? Effect.callback<never, AcrCloudTransportFailure>((resume) => {
            const cancel = () =>
              resume(Effect.fail(new AcrCloudTransportFailure({ reason: "aborted" })));
            externalSignal.addEventListener("abort", cancel, { once: true });
            if (externalSignal.aborted) cancel();
            return Effect.sync(() => externalSignal.removeEventListener("abort", cancel));
          })
        : Effect.never;
      return Effect.raceFirst(requestEffect, cancellationEffect).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            if (error instanceof MediaIdentificationRequestInvalid) return Effect.fail(error);
            return Effect.succeed(
              bindOutcome(
                context,
                Cause.isTimeoutError(error) ? retryable("timeout") : transportFailureReason(error),
              ),
            );
          },
          onSuccess: (outcome) => Effect.succeed(bindOutcome(context, outcome)),
        }),
        Effect.catchDefect(() => Effect.succeed(bindOutcome(context, retryable("transport")))),
      );
    },
  };
}

export const makeAcrCloudIdentificationProvider = makeAcrCloudAdapter;
