import type {
  MediaTransformAttempt,
  MediaTransformAttemptContext,
  MediaTransformAudioSampleInput,
  MediaTransformBinding,
  MediaTransformCancelInput,
  MediaTransformInvalidReason,
  MediaTransformProbeInput,
  MediaTransformRuntimeFence,
  MediaTransformSampleVariant,
  MediaTransformVideoAudioInput,
  MediaTransformVideoBinding,
  MediaTransformVideoFramesInput,
  MediaTransformVideoProbeInput,
} from "@pirate/application/media/transform";
import { MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1 } from "@pirate/application/media/transform";
import { VIDEO_INGEST_POLICY_V1, VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Data, type Effect, Predicate } from "effect";

export const TRANSLOADIT_ORIGIN = "https://api2.transloadit.com" as const;
export const TRANSLOADIT_ASSEMBLIES_PATH = "/assemblies" as const;
export const TRANSLOADIT_PROBE_RESULT_STEP = "probe" as const;
export const TRANSLOADIT_SAMPLE_RESULT_STEP = "sample" as const;
export const TRANSLOADIT_VIDEO_AUDIO_RESULT_STEP = "video_audio" as const;
export const TRANSLOADIT_VIDEO_POSTER_RESULT_STEP = "video_poster" as const;
export const TRANSLOADIT_VIDEO_FIRST_RESULT_STEP = "video_first" as const;
export const TRANSLOADIT_VIDEO_MIDPOINT_RESULT_STEP = "video_midpoint" as const;
export const TRANSLOADIT_ADAPTER_HARD_MAX_REQUEST_BYTES = 131_072;
export const TRANSLOADIT_ADAPTER_HARD_MAX_RESPONSE_BYTES = 2_097_152;
export const TRANSLOADIT_ADAPTER_HARD_MAX_SAMPLE_BYTES = 5_000_000;
export const TRANSLOADIT_ADAPTER_HARD_MAX_TIMEOUT_MS = 120_000;
export const TRANSLOADIT_ADAPTER_HARD_MAX_RUNTIME_MS = 30 * 60 * 1_000;
export const TRANSLOADIT_SIGNATURE_TTL_MS = 5 * 60 * 1_000;

const textEncoder = new TextEncoder();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TRANSLOADIT_ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type TransloaditTransportRequest = Readonly<{
  readonly requestId: string;
  readonly method: "DELETE" | "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal: AbortSignal;
  readonly redirect: "error";
}>;

export type TransloaditTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Headers | Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
}>;

export type TransloaditTransportResult =
  | TransloaditTransportResponse
  | PromiseLike<TransloaditTransportResponse>
  | Effect.Effect<TransloaditTransportResponse, unknown>;

export type TransloaditTransport = Readonly<{
  readonly request: (request: TransloaditTransportRequest) => TransloaditTransportResult;
}>;

export type TransloaditCredentials = Readonly<{
  readonly authKey: string;
  readonly authSecret: string;
}>;

export type TransloaditTemplates = Readonly<{
  readonly probe: string;
  readonly samplePrimary: string;
  readonly sampleAlternate: string;
  readonly videoAudio: string;
  readonly videoFrames: string;
}>;

export type TransloaditLimits = Readonly<{
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxSampleBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxAssemblyRuntimeMs: number;
}>;

export type TransloaditClock = Readonly<{
  readonly nowMilliseconds: () => number;
}>;

export type DisabledTransloaditOptions = Readonly<{
  readonly enabled?: false;
  readonly transport?: TransloaditTransport;
}>;

export type EnabledTransloaditOptions = Readonly<{
  readonly enabled: true;
  readonly adapterRevision: string;
  readonly credentials: TransloaditCredentials;
  readonly templates: TransloaditTemplates;
  readonly limits: TransloaditLimits;
  readonly clock: TransloaditClock | (() => number);
  readonly transport: TransloaditTransport;
}>;

export type TransloaditMediaTransformOptions =
  | DisabledTransloaditOptions
  | EnabledTransloaditOptions;

export class TransloaditRequestAbort extends Data.TaggedError("TransloaditRequestAbort")<{
  readonly reason: "cancelled" | "runtime_exceeded" | "timeout";
}> {}

