import {
  MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS,
  MEDIA_TRANSFORM_SAMPLE_MAX_MS,
  type MediaTransformAudioSampleOutcome,
  type MediaTransformAudioTrack,
  type MediaTransformMalformedReason,
  type MediaTransformProbe,
  type MediaTransformProbeOutcome,
  type MediaTransformRejectedReason,
  type MediaTransformSampleArtifact,
  mediaTransformSampleWindow,
} from "@pirate/application/media/transform";
import { Predicate } from "effect";
import {
  headerValue,
  TRANSLOADIT_PROBE_RESULT_STEP,
  TRANSLOADIT_SAMPLE_RESULT_STEP,
  type TransloaditOperationSnapshot,
  type TransloaditTransportResponse,
  validTransloaditJobId,
} from "./media-transform-protocol.ts";

const MAX_JSON_DEPTH = 12;
const MAX_JSON_PROPERTIES = 768;
const MAX_JSON_ARRAY_ITEMS = 64;
const MAX_JSON_STRING_BYTES = 65_536;
const textEncoder = new TextEncoder();

export class TransloaditBodyTooLarge extends Error {
  constructor() {
    super("response_too_large");
    this.name = "TransloaditBodyTooLarge";
  }
}

export class TransloaditBodyAborted extends Error {
  constructor() {
    super("response_aborted");
    this.name = "TransloaditBodyAborted";
  }
}

export type TransloaditAssembly =
  | Readonly<{ readonly state: "processing"; readonly providerJobId: string }>
  | Readonly<{
      readonly state: "failed";
      readonly providerJobId: string;
      readonly providerCode: string;
    }>
  | Readonly<{
      readonly state: "completed";
      readonly providerJobId: string;
      readonly executionDurationMs: number;
      readonly result: Readonly<Record<string, unknown>>;
    }>;

export type TransloaditAssemblyParseResult =
  | Readonly<{ readonly ok: true; readonly value: TransloaditAssembly }>
  | Readonly<{ readonly ok: false; readonly reason: MediaTransformMalformedReason }>;

function isJsonMediaType(value: string): boolean {
  const [mediaType, ...parameters] = value.split(";");
  if (mediaType?.trim().toLowerCase() !== "application/json") return false;
  return parameters.every((parameter) =>
    /^[\t ]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^\r\n;]+[\t ]*$/u.test(parameter),
  );
}

function boundedJson(value: unknown, depth = 0, counter = { properties: 0 }): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (typeof value === "string")
    return textEncoder.encode(value).byteLength <= MAX_JSON_STRING_BYTES;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) return false;
    return value.every((item) => boundedJson(item, depth + 1, counter));
  }
  if (!Predicate.isObject(value)) return true;
  const keys = Object.keys(value);
  counter.properties += keys.length;
  if (counter.properties > MAX_JSON_PROPERTIES) return false;
  return keys.every((key) => key.length <= 128 && boundedJson(value[key], depth + 1, counter));
}

function releaseReader(reader: Readonly<{ readonly releaseLock: () => void }>): void {
  try {
    reader.releaseLock();
  } catch {
    queueMicrotask(() => {
      try {
        reader.releaseLock();
      } catch {
        // The transport retains a still-pending native read.
      }
    });
  }
}

export async function readBoundedTransloaditJson(
  response: TransloaditTransportResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = headerValue(response.headers, "content-type");
  if (contentType === null || !isJsonMediaType(contentType)) {
    try {
      void Promise.resolve(response.body.cancel("wrong_content_type")).catch(() => undefined);
    } catch {
      // Cleanup cannot replace the selected classification.
    }
    throw new TypeError("wrong_content_type");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new TransloaditBodyAborted();
      const read = reader.read();
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new TransloaditBodyAborted());
        signal.addEventListener("abort", rejectAbort, { once: true });
        if (signal.aborted) rejectAbort();
      });
      const result = await (async () => {
        try {
          return await Promise.race([read, aborted]);
        } finally {
          if (rejectAbort !== undefined) signal.removeEventListener("abort", rejectAbort);
        }
      })();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new TypeError("unsupported_shape");
      total += result.value.byteLength;
      if (total > maxBytes) throw new TransloaditBodyTooLarge();
      chunks.push(result.value);
    }
  } catch (error) {
    try {
      void Promise.resolve(reader.cancel("response_rejected")).catch(() => undefined);
    } catch {
      // Cleanup cannot replace the selected classification.
    }
    throw error;
  } finally {
    releaseReader(reader);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SyntaxError("malformed_json");
  }
  if (!boundedJson(decoded)) throw new TypeError("unsupported_shape");
  return decoded;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function providerFile(
  results: unknown,
  step: string,
): Readonly<Record<string, unknown>> | "duplicate" | null {
  if (!Predicate.isObject(results)) return null;
  const files = results[step];
  if (!Array.isArray(files)) return null;
  if (files.length !== 1) return "duplicate";
  const file = files[0];
  return Predicate.isObject(file) ? file : null;
}

