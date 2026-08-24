import type { MediaIdentificationOutcomeKind } from "@pirate/application/media-identification-provider";
import { Option, Predicate, Schema } from "effect";
import {
  ACRCLOUD_INTERNAL_MAX_JSON_ARRAY_ITEMS,
  ACRCLOUD_INTERNAL_MAX_JSON_DEPTH,
  ACRCLOUD_INTERNAL_MAX_JSON_PROPERTIES,
  AcrCloudResponseBodyTooLarge,
  AcrCloudResponseReadAborted,
  AcrCloudResponseStreamFailure,
  type AcrCloudTransportResponse,
} from "./acrcloud-protocol.ts";

const EXACT_PARSE_OPTIONS = { onExcessProperty: "ignore" } as const;

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
type AcrCloudOutcomeKind = MediaIdentificationOutcomeKind;

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
): AcrCloudOutcomeKind {
  return { outcome: "malformed_or_unsupported_response", reason };
}

function retryable(reason: "provider" | "throttled" | "transport"): AcrCloudOutcomeKind {
  return { outcome: "retryable_failure", reason };
}

function permanent(
  reason: "provider_rejected" | "sample_too_large" | "unsupported_sample" | "unauthorized",
): AcrCloudOutcomeKind {
  return { outcome: "permanent_provider_rejection", reason };
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

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, "");
}

function isToken(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function isQuotedString(value: string): boolean {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
      if (index >= value.length - 1) return false;
      const escaped = value.charCodeAt(index);
      if (escaped < 0x09 || escaped > 0x7e || escaped === 0x0a || escaped === 0x0d) {
        return false;
      }
      continue;
    }
    if (code < 0x20 || code > 0x7e || code === 0x22) return false;
  }
  return true;
}

function isJsonMediaType(value: string): boolean {
  const parts = value.split(";");
  if (trimOws(parts[0] ?? "").toLowerCase() !== "application/json") return false;
  for (const rawParameter of parts.slice(1)) {
    const parameter = trimOws(rawParameter);
    const equals = parameter.indexOf("=");
    if (equals <= 0) return false;
    const name = trimOws(parameter.slice(0, equals));
    const parameterValue = trimOws(parameter.slice(equals + 1));
    if (!isToken(name) || (!isToken(parameterValue) && !isQuotedString(parameterValue))) {
      return false;
    }
  }
  return true;
}

function releaseReaderLock(reader: ReturnType<ReadableStream<Uint8Array>["getReader"]>): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending read can briefly retain the lock; the cancellation callback retries below.
    queueMicrotask(() => {
      try {
        reader.releaseLock();
      } catch {
        // The transport owns any still-pending native read.
      }
    });
  }
}

function cancelAndReleaseReader(reader: ReturnType<ReadableStream<Uint8Array>["getReader"]>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => {
      // Cancellation is cleanup and must not replace the classified failure.
    });
  } catch {
    // A malformed reader cannot change the already-determined outcome.
  }
  releaseReaderLock(reader);
}

function disposeAcrCloudBody(body: ReadableStream<Uint8Array>): void {
  try {
    const reader = body.getReader();
    cancelAndReleaseReader(reader);
  } catch {
    // A malformed transport body cannot change the already-determined outcome.
  }
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return undefined;
  }
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
  if (userDefined !== undefined && userDefined !== null && !Predicate.isObject(userDefined)) {
    return null;
  }
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

function parseProviderResponse(body: Uint8Array): AcrCloudOutcomeKind {
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

  switch (response.status.code) {
    case 0:
      break;
    case 1001:
      return { outcome: "no_match" };
    case 2004:
      return { outcome: "inconclusive_fingerprint" };
    case 3003:
    case 3015:
      return retryable("throttled");
    case 3000:
    case 3010:
      return retryable("provider");
    case 3001:
    case 3014:
      return permanent("unauthorized");
    default:
      return retryable("provider");
  }

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
      provider: "acrcloud",
      matchKind: retained.kind,
      providerMatchId: retained.id,
      title: retained.title,
      artists: retained.artists,
      score: retained.score,
    },
  };
}

export async function readBoundedAcrCloudBody(
  stream: ReadableStream<Uint8Array>,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  const readNext = async () => {
    if (signal === undefined) return reader.read();
    if (signal.aborted) {
      cancelAndReleaseReader(reader);
      throw new AcrCloudResponseReadAborted();
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        cancelAndReleaseReader(reader);
        reject(new AcrCloudResponseReadAborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };
  try {
    while (true) {
      const next = await readNext();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new AcrCloudResponseStreamFailure();
      if (next.value.byteLength > maxResponseBytes - total) {
        throw new AcrCloudResponseBodyTooLarge();
      }
      total += next.value.byteLength;
      parts.push(next.value);
    }
  } catch (error) {
    if (error instanceof AcrCloudResponseReadAborted) {
      cancelAndReleaseReader(reader);
      throw error;
    }
    cancelAndReleaseReader(reader);
    if (error instanceof AcrCloudResponseBodyTooLarge) throw error;
    if (error instanceof AcrCloudResponseStreamFailure) throw error;
    throw new AcrCloudResponseStreamFailure();
  } finally {
    releaseReaderLock(reader);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

export async function acrCloudResponseOutcome(
  response: AcrCloudTransportResponse,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<AcrCloudOutcomeKind> {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    disposeAcrCloudBody(response.body);
    return malformed("unsupported_shape");
  }
  if (response.status === 429) {
    disposeAcrCloudBody(response.body);
    return retryable("throttled");
  }
  if (response.status === 408 || response.status >= 500) {
    disposeAcrCloudBody(response.body);
    return retryable("provider");
  }
  if (response.status < 200 || response.status >= 300) {
    disposeAcrCloudBody(response.body);
    return response.status === 401 || response.status === 403
      ? permanent("unauthorized")
      : response.status === 413
        ? permanent("sample_too_large")
        : permanent("provider_rejected");
  }
  const contentType = headerValue(response.headers, "content-type") ?? "";
  if (!isJsonMediaType(contentType)) {
    disposeAcrCloudBody(response.body);
    return malformed("wrong_content_type");
  }
  try {
    return parseProviderResponse(
      await readBoundedAcrCloudBody(response.body, maxResponseBytes, signal),
    );
  } catch (error) {
    if (error instanceof AcrCloudResponseReadAborted) throw error;
    return error instanceof AcrCloudResponseBodyTooLarge
      ? malformed("response_too_large")
      : retryable("transport");
  }
}