export type TransloaditConfig = Readonly<{
  readonly adapterRevision: string;
  readonly credentials: TransloaditCredentials;
  readonly templates: TransloaditTemplates;
  readonly limits: TransloaditLimits;
  readonly nowMilliseconds: () => number;
  readonly request: TransloaditTransport["request"];
}>;

export type TransloaditProbeSnapshot = Readonly<{
  readonly kind: "probe";
  readonly binding: MediaTransformBinding;
  readonly sourceObjectKey: string;
  readonly runtimeFence: MediaTransformRuntimeFence;
  readonly resumeJobId?: string;
  readonly signal?: AbortSignal;
}>;

export type TransloaditSampleSnapshot = Readonly<{
  readonly kind: "sample";
  readonly binding: MediaTransformBinding;
  readonly sourceObjectKey: string;
  readonly sourceDurationMs: number;
  readonly variant: MediaTransformSampleVariant;
  readonly runtimeFence: MediaTransformRuntimeFence;
  readonly resumeJobId?: string;
  readonly signal?: AbortSignal;
}>;

type TransloaditVideoSnapshotBase = Readonly<{
  readonly binding: MediaTransformVideoBinding;
  readonly source: Readonly<{
    readonly objectKey: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly mediaType: "video/mp4" | "video/quicktime";
  }>;
  readonly runtimeFence: MediaTransformRuntimeFence;
  readonly resumeJobId?: string;
  readonly signal?: AbortSignal;
}>;

export type TransloaditVideoProbeSnapshot = TransloaditVideoSnapshotBase &
  Readonly<{ readonly kind: "video_probe" }>;

export type TransloaditVideoAudioSnapshot = TransloaditVideoSnapshotBase &
  Readonly<{
    readonly kind: "video_audio";
    readonly extractionPolicyVersion: string;
  }>;

export type TransloaditVideoFramesSnapshot = TransloaditVideoSnapshotBase &
  Readonly<{
    readonly kind: "video_frames";
    readonly sourceDurationMs: number;
    readonly posterTimestampMs: number;
    readonly posterPolicy: MediaTransformVideoFramesInput["posterPolicy"];
  }>;

export type TransloaditCancelSnapshot = Readonly<{
  readonly requestId: string;
  readonly providerJobId: string;
  readonly signal?: AbortSignal;
}>;

export type TransloaditOperationSnapshot =
  | TransloaditProbeSnapshot
  | TransloaditSampleSnapshot
  | TransloaditVideoProbeSnapshot
  | TransloaditVideoAudioSnapshot
  | TransloaditVideoFramesSnapshot;

type ValidationResult<A> =
  | Readonly<{ readonly ok: true; readonly value: A }>
  | Readonly<{ readonly ok: false; readonly reason: MediaTransformInvalidReason }>;

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRuntimeFence(submittedAtMs: unknown, runtimeDeadlineMs: unknown): boolean {
  return (
    typeof submittedAtMs === "number" &&
    Number.isSafeInteger(submittedAtMs) &&
    submittedAtMs >= 0 &&
    typeof runtimeDeadlineMs === "number" &&
    Number.isSafeInteger(runtimeDeadlineMs) &&
    runtimeDeadlineMs > submittedAtMs &&
    runtimeDeadlineMs - submittedAtMs <= TRANSLOADIT_ADAPTER_HARD_MAX_RUNTIME_MS
  );
}

function snapshotAttempt(attempt: unknown): ValidationResult<MediaTransformAttempt> {
  if (!Predicate.isObject(attempt) || attempt.version !== "media-transform-attempt-v1") {
    return { ok: false, reason: "invalid_runtime_fence" };
  }
  if (
    !Predicate.isObject(attempt.runtimeFence) ||
    !validRuntimeFence(attempt.runtimeFence.submittedAtMs, attempt.runtimeFence.runtimeDeadlineMs)
  ) {
    return { ok: false, reason: "invalid_runtime_fence" };
  }
  if (attempt.providerJobId !== undefined && !validTransloaditJobId(attempt.providerJobId)) {
    return { ok: false, reason: "invalid_job_id" };
  }
  const submittedAtMs = attempt.runtimeFence.submittedAtMs as number;
  const runtimeDeadlineMs = attempt.runtimeFence.runtimeDeadlineMs as number;
  return {
    ok: true,
    value: Object.freeze({
      version: "media-transform-attempt-v1",
      runtimeFence: Object.freeze({
        submittedAtMs,
        runtimeDeadlineMs,
      }),
      ...(attempt.providerJobId === undefined ? {} : { providerJobId: attempt.providerJobId }),
    }),
  };
}