export function parseTransloaditAssembly(
  value: unknown,
  expectedJobId: string | undefined,
  resultStep: string,
): TransloaditAssemblyParseResult {
  if (!Predicate.isObject(value)) return { ok: false, reason: "unsupported_shape" };
  const providerJobId = value.assembly_id;
  if (
    !validTransloaditJobId(providerJobId) ||
    (expectedJobId !== undefined && providerJobId !== expectedJobId)
  ) {
    return { ok: false, reason: "unsupported_shape" };
  }
  if (typeof value.error === "string") {
    if (value.error.length === 0 || value.error.length > 128) {
      return { ok: false, reason: "unsupported_shape" };
    }
    return {
      ok: true,
      value: Object.freeze({ state: "failed", providerJobId, providerCode: value.error }),
    };
  }
  if (typeof value.ok !== "string" || value.ok.length > 64) {
    return { ok: false, reason: "unsupported_shape" };
  }
  if (value.ok !== "ASSEMBLY_COMPLETED") {
    if (
      value.ok === "ASSEMBLY_EXECUTING" ||
      value.ok === "ASSEMBLY_UPLOADING" ||
      value.ok === "ASSEMBLY_REPLAYING"
    ) {
      return {
        ok: true,
        value: Object.freeze({ state: "processing", providerJobId }),
      };
    }
    return { ok: false, reason: "unsupported_shape" };
  }
  const executionSeconds =
    value.execution_duration === undefined ? 0 : finiteNonNegative(value.execution_duration);
  if (executionSeconds === null) return { ok: false, reason: "unsupported_shape" };
  const result = providerFile(value.results, resultStep);
  if (result === "duplicate") return { ok: false, reason: "duplicate_results" };
  if (result === null) return { ok: false, reason: "unsupported_shape" };
  return {
    ok: true,
    value: Object.freeze({
      state: "completed",
      providerJobId,
      executionDurationMs: Math.round(executionSeconds * 1_000),
      result: Object.freeze({ ...result }),
    }),
  };
}

function boundedProviderToken(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  return /^[A-Za-z0-9.+_-]+$/u.test(value) ? value.toLowerCase() : null;
}

function normalizedCodec(value: unknown): MediaTransformAudioTrack["codec"] | null {
  const codec = boundedProviderToken(value);
  if (codec === null) return null;
  if (codec === "aac") return "aac";
  if (codec === "flac") return "flac";
  if (codec === "mp3" || codec === "mp3float") return "mp3";
  if (codec === "opus") return "opus";
  if (/^pcm_(?:f32|f64|s16|s24|s32)le$/u.test(codec)) return "pcm";
  return null;
}

function normalizedContainer(
  extension: unknown,
  mime: unknown,
): MediaTransformProbe["container"] | null {
  const ext = boundedProviderToken(extension);
  if (ext === "mp4" || ext === "mov") return "m4a";
  if (ext === "wave") return "wav";
  if (
    ext === "aac" ||
    ext === "flac" ||
    ext === "m4a" ||
    ext === "mp3" ||
    ext === "ogg" ||
    ext === "opus" ||
    ext === "wav" ||
    ext === "webm"
  ) {
    return ext;
  }
  if (typeof mime !== "string") return null;
  const normalizedMime = mime.toLowerCase();
  const fromMime: Readonly<Record<string, MediaTransformProbe["container"]>> = {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-wav": "wav",
  };
  return fromMime[normalizedMime] ?? null;
}

function positiveInteger(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : null;
}

function bitrateMode(value: unknown): MediaTransformAudioTrack["bitrateMode"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (normalized === "vbr" || normalized === "variable") return "variable";
  if (normalized === "cbr" || normalized === "constant") return "constant";
  return "unknown";
}

type CompletedProbe = Extract<MediaTransformProbeOutcome, { readonly status: "completed" }>;
type CompletedSample = Extract<MediaTransformAudioSampleOutcome, { readonly status: "completed" }>;

