import type {
  MediaIdentificationOutcome,
  MediaIdentificationProviderService,
  MediaIdentificationRequest,
} from "@pirate/application/media-identification-provider";
import { Cause, Data, Effect, Option, Predicate, Schema } from "effect";

export const ACRCLOUD_PROVIDER_ID = "acrcloud" as const;
export const ACRCLOUD_IDENTIFY_PATH = "/v1/identify" as const;
export const ACRCLOUD_SIGNATURE_VERSION = "1" as const;
export const ACRCLOUD_DATA_TYPE = "audio" as const;
export const ACRCLOUD_MULTIPART_BOUNDARY = "----pirate-acrcloud-v1" as const;

/** A normalized 10–15 second sample must remain comfortably below vendor limits. */
export const ACRCLOUD_MAX_SAMPLE_BYTES = 15 * 1024 * 1024;
export const ACRCLOUD_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const ACRCLOUD_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
export const ACRCLOUD_MAX_JSON_DEPTH = 10;
export const ACRCLOUD_MAX_JSON_PROPERTIES = 256;
export const ACRCLOUD_MAX_JSON_ARRAY_ITEMS = 64;
export const ACRCLOUD_DEFAULT_TIMEOUT_MS = 30_000;

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

export type AcrCloudTransportResult =
  | Effect.Effect<AcrCloudTransportResponse, AcrCloudTransportFailure>
  | PromiseLike<AcrCloudTransportResponse>;

export type AcrCloudTransport = Readonly<{
  readonly request: (request: AcrCloudTransportRequest) => AcrCloudTransportResult;
}>;

export type AcrCloudAdapterOptions = Readonly<{
  readonly host: string;
  readonly credentials: AcrCloudCredentials;
  readonly transport: AcrCloudTransport;
  readonly clock: AcrCloudClock | (() => number);
  readonly path?: string;
  readonly timeoutMs?: number;
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

function malformed(
  reason:
    | "wrong_content_type"
    | "response_too_large"
    | "malformed_json"
    | "unsupported_shape"
    | "duplicate_candidates",
): MediaIdentificationOutcome {
  return { outcome: "malformed_or_unsupported_response", reason };
}

function retryable(
  reason: "transport" | "provider" | "timeout" | "cancelled" | "throttled",
): MediaIdentificationOutcome {
  return { outcome: "retryable_failure", reason };
}

function permanent(
  reason: "provider_rejected" | "sample_too_large" | "unsupported_sample" | "unauthorized",
): MediaIdentificationOutcome {
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

function safeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes('"')
  ) {
    throw new Error("invalid filename");
  }
  return trimmed;
}

function safeContentType(contentType: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/u.test(normalized)) {
    throw new Error("unsupported sample content type");
  }
  return normalized;
}

function safeMultipartValue(value: string): string {
  if (value.length > 512 || value.includes("\r") || value.includes("\n")) {
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
  const value = path?.trim() || ACRCLOUD_IDENTIFY_PATH;
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
  const value = host
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "");
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("invalid provider host");
  }
  return value;
}

function clockSeconds(clock: AcrCloudAdapterOptions["clock"]): number {
  const raw = typeof clock === "function" ? clock() : clock.nowSeconds();
  // Accept the repository's millisecond Clock shape as well as the explicit
  // nowSeconds shape, while always signing the integer Unix-second value.
  const seconds = raw >= 10_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("invalid clock value");
  return seconds;
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
  if (depth > ACRCLOUD_MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) {
    if (value.length > ACRCLOUD_MAX_JSON_ARRAY_ITEMS) return false;
    for (const item of value) {
      if (!isBoundedJson(item, depth + 1, properties)) return false;
    }
    return true;
  }
  if (!Predicate.isObject(value)) return true;
  const keys = Object.keys(value);
  properties.count += keys.length;
  if (properties.count > ACRCLOUD_MAX_JSON_PROPERTIES) return false;
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

function parseProviderResponse(body: Uint8Array): MediaIdentificationOutcome {
  if (body.byteLength > ACRCLOUD_MAX_RESPONSE_BYTES) {
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

function transportFailureReason(error: unknown): MediaIdentificationOutcome {
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

function responseOutcome(response: AcrCloudTransportResponse): MediaIdentificationOutcome {
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
  return parseProviderResponse(response.body);
}

/**
 * Isolated ACRCloud adapter.  Credentials are captured only by this private
 * adapter closure; they are never put in a request outcome, diagnostics, or
 * provider evidence.  All network behavior is supplied by the transport.
 */
export function makeAcrCloudAdapter(
  options: AcrCloudAdapterOptions,
): MediaIdentificationProviderService {
  return {
    identify: (input: MediaIdentificationRequest): Effect.Effect<MediaIdentificationOutcome> => {
      if (input.version !== "media-identification-request-v1") {
        return Effect.succeed(permanent("unsupported_sample"));
      }
      if (
        input.sample.bytes.byteLength === 0 ||
        input.sample.bytes.byteLength > ACRCLOUD_MAX_SAMPLE_BYTES
      ) {
        return Effect.succeed(
          input.sample.bytes.byteLength > ACRCLOUD_MAX_SAMPLE_BYTES
            ? permanent("sample_too_large")
            : permanent("unsupported_sample"),
        );
      }
      let host: string;
      let path: string;
      try {
        host = normalizedHost(options.host);
        path = normalizedPath(options.path);
        safeFilename(input.sample.filename);
        safeContentType(input.sample.contentType);
      } catch {
        return Effect.succeed(permanent("unsupported_sample"));
      }
      const sample = asBytes(input.sample.bytes);
      const timeoutMs = options.timeoutMs ?? ACRCLOUD_DEFAULT_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
        return Effect.succeed(retryable("transport"));
      }
      const externalSignal = input.signal;
      if (externalSignal?.aborted) return Effect.succeed(retryable("cancelled"));

      const controller = new AbortController();
      const abortFromExternal = () => controller.abort();
      externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
      const requestEffect = Effect.gen(function* () {
        const timestamp = String(clockSeconds(options.clock));
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
        const multipart = encodeAcrCloudMultipart({
          accessKey: options.credentials.accessKey,
          timestamp,
          signature,
          filename: input.sample.filename,
          contentType: input.sample.contentType,
          sampleBytes: sample,
        });
        if (multipart.body.byteLength > ACRCLOUD_MAX_REQUEST_BYTES) {
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
        return responseOutcome(response);
      }).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            controller.abort();
            externalSignal?.removeEventListener("abort", abortFromExternal);
          }),
        ),
        Effect.timeout(timeoutMs),
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
          onFailure: (error) =>
            Effect.succeed(
              Cause.isTimeoutError(error) ? retryable("timeout") : transportFailureReason(error),
            ),
          onSuccess: (outcome) => Effect.succeed(outcome),
        }),
        Effect.catchDefect(() => Effect.succeed(retryable("transport"))),
      );
    },
  };
}

export const makeAcrCloudIdentificationProvider = makeAcrCloudAdapter;