function validSignal(signal: unknown): signal is AbortSignal | undefined {
  return signal === undefined || signal instanceof AbortSignal;
}

function validObjectKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f || character === "\\") {
      return false;
    }
  }
  return !value.startsWith("/") && !value.includes("://") && !value.split("/").includes("..");
}

function validBinding(binding: unknown): binding is MediaTransformBinding {
  if (!Predicate.isObject(binding)) return false;
  return (
    typeof binding.operationId === "string" &&
    SAFE_ID.test(binding.operationId) &&
    validPositiveInteger(binding.audioRevision) &&
    validPositiveInteger(binding.analysisRevision) &&
    typeof binding.canonicalAudioSha256 === "string" &&
    SHA256.test(binding.canonicalAudioSha256) &&
    typeof binding.requestId === "string" &&
    SAFE_ID.test(binding.requestId)
  );
}

function validVideoBinding(binding: unknown): binding is MediaTransformVideoBinding {
  if (!Predicate.isObject(binding)) return false;
  return (
    typeof binding.operationId === "string" &&
    SAFE_ID.test(binding.operationId) &&
    validPositiveInteger(binding.videoRevision) &&
    validPositiveInteger(binding.analysisRevision) &&
    typeof binding.canonicalVideoSha256 === "string" &&
    SHA256.test(binding.canonicalVideoSha256) &&
    typeof binding.requestId === "string" &&
    SAFE_ID.test(binding.requestId)
  );
}

export function validTransloaditJobId(value: unknown): value is string {
  return typeof value === "string" && TRANSLOADIT_ID.test(value);
}

function frozenBinding(binding: MediaTransformBinding): MediaTransformBinding {
  return Object.freeze({
    operationId: binding.operationId,
    audioRevision: binding.audioRevision,
    analysisRevision: binding.analysisRevision,
    canonicalAudioSha256: binding.canonicalAudioSha256,
    requestId: binding.requestId,
  });
}

function frozenVideoBinding(binding: MediaTransformVideoBinding): MediaTransformVideoBinding {
  return Object.freeze({
    operationId: binding.operationId,
    videoRevision: binding.videoRevision,
    analysisRevision: binding.analysisRevision,
    canonicalVideoSha256: binding.canonicalVideoSha256,
    requestId: binding.requestId,
  });
}