export function probeFromAssembly(
  assembly: Extract<TransloaditAssembly, { readonly state: "completed" }>,
  context: CompletedProbe["context"],
):
  | CompletedProbe
  | Readonly<{ readonly status: "rejected"; readonly reason: MediaTransformRejectedReason }>
  | Readonly<{
      readonly status: "malformed_response";
      readonly reason: MediaTransformMalformedReason;
    }> {
  const meta = assembly.result.meta;
  if (!Predicate.isObject(meta))
    return { status: "malformed_response", reason: "unsupported_shape" };
  const durationSeconds = finiteNonNegative(meta.duration);
  if (durationSeconds === null || durationSeconds === 0) {
    return { status: "malformed_response", reason: "unsupported_shape" };
  }
  if (durationSeconds * 1_000 > MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS) {
    return { status: "rejected", reason: "duration_exceeded" };
  }
  const rawCodec = boundedProviderToken(meta.audio_codec);
  if (rawCodec === null) return { status: "rejected", reason: "no_audio_track" };
  const codec = normalizedCodec(rawCodec);
  if (codec === null) return { status: "rejected", reason: "unsupported_codec" };
  const container = normalizedContainer(assembly.result.ext, assembly.result.mime);
  if (container === null) return { status: "rejected", reason: "unsupported_container" };
  const mime = assembly.result.mime;
  if (
    typeof mime !== "string" ||
    mime.length === 0 ||
    mime.length > 128 ||
    !mime.startsWith("audio/")
  ) {
    return { status: "malformed_response", reason: "unsupported_shape" };
  }
  const channels = positiveInteger(meta.audio_channels, 32);
  const sampleRateHz = positiveInteger(meta.audio_samplerate, 768_000);
  if (channels === null || sampleRateHz === null) {
    return { status: "malformed_response", reason: "unsupported_shape" };
  }
  const bitrate =
    meta.audio_bitrate === undefined || meta.audio_bitrate === null
      ? null
      : positiveInteger(meta.audio_bitrate, 100_000_000);
  if (meta.audio_bitrate !== undefined && meta.audio_bitrate !== null && bitrate === null) {
    return { status: "malformed_response", reason: "unsupported_shape" };
  }
  const track: MediaTransformAudioTrack = Object.freeze({
    kind: "audio",
    codec,
    channels,
    sampleRateHz,
    bitrateBps: bitrate,
    bitrateMode: bitrateMode(meta.audio_bitrate_mode),
  });
  const probe: MediaTransformProbe = Object.freeze({
    version: "media-transform-probe-v1",
    durationMs: Math.round(durationSeconds * 1_000),
    container,
    mimeType: mime.toLowerCase(),
    tracks: Object.freeze([track]) as readonly [MediaTransformAudioTrack],
  });
  return Object.freeze({
    status: "completed",
    providerJobId: assembly.providerJobId,
    context,
    probe,
  });
}

export function sampleFromAssembly(
  assembly: Extract<TransloaditAssembly, { readonly state: "completed" }>,
  operation: Extract<TransloaditOperationSnapshot, { readonly kind: "sample" }>,
  context: CompletedSample["context"],
  outputObjectKey: string,
  maxSampleBytes: number,
):
  | CompletedSample
  | Readonly<{ readonly status: "rejected"; readonly reason: MediaTransformRejectedReason }>
  | Readonly<{
      readonly status: "malformed_response";
      readonly reason: MediaTransformMalformedReason;
    }> {
  const size = positiveInteger(assembly.result.size, maxSampleBytes);
  if (size === null) {
    return typeof assembly.result.size === "number" && assembly.result.size > maxSampleBytes
      ? { status: "rejected", reason: "output_too_large" }
      : { status: "malformed_response", reason: "unsupported_shape" };
  }
  const meta = assembly.result.meta;
  if (!Predicate.isObject(meta))
    return { status: "malformed_response", reason: "unsupported_shape" };
  const codec = boundedProviderToken(meta.audio_codec);
  const mime = typeof assembly.result.mime === "string" ? assembly.result.mime.toLowerCase() : null;
  if (codec !== "pcm_s16le" || (mime !== "audio/wav" && mime !== "audio/x-wav")) {
    return { status: "rejected", reason: "unsupported_codec" };
  }
  const durationSeconds = finiteNonNegative(meta.duration);
  if (durationSeconds === null || durationSeconds <= 0) {
    return { status: "malformed_response", reason: "unsupported_shape" };
  }
  const actualDurationMs = Math.round(durationSeconds * 1_000);
  const expected = mediaTransformSampleWindow(operation.sourceDurationMs, operation.variant);
  if (
    actualDurationMs > MEDIA_TRANSFORM_SAMPLE_MAX_MS ||
    actualDurationMs > expected.durationMs + 500 ||
    actualDurationMs < Math.max(1, expected.durationMs - 500)
  ) {
    return { status: "malformed_response", reason: "unsupported_shape" };
  }
  const artifact: MediaTransformSampleArtifact = Object.freeze({
    version: "media-transform-sample-artifact-v1",
    objectKey: outputObjectKey,
    contentType: "audio/wav",
    byteLength: size,
    offsetMs: expected.offsetMs,
    durationMs: actualDurationMs,
    variant: operation.variant,
  });
  return Object.freeze({
    status: "completed",
    providerJobId: assembly.providerJobId,
    context,
    artifact,
  });
}

export function resultStepFor(operation: TransloaditOperationSnapshot): string {
  return operation.kind === "probe"
    ? TRANSLOADIT_PROBE_RESULT_STEP
    : TRANSLOADIT_SAMPLE_RESULT_STEP;
}