function snapshotVideoBase(
  input:
    | MediaTransformVideoProbeInput
    | MediaTransformVideoAudioInput
    | MediaTransformVideoFramesInput,
): ValidationResult<TransloaditVideoSnapshotBase> {
  if (!validVideoBinding(input.binding)) {
    return { ok: false, reason: "invalid_video_binding" };
  }
  if (
    !Predicate.isObject(input.source) ||
    !validObjectKey(input.source.objectKey) ||
    typeof input.source.sha256 !== "string" ||
    !SHA256.test(input.source.sha256) ||
    input.source.sha256 !== input.binding.canonicalVideoSha256 ||
    !validPositiveInteger(input.source.byteLength) ||
    input.source.byteLength > VIDEO_INGEST_POLICY_V1.maxBytes ||
    (input.source.mediaType !== "video/mp4" && input.source.mediaType !== "video/quicktime")
  ) {
    return { ok: false, reason: "invalid_video_source" };
  }
  if (!validSignal(input.signal)) return { ok: false, reason: "invalid_signal" };
  const attempt = snapshotAttempt(input.attempt);
  if (!attempt.ok) return attempt;
  const resumeJobId = attempt.value.providerJobId;
  return {
    ok: true,
    value: Object.freeze({
      binding: frozenVideoBinding(input.binding),
      source: Object.freeze({ ...input.source }),
      runtimeFence: attempt.value.runtimeFence,
      ...(resumeJobId === undefined ? {} : { resumeJobId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  };
}

export function snapshotVideoProbeInput(
  input: MediaTransformVideoProbeInput,
): ValidationResult<TransloaditVideoProbeSnapshot> {
  if (!Predicate.isObject(input) || input.version !== "media-transform-video-probe-input-v1") {
    return { ok: false, reason: "invalid_input_version" };
  }
  const base = snapshotVideoBase(input);
  return base.ok
    ? { ok: true, value: Object.freeze({ ...base.value, kind: "video_probe" }) }
    : base;
}

export function snapshotVideoAudioInput(
  input: MediaTransformVideoAudioInput,
): ValidationResult<TransloaditVideoAudioSnapshot> {
  if (!Predicate.isObject(input) || input.version !== "media-transform-video-audio-input-v1") {
    return { ok: false, reason: "invalid_input_version" };
  }
  const base = snapshotVideoBase(input);
  if (!base.ok) return base;
  if (input.extractionPolicyVersion !== MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1) {
    return { ok: false, reason: "invalid_video_policy" };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...base.value,
      kind: "video_audio",
      extractionPolicyVersion: input.extractionPolicyVersion,
    }),
  };
}

export function snapshotVideoFramesInput(
  input: MediaTransformVideoFramesInput,
): ValidationResult<TransloaditVideoFramesSnapshot> {
  if (!Predicate.isObject(input) || input.version !== "media-transform-video-frames-input-v1") {
    return { ok: false, reason: "invalid_input_version" };
  }
  const base = snapshotVideoBase(input);
  if (!base.ok) return base;
  if (
    !validPositiveInteger(input.sourceDurationMs) ||
    input.sourceDurationMs > 180_000 ||
    !Number.isSafeInteger(input.posterTimestampMs) ||
    input.posterTimestampMs < 0 ||
    input.posterTimestampMs >= input.sourceDurationMs
  ) {
    return { ok: false, reason: "invalid_video_timestamp" };
  }
  const policy = input.posterPolicy;
  if (
    !Predicate.isObject(policy) ||
    policy.version !== VIDEO_POSTER_POLICY_V1.version ||
    policy.policyRevision !== VIDEO_POSTER_POLICY_V1.policyRevision ||
    !Array.isArray(policy.roles) ||
    policy.roles.join(",") !== VIDEO_POSTER_POLICY_V1.roles.join(",") ||
    policy.maxEdgePx !== VIDEO_POSTER_POLICY_V1.maxEdgePx ||
    policy.maxBytesPerFrame !== VIDEO_POSTER_POLICY_V1.maxBytesPerFrame ||
    policy.imageType !== VIDEO_POSTER_POLICY_V1.imageType
  ) {
    return { ok: false, reason: "invalid_video_policy" };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...base.value,
      kind: "video_frames",
      sourceDurationMs: input.sourceDurationMs,
      posterTimestampMs: input.posterTimestampMs,
      posterPolicy: Object.freeze({
        ...policy,
        roles: Object.freeze([...policy.roles]),
      }) as MediaTransformVideoFramesInput["posterPolicy"],
    }),
  };
}

export function snapshotProbeInput(
  input: MediaTransformProbeInput,
): ValidationResult<TransloaditProbeSnapshot> {
  if (!Predicate.isObject(input) || input.version !== "media-transform-probe-input-v1") {
    return { ok: false, reason: "invalid_input_version" };
  }
  if (!validBinding(input.binding)) return { ok: false, reason: "invalid_binding" };
  if (!Predicate.isObject(input.source) || !validObjectKey(input.source.objectKey)) {
    return { ok: false, reason: "invalid_source" };
  }
  if (!validSignal(input.signal)) return { ok: false, reason: "invalid_signal" };
  const attempt = snapshotAttempt(input.attempt);
  if (!attempt.ok) return attempt;
  const resumeJobId = attempt.value.providerJobId;
  return {
    ok: true,
    value: Object.freeze({
      kind: "probe",
      binding: frozenBinding(input.binding),
      sourceObjectKey: input.source.objectKey,
      runtimeFence: attempt.value.runtimeFence,
      ...(resumeJobId === undefined ? {} : { resumeJobId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  };
}

export function snapshotSampleInput(
  input: MediaTransformAudioSampleInput,
): ValidationResult<TransloaditSampleSnapshot> {
  if (!Predicate.isObject(input) || input.version !== "media-transform-audio-sample-input-v1") {
    return { ok: false, reason: "invalid_input_version" };
  }
  if (!validBinding(input.binding)) return { ok: false, reason: "invalid_binding" };
  if (!Predicate.isObject(input.source) || !validObjectKey(input.source.objectKey)) {
    return { ok: false, reason: "invalid_source" };
  }
  if (!validPositiveInteger(input.sourceDurationMs) || input.sourceDurationMs > 60 * 60 * 1_000) {
    return { ok: false, reason: "invalid_source_duration" };
  }
  if (input.variant !== "primary" && input.variant !== "alternate") {
    return { ok: false, reason: "invalid_variant" };
  }
  if (!validSignal(input.signal)) return { ok: false, reason: "invalid_signal" };
  const attempt = snapshotAttempt(input.attempt);
  if (!attempt.ok) return attempt;
  const resumeJobId = attempt.value.providerJobId;
  return {
    ok: true,
    value: Object.freeze({
      kind: "sample",
      binding: frozenBinding(input.binding),
      sourceObjectKey: input.source.objectKey,
      sourceDurationMs: input.sourceDurationMs,
      variant: input.variant,
      runtimeFence: attempt.value.runtimeFence,
      ...(resumeJobId === undefined ? {} : { resumeJobId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  };
}

export function snapshotCancelInput(
  input: MediaTransformCancelInput,
): ValidationResult<TransloaditCancelSnapshot> {
  if (!Predicate.isObject(input) || input.version !== "media-transform-cancel-input-v1") {
    return { ok: false, reason: "invalid_input_version" };
  }
  if (typeof input.requestId !== "string" || !SAFE_ID.test(input.requestId)) {
    return { ok: false, reason: "invalid_request_id" };
  }
  if (!validTransloaditJobId(input.providerJobId)) {
    return { ok: false, reason: "invalid_job_id" };
  }
  if (!validSignal(input.signal)) return { ok: false, reason: "invalid_signal" };
  return {
    ok: true,
    value: Object.freeze({
      requestId: input.requestId,
      providerJobId: input.providerJobId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  };
}

function validLimits(limits: unknown): limits is TransloaditLimits {
  if (!Predicate.isObject(limits)) return false;
  return (
    validPositiveInteger(limits.maxRequestBytes) &&
    limits.maxRequestBytes <= TRANSLOADIT_ADAPTER_HARD_MAX_REQUEST_BYTES &&
    validPositiveInteger(limits.maxResponseBytes) &&
    limits.maxResponseBytes <= TRANSLOADIT_ADAPTER_HARD_MAX_RESPONSE_BYTES &&
    validPositiveInteger(limits.maxSampleBytes) &&
    limits.maxSampleBytes <= TRANSLOADIT_ADAPTER_HARD_MAX_SAMPLE_BYTES &&
    validPositiveInteger(limits.requestTimeoutMs) &&
    limits.requestTimeoutMs <= TRANSLOADIT_ADAPTER_HARD_MAX_TIMEOUT_MS &&
    validPositiveInteger(limits.maxAssemblyRuntimeMs) &&
    limits.maxAssemblyRuntimeMs <= TRANSLOADIT_ADAPTER_HARD_MAX_RUNTIME_MS
  );
}

export function snapshotTransloaditOptions(
  options: EnabledTransloaditOptions,
): ValidationResult<TransloaditConfig> {
  if (
    typeof options.adapterRevision !== "string" ||
    !SAFE_ID.test(options.adapterRevision) ||
    byteLength(options.adapterRevision) > 64
  ) {
    return { ok: false, reason: "invalid_adapter_revision" };
  }
  if (
    !Predicate.isObject(options.credentials) ||
    typeof options.credentials.authKey !== "string" ||
    options.credentials.authKey.length < 16 ||
    options.credentials.authKey.length > 256 ||
    typeof options.credentials.authSecret !== "string" ||
    options.credentials.authSecret.length < 16 ||
    options.credentials.authSecret.length > 4_096
  ) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (
    !Predicate.isObject(options.templates) ||
    !validTransloaditJobId(options.templates.probe) ||
    !validTransloaditJobId(options.templates.samplePrimary) ||
    !validTransloaditJobId(options.templates.sampleAlternate) ||
    !validTransloaditJobId(options.templates.videoAudio) ||
    !validTransloaditJobId(options.templates.videoFrames)
  ) {
    return { ok: false, reason: "invalid_template" };
  }
  if (!validLimits(options.limits)) return { ok: false, reason: "invalid_limits" };
  if (!Predicate.isObject(options.transport) || typeof options.transport.request !== "function") {
    return { ok: false, reason: "invalid_transport" };
  }
  const nowMilliseconds =
    typeof options.clock === "function" ? options.clock : options.clock.nowMilliseconds;
  if (typeof nowMilliseconds !== "function") return { ok: false, reason: "invalid_clock" };
  return {
    ok: true,
    value: Object.freeze({
      adapterRevision: options.adapterRevision,
      credentials: Object.freeze({ ...options.credentials }),
      templates: Object.freeze({ ...options.templates }),
      limits: Object.freeze({ ...options.limits }),
      nowMilliseconds,
      request: options.transport.request,
    }),
  };
}

export function transloaditAttemptContext(
  binding: MediaTransformBinding,
  adapterRevision: string,
): MediaTransformAttemptContext {
  return Object.freeze({
    version: "media-transform-attempt-context-v1",
    operationId: binding.operationId,
    audioRevision: binding.audioRevision,
    analysisRevision: binding.analysisRevision,
    canonicalAudioSha256: binding.canonicalAudioSha256,
    requestId: binding.requestId,
    adapterRevision,
  });
}

export function transloaditVideoAttemptContext(
  binding: MediaTransformVideoBinding,
  adapterRevision: string,
) {
  return Object.freeze({
    version: "media-transform-video-attempt-context-v1" as const,
    operationId: binding.operationId,
    videoRevision: binding.videoRevision,
    analysisRevision: binding.analysisRevision,
    canonicalVideoSha256: binding.canonicalVideoSha256,
    requestId: binding.requestId,
    adapterRevision,
  });
}

export function transloaditJobUrl(jobId: string): string {
  return `${TRANSLOADIT_ORIGIN}${TRANSLOADIT_ASSEMBLIES_PATH}/${jobId}`;
}

export type TransloaditMultipart = Readonly<{
  readonly body: Uint8Array;
  readonly contentType: string;
}>;

export function encodeTransloaditMultipart(
  params: string,
  signature: string,
  nonce: string,
): TransloaditMultipart {
  const boundary = `----pirate-transloadit-v1-${nonce.slice(0, 24)}`;
  const field = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = textEncoder.encode(
    `${field("params", params)}${field("signature", signature)}--${boundary}--\r\n`,
  );
  return Object.freeze({ body, contentType: `multipart/form-data; boundary=${boundary}` });
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

export async function stableTransloaditNonce(
  operation: TransloaditOperationSnapshot,
): Promise<string> {
  const seed = [
    operation.kind,
    operation.binding.operationId,
    "audioRevision" in operation.binding
      ? operation.binding.audioRevision
      : operation.binding.videoRevision,
    operation.binding.analysisRevision,
    "canonicalAudioSha256" in operation.binding
      ? operation.binding.canonicalAudioSha256
      : operation.binding.canonicalVideoSha256,
    operation.binding.requestId,
    operation.runtimeFence.submittedAtMs,
    operation.runtimeFence.runtimeDeadlineMs,
    operation.kind === "sample"
      ? operation.variant
      : operation.kind === "video_frames"
        ? `${operation.posterTimestampMs}:${operation.sourceDurationMs}`
        : operation.kind,
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(seed));
  return hex(new Uint8Array(digest));
}

export async function signTransloaditParams(secret: string, params: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-384" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(params));
  return `sha384:${hex(new Uint8Array(signature))}`;
}

export function headerValue(
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

export function retryAfterMilliseconds(
  headers: Headers | Readonly<Record<string, string>>,
): number | undefined {
  const raw = headerValue(headers, "retry-after");
  if (raw === null || !/^\d{1,6}$/u.test(raw)) return undefined;
  const milliseconds = Number(raw) * 1_000;
  return milliseconds > 0 && milliseconds <= 24 * 60 * 60 * 1_000 ? milliseconds : undefined;
}

export function validClockMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
