import {
  MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
  type MediaTransformAcceptedAttempt,
  type MediaTransformAttempt,
  type MediaTransformCancelInput,
  type MediaTransformCancelOutcome,
  type MediaTransformProbeInput,
  MediaTransformRequestInvalid,
  type MediaTransformService,
  type MediaTransformVideoAudioInput,
  type MediaTransformVideoAudioOutcome,
  type MediaTransformVideoBinding,
  type MediaTransformVideoFramesInput,
  type MediaTransformVideoFramesOutcome,
  type MediaTransformVideoProbe,
  type MediaTransformVideoProbeInput,
  type MediaTransformVideoProbeOutcome,
} from "@pirate/application/media/transform";
import { VIDEO_INGEST_POLICY_V1, VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Effect, Predicate } from "effect";

const QENCODE_ORIGIN = "https://api.qencode.com";
const QENCODE_ACCESS_TOKEN_ENDPOINT = `${QENCODE_ORIGIN}/v1/access_token`;
const QENCODE_CREATE_TASK_ENDPOINT = `${QENCODE_ORIGIN}/v1/create_task`;
const QENCODE_START_TASK_ENDPOINT = `${QENCODE_ORIGIN}/v1/start_encode2`;
const QENCODE_STATUS_ENDPOINT = `${QENCODE_ORIGIN}/v1/status`;
export const QENCODE_ADAPTER_REVISION = "qencode-video-analysis-v1";
const QENCODE_METADATA_VERSION = "4.1.5";
const QENCODE_MAX_RESPONSE_BYTES = 2_097_152;
const QENCODE_MAX_AUDIO_BYTES = 8_000_000;
const QENCODE_JOB_ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

type QencodeFormat = Readonly<Record<string, string | number>>;
type QencodeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type QencodeTaskQuery = Readonly<{
  source: string;
  format: readonly QencodeFormat[];
}>;

export type QencodeOutput = Readonly<{
  kind: "audio" | "image" | "metadata";
  userTag: string;
  url: string;
  outputFormat: string | null;
  mediaFacts: Readonly<{
    codec: string | null;
    sampleRateHz: number | null;
    channels: number | null;
    width: number | null;
    height: number | null;
  }>;
}>;

export type QencodeTaskStatus =
  | Readonly<{ state: "not_started" | "processing" | "failed" | "not_found" }>
  | Readonly<{ state: "completed"; outputs: readonly QencodeOutput[] }>;

export type QencodeTaskTransport = Readonly<{
  createTask: (apiKey: string, signal?: AbortSignal) => Promise<string>;
  startTask: (
    input: Readonly<{
      taskToken: string;
      query: QencodeTaskQuery;
      payload: string;
      signal?: AbortSignal;
    }>,
  ) => Promise<"accepted" | "rejected">;
  getStatus: (taskToken: string, signal?: AbortSignal) => Promise<QencodeTaskStatus>;
}>;

export type QencodeSourceGrantIssuer = Readonly<{
  issue: (
    input: Readonly<{
      objectKey: string;
      sha256: string;
      byteLength: number;
      mediaType: "video/mp4" | "video/quicktime";
      expiresAtMs: number;
      requestId: string;
    }>,
  ) => Promise<Readonly<{ url: string; expiresAtMs: number }>>;
}>;

type QencodeSealedArtifact = Readonly<{
  artifactRef: string;
  canonicalSha256: string;
  byteLength: number;
}>;

export type QencodeArtifactStore = Readonly<{
  readJson: (url: string, maximumBytes: number, signal?: AbortSignal) => Promise<unknown>;
  seal: (
    input: Readonly<{
      sourceUrl: string;
      artifactKey: string;
      artifactRef: string;
      mediaType: "audio/mp4" | "image/jpeg";
      maximumBytes: number;
      sourceSha256: string;
      policyRevision: string;
      signal?: AbortSignal;
    }>,
  ) => Promise<QencodeSealedArtifact>;
}>;

export type QencodeMediaTransformOptions =
  | Readonly<{ enabled?: false }>
  | Readonly<{
      enabled: true;
      apiKey: string;
      transport: QencodeTaskTransport;
      sourceGateway: QencodeSourceGrantIssuer;
      artifacts: QencodeArtifactStore;
      clock?: () => number;
      adapterRevision?: string;
    }>;

class QencodeMalformedResponse extends Error {}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!Predicate.isObject(value) || Array.isArray(value)) throw new QencodeMalformedResponse();
  return value;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.ok) throw new Error("qencode transport failed");
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    await response.body?.cancel("wrong_content_type");
    throw new QencodeMalformedResponse();
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel("response_too_large");
    throw new QencodeMalformedResponse();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new QencodeMalformedResponse();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response_too_large");
        throw new QencodeMalformedResponse();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new QencodeMalformedResponse();
  }
}

async function postForm(
  fetcher: QencodeFetch,
  endpoint: string,
  values: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = new URLSearchParams(values);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  });
  return readBoundedResponse(response, QENCODE_MAX_RESPONSE_BYTES);
}

function qencodeError(value: Readonly<Record<string, unknown>>): number {
  return typeof value.error === "number" ? value.error : value.error === undefined ? 0 : 1;
}

function outputList(value: unknown, kind: QencodeOutput["kind"]): QencodeOutput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Predicate.isObject(entry) || Array.isArray(entry)) return [];
    const userTag = typeof entry.user_tag === "string" ? entry.user_tag : null;
    const url = typeof entry.url === "string" ? entry.url : null;
    const meta = Predicate.isObject(entry.meta) && !Array.isArray(entry.meta) ? entry.meta : {};
    const numeric = (candidate: unknown): number | null => {
      const parsed = typeof candidate === "number" ? candidate : Number(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return userTag === null || url === null
      ? []
      : [
          {
            kind,
            userTag,
            url,
            outputFormat: typeof entry.output_format === "string" ? entry.output_format : null,
            mediaFacts: {
              codec: typeof meta.codec === "string" ? meta.codec : null,
              sampleRateHz: numeric(meta.sample_rate),
              channels: numeric(meta.channels),
              width: numeric(meta.width ?? meta.resolution_width),
              height: numeric(meta.height ?? meta.resolution_height),
            },
          },
        ];
  });
}

function validQencodeStatusUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0 &&
      url.pathname === "/v1/status" &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      (url.hostname === "qencode.com" || url.hostname.endsWith(".qencode.com"))
    );
  } catch {
    return false;
  }
}

/** Fixed-endpoint Qencode transport. Secret-bearing form bodies are never logged. */
export function makeQencodeTaskTransport(fetcher: QencodeFetch = fetch): QencodeTaskTransport {
  return {
    createTask: async (apiKey, signal) => {
      const access = record(
        await postForm(fetcher, QENCODE_ACCESS_TOKEN_ENDPOINT, { api_key: apiKey }, signal),
      );
      if (qencodeError(access) !== 0 || typeof access.token !== "string") {
        throw new Error("qencode access rejected");
      }
      const created = record(
        await postForm(fetcher, QENCODE_CREATE_TASK_ENDPOINT, { token: access.token }, signal),
      );
      if (
        qencodeError(created) !== 0 ||
        typeof created.task_token !== "string" ||
        !QENCODE_JOB_ID.test(created.task_token)
      ) {
        throw new QencodeMalformedResponse();
      }
      return created.task_token;
    },
    startTask: async ({ taskToken, query, payload, signal }) => {
      const started = record(
        await postForm(
          fetcher,
          QENCODE_START_TASK_ENDPOINT,
          { task_token: taskToken, query: JSON.stringify({ query }), payload },
          signal,
        ),
      );
      return qencodeError(started) === 0 ? "accepted" : "rejected";
    },
    getStatus: async (taskToken, signal) => {
      let body = record(
        await postForm(fetcher, QENCODE_STATUS_ENDPOINT, { task_tokens: taskToken }, signal),
      );
      if (qencodeError(body) !== 0) return { state: "not_found" };
      let statuses = record(body.statuses);
      let raw = statuses[taskToken];
      if (raw === undefined || raw === null) return { state: "not_started" };
      let status = record(raw);
      if (typeof status.status_url === "string" && status.status_url !== QENCODE_STATUS_ENDPOINT) {
        if (!validQencodeStatusUrl(status.status_url)) throw new QencodeMalformedResponse();
        body = record(
          await postForm(fetcher, status.status_url, { task_tokens: taskToken }, signal),
        );
        if (qencodeError(body) !== 0) return { state: "not_found" };
        statuses = record(body.statuses);
        raw = statuses[taskToken];
        if (raw === undefined || raw === null) return { state: "not_started" };
        status = record(raw);
      }
      if (status.error !== undefined && status.error !== 0 && status.error !== false) {
        return { state: "failed" };
      }
      if (status.status === "completed") {
        return {
          state: "completed",
          outputs: [
            ...outputList(status.audios, "audio"),
            ...outputList(status.images, "image"),
            ...outputList(status.texts, "metadata"),
            ...outputList(status.videos, "metadata"),
          ],
        };
      }
      if (
        status.status === "downloading" ||
        status.status === "queued" ||
        status.status === "encoding" ||
        status.status === "saving"
      ) {
        return { state: "processing" };
      }
      if (status.status === "created" || status.status === "new") {
        return { state: "not_started" };
      }
      throw new QencodeMalformedResponse();
    },
  };
}

function validProviderOutputUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0 &&
      url.hash.length === 0 &&
      (url.hostname === "qencode.com" || url.hostname.endsWith(".qencode.com"))
    );
  } catch {
    return false;
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error("qencode artifact unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel("output_too_large");
    throw new Error("output_too_large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("qencode artifact missing body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("output_too_large");
        throw new Error("output_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validArtifactBytes(mediaType: "audio/mp4" | "image/jpeg", bytes: Uint8Array): boolean {
  if (mediaType === "image/jpeg") {
    return (
      bytes.byteLength >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.byteLength - 2] === 0xff &&
      bytes[bytes.byteLength - 1] === 0xd9
    );
  }
  return bytes.byteLength >= 12 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp";
}

type QencodeArtifactObject = Readonly<{
  key: string;
  size: number;
  httpMetadata?: Readonly<{ contentType?: string }>;
  customMetadata?: Readonly<Record<string, string>>;
}>;

type QencodeArtifactBucket = Readonly<{
  head: (key: string) => Promise<QencodeArtifactObject | null>;
  put: (
    key: string,
    value: Uint8Array,
    options: Readonly<{
      onlyIf: Readonly<{ etagDoesNotMatch: string }>;
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }>,
  ) => Promise<QencodeArtifactObject | null>;
}>;

/** Seals bounded temporary Qencode outputs into the application-owned R2 bucket. */
export function makeR2QencodeArtifactStore(
  bucket: QencodeArtifactBucket,
  fetcher: QencodeFetch = fetch,
): QencodeArtifactStore {
  return {
    readJson: async (url, maximumBytes, signal) => {
      if (!validProviderOutputUrl(url)) throw new Error("invalid qencode output url");
      return readBoundedResponse(
        await fetcher(url, {
          method: "GET",
          redirect: "manual",
          ...(signal === undefined ? {} : { signal }),
        }),
        maximumBytes,
      );
    },
    seal: async (input) => {
      if (!validProviderOutputUrl(input.sourceUrl)) throw new Error("invalid qencode output url");
      const existing = await bucket.head(input.artifactKey);
      if (existing !== null) {
        const digest = existing.customMetadata?.sha256;
        if (
          digest === undefined ||
          !SHA256.test(digest) ||
          existing.httpMetadata?.contentType !== input.mediaType ||
          existing.customMetadata?.sourceSha256 !== input.sourceSha256 ||
          existing.customMetadata?.policyRevision !== input.policyRevision
        ) {
          throw new Error("sealed artifact identity conflict");
        }
        return {
          artifactRef: input.artifactRef,
          canonicalSha256: digest,
          byteLength: existing.size,
        };
      }
      const bytes = await readBoundedBytes(
        await fetcher(input.sourceUrl, {
          method: "GET",
          redirect: "manual",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
        input.maximumBytes,
      );
      if (!validArtifactBytes(input.mediaType, bytes)) throw new Error("invalid artifact bytes");
      const canonicalSha256 = bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
      const stored = await bucket.put(input.artifactKey, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: input.mediaType },
        customMetadata: {
          sha256: canonicalSha256,
          sourceSha256: input.sourceSha256,
          policyRevision: input.policyRevision,
        },
      });
      if (stored === null) {
        const winner = await bucket.head(input.artifactKey);
        if (
          winner === null ||
          winner.httpMetadata?.contentType !== input.mediaType ||
          winner.customMetadata?.sourceSha256 !== input.sourceSha256 ||
          winner.customMetadata?.policyRevision !== input.policyRevision ||
          !SHA256.test(winner.customMetadata?.sha256 ?? "")
        ) {
          throw new Error("sealed artifact race conflict");
        }
        return {
          artifactRef: input.artifactRef,
          canonicalSha256: winner.customMetadata?.sha256 as string,
          byteLength: winner.size,
        };
      }
      return { artifactRef: input.artifactRef, canonicalSha256, byteLength: bytes.byteLength };
    },
  };
}

function acceptedAttempt(
  attempt: MediaTransformAttempt,
  providerJobId: string,
  providerJobPhase: "allocated" | "started",
): MediaTransformAcceptedAttempt {
  return {
    version: "media-transform-attempt-v1",
    runtimeFence: attempt.runtimeFence,
    providerJobId,
    providerJobPhase,
  };
}

function context(binding: MediaTransformVideoBinding, adapterRevision: string) {
  return {
    version: "media-transform-video-attempt-context-v1" as const,
    ...binding,
    adapterRevision,
  };
}

function invalidVideoInput(
  input:
    | MediaTransformVideoProbeInput
    | MediaTransformVideoAudioInput
    | MediaTransformVideoFramesInput,
): MediaTransformRequestInvalid | null {
  if (
    !SAFE_IDENTIFIER.test(input.binding.operationId) ||
    !SAFE_IDENTIFIER.test(input.binding.requestId)
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_video_binding" });
  }
  if (
    !SHA256.test(input.binding.canonicalVideoSha256) ||
    input.binding.canonicalVideoSha256 !== input.source.sha256 ||
    !Number.isSafeInteger(input.binding.videoRevision) ||
    input.binding.videoRevision < 1 ||
    !Number.isSafeInteger(input.binding.analysisRevision) ||
    input.binding.analysisRevision < 1
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_video_binding" });
  }
  if (
    !SAFE_IDENTIFIER.test(input.source.objectKey) ||
    input.source.objectKey.startsWith("http://") ||
    input.source.objectKey.startsWith("https://") ||
    input.source.objectKey.split("/").includes("..") ||
    !SHA256.test(input.source.sha256) ||
    !Number.isSafeInteger(input.source.byteLength) ||
    input.source.byteLength < 1 ||
    input.source.byteLength > VIDEO_INGEST_POLICY_V1.maxBytes
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_video_source" });
  }
  const fence = input.attempt.runtimeFence;
  if (
    !Number.isSafeInteger(fence.submittedAtMs) ||
    !Number.isSafeInteger(fence.runtimeDeadlineMs) ||
    fence.submittedAtMs < 0 ||
    fence.runtimeDeadlineMs <= fence.submittedAtMs
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_runtime_fence" });
  }
  if (
    (input.attempt.providerJobId === undefined) !==
      (input.attempt.providerJobPhase === undefined) ||
    (input.attempt.providerJobId !== undefined && !QENCODE_JOB_ID.test(input.attempt.providerJobId))
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_job_id" });
  }
  if (
    input.version === "media-transform-video-audio-input-v1" &&
    input.extractionPolicyVersion !== MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_video_policy" });
  }
  if (
    input.version === "media-transform-video-frames-input-v1" &&
    (input.posterPolicy.version !== VIDEO_POSTER_POLICY_V1.version ||
      input.posterPolicy.policyRevision !== VIDEO_POSTER_POLICY_V1.policyRevision ||
      !Number.isSafeInteger(input.sourceDimensions.width) ||
      input.sourceDimensions.width < 1 ||
      !Number.isSafeInteger(input.sourceDimensions.height) ||
      input.sourceDimensions.height < 1 ||
      input.posterTimestampMs < 0 ||
      input.posterTimestampMs >= input.sourceDurationMs)
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_video_policy" });
  }
  return null;
}

function payload(
  binding: MediaTransformVideoBinding,
  capability: "probe" | "audio" | "frames",
): string {
  return JSON.stringify({
    version: "pirate-video-analysis-job-v1",
    request_id: binding.requestId,
    operation_id: binding.operationId,
    video_revision: binding.videoRevision,
    analysis_revision: binding.analysisRevision,
    capability,
  });
}

function formatsFor(
  input:
    | MediaTransformVideoProbeInput
    | MediaTransformVideoAudioInput
    | MediaTransformVideoFramesInput,
): readonly QencodeFormat[] {
  if (input.version === "media-transform-video-probe-input-v1") {
    return [
      {
        output: "metadata",
        metadata_version: QENCODE_METADATA_VERSION,
        user_tag: "pirate-probe-v1",
      },
    ];
  }
  if (input.version === "media-transform-video-audio-input-v1") {
    return [
      {
        output: "m4a",
        audio_codec: "aac",
        audio_bitrate: 192,
        audio_sample_rate: 44_100,
        audio_channels_number: 2,
        user_tag: "pirate-audio-v1",
      },
    ];
  }
  const midpointMs = Math.floor(input.sourceDurationMs / 2);
  const { width, height } = input.sourceDimensions;
  const maximumEdge = Math.min(input.posterPolicy.maxEdgePx, Math.max(width, height));
  const boundedDimensions =
    width >= height
      ? { width: maximumEdge, height: Math.max(1, Math.round((height * maximumEdge) / width)) }
      : { width: Math.max(1, Math.round((width * maximumEdge) / height)), height: maximumEdge };
  return [
    ["poster", input.posterTimestampMs],
    ["first", 0],
    ["midpoint", midpointMs],
  ].map(([role, timestampMs]) => ({
    output: "thumbnail",
    time: Number(timestampMs) / input.sourceDurationMs,
    width: boundedDimensions.width,
    height: boundedDimensions.height,
    image_format: "jpg",
    quality: 82,
    user_tag: `pirate-frame-${String(role)}-v1`,
  }));
}

function oneOutput(
  outputs: readonly QencodeOutput[],
  kind: QencodeOutput["kind"],
  userTag: string,
  outputFormat: string,
): QencodeOutput {
  const matches = outputs.filter(
    (output) =>
      output.kind === kind && output.userTag === userTag && output.outputFormat === outputFormat,
  );
  if (matches.length !== 1 || !validProviderOutputUrl(matches[0]?.url ?? "")) {
    throw new QencodeMalformedResponse();
  }
  const selected = matches[0];
  if (selected === undefined) throw new QencodeMalformedResponse();
  return selected;
}

function rationalMillihertz(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+\/\d+$/u.test(value)) return null;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  const result = Math.round((numerator * 1_000) / denominator);
  return Number.isSafeInteger(result) && denominator > 0 ? result : null;
}

function parseProbeMetadata(value: unknown, evidenceRef: string): MediaTransformVideoProbe {
  const document = record(value);
  const format = record(document.format);
  if (!Array.isArray(document.streams)) throw new QencodeMalformedResponse();
  const streams = document.streams.map(record);
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationMs = Math.round(Number(format.duration) * 1_000);
  const frameRateMillihertz = rationalMillihertz(video?.avg_frame_rate);
  if (
    video?.codec_name !== "h264" ||
    audio?.codec_name !== "aac" ||
    !Number.isSafeInteger(video.width) ||
    !Number.isSafeInteger(video.height) ||
    Number(video.width) < 1 ||
    Number(video.height) < 1 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    frameRateMillihertz === null ||
    frameRateMillihertz < 1
  ) {
    throw new QencodeMalformedResponse();
  }
  return {
    evidenceRef,
    durationMs,
    width: video.width as number,
    height: video.height as number,
    frameRateMillihertz,
    videoCodec: "h264",
    audioCodec: "aac",
    hasAudio: true,
  };
}

function failureAttempt(input: { readonly attempt: MediaTransformAttempt }) {
  return input.attempt;
}

function retryable(
  input: { readonly attempt: MediaTransformAttempt },
  reason: "cancelled" | "transport",
) {
  return { status: "retryable_failure" as const, reason, attempt: failureAttempt(input) };
}

function resumeJob(
  input: MediaTransformVideoProbeInput,
  options: Extract<QencodeMediaTransformOptions, { enabled: true }>,
  adapterRevision: string,
): Promise<MediaTransformVideoProbeOutcome>;
function resumeJob(
  input: MediaTransformVideoAudioInput,
  options: Extract<QencodeMediaTransformOptions, { enabled: true }>,
  adapterRevision: string,
): Promise<MediaTransformVideoAudioOutcome>;
function resumeJob(
  input: MediaTransformVideoFramesInput,
  options: Extract<QencodeMediaTransformOptions, { enabled: true }>,
  adapterRevision: string,
): Promise<MediaTransformVideoFramesOutcome>;
async function resumeJob(
  input:
    | MediaTransformVideoProbeInput
    | MediaTransformVideoAudioInput
    | MediaTransformVideoFramesInput,
  options: Extract<QencodeMediaTransformOptions, { enabled: true }>,
  adapterRevision: string,
): Promise<
  | MediaTransformVideoProbeOutcome
  | MediaTransformVideoAudioOutcome
  | MediaTransformVideoFramesOutcome
> {
  const now = (options.clock ?? Date.now)();
  if (now >= input.attempt.runtimeFence.runtimeDeadlineMs) {
    return { status: "rejected", reason: "runtime_exceeded", attempt: input.attempt };
  }
  let providerJobId = input.attempt.providerJobId;
  try {
    if (providerJobId === undefined) {
      providerJobId = await options.transport.createTask(options.apiKey, input.signal);
      return {
        status: "submitted",
        attempt: acceptedAttempt(input.attempt, providerJobId, "allocated"),
      };
    }
    let status = await options.transport.getStatus(providerJobId, input.signal);
    if (
      input.attempt.providerJobPhase === "started" &&
      (status.state === "not_started" || status.state === "not_found")
    ) {
      return { status: "retryable_failure", reason: "provider", attempt: input.attempt };
    }
    if (status.state === "not_started" || status.state === "not_found") {
      const grant = await options.sourceGateway.issue({
        ...input.source,
        expiresAtMs: input.attempt.runtimeFence.runtimeDeadlineMs,
        requestId: input.binding.requestId,
      });
      const sourceUrl = new URL(grant.url);
      if (
        sourceUrl.protocol !== "https:" ||
        sourceUrl.username.length > 0 ||
        sourceUrl.password.length > 0 ||
        sourceUrl.port.length > 0 ||
        sourceUrl.search.length > 0 ||
        sourceUrl.hash.length > 0 ||
        grant.expiresAtMs <= now ||
        grant.expiresAtMs > input.attempt.runtimeFence.runtimeDeadlineMs
      ) {
        throw new QencodeMalformedResponse();
      }
      const capability =
        input.version === "media-transform-video-probe-input-v1"
          ? "probe"
          : input.version === "media-transform-video-audio-input-v1"
            ? "audio"
            : "frames";
      const started = await options.transport.startTask({
        taskToken: providerJobId,
        query: { source: grant.url, format: formatsFor(input) },
        payload: payload(input.binding, capability),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (started === "accepted") {
        return {
          status: "processing",
          attempt: acceptedAttempt(input.attempt, providerJobId, "started"),
        };
      }
      status = await options.transport.getStatus(providerJobId, input.signal);
      if (status.state === "not_found" || status.state === "not_started") {
        return { status: "rejected", reason: "provider_rejected", attempt: input.attempt };
      }
    }
    if (status.state === "processing") {
      return {
        status: "processing",
        attempt: acceptedAttempt(input.attempt, providerJobId, "started"),
      };
    }
    if (status.state === "failed") {
      return { status: "rejected", reason: "provider_rejected", attempt: input.attempt };
    }
    if (status.state !== "completed") {
      return { status: "retryable_failure", reason: "provider", attempt: input.attempt };
    }
    const attempt = acceptedAttempt(input.attempt, providerJobId, "started");
    const transformContext = context(input.binding, adapterRevision);
    if (input.version === "media-transform-video-probe-input-v1") {
      const output = oneOutput(status.outputs, "metadata", "pirate-probe-v1", "metadata");
      const probe = parseProbeMetadata(
        await options.artifacts.readJson(output.url, QENCODE_MAX_RESPONSE_BYTES, input.signal),
        `qencode:metadata:${providerJobId}`,
      );
      return { status: "completed", attempt, context: transformContext, probe };
    }
    if (input.version === "media-transform-video-audio-input-v1") {
      const output = oneOutput(status.outputs, "audio", "pirate-audio-v1", "m4a");
      // Qencode documents audios[].meta as source-stream metadata. The output
      // policy is the fixed server-owned M4A query, not those source facts.
      const artifact = await options.artifacts.seal({
        sourceUrl: output.url,
        artifactKey: `video-analysis/${input.binding.operationId}/v${input.binding.videoRevision}/a${input.binding.analysisRevision}/soundtrack.m4a`,
        artifactRef: `media://derived/video-analysis/${input.binding.operationId}/v${input.binding.videoRevision}/a${input.binding.analysisRevision}/soundtrack.m4a`,
        mediaType: "audio/mp4",
        maximumBytes: QENCODE_MAX_AUDIO_BYTES,
        sourceSha256: input.source.sha256,
        policyRevision: input.extractionPolicyVersion,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return {
        status: "completed",
        attempt,
        context: transformContext,
        artifact: {
          artifactRef: artifact.artifactRef,
          canonicalSha256: artifact.canonicalSha256,
          sourceSha256: input.source.sha256,
          videoRevision: input.binding.videoRevision,
          mediaType: "audio/mp4",
          policyRevision: input.extractionPolicyVersion,
          adapterRevision,
        },
      };
    }
    const requested = [
      ["poster", input.posterTimestampMs],
      ["first", 0],
      ["midpoint", Math.floor(input.sourceDurationMs / 2)],
    ] as const;
    const frames = [];
    for (const [role, timestampMs] of requested) {
      const output = oneOutput(status.outputs, "image", `pirate-frame-${role}-v1`, "thumbnail");
      if (
        output.mediaFacts.width === null ||
        output.mediaFacts.height === null ||
        !Number.isSafeInteger(output.mediaFacts.width) ||
        !Number.isSafeInteger(output.mediaFacts.height) ||
        output.mediaFacts.width < 1 ||
        output.mediaFacts.height < 1 ||
        Math.max(output.mediaFacts.width, output.mediaFacts.height) > input.posterPolicy.maxEdgePx
      ) {
        throw new QencodeMalformedResponse();
      }
      const artifact = await options.artifacts.seal({
        sourceUrl: output.url,
        artifactKey: `video-analysis/${input.binding.operationId}/v${input.binding.videoRevision}/a${input.binding.analysisRevision}/${role}.jpg`,
        artifactRef: `media://derived/video-analysis/${input.binding.operationId}/v${input.binding.videoRevision}/a${input.binding.analysisRevision}/${role}.jpg`,
        mediaType: "image/jpeg",
        maximumBytes: input.posterPolicy.maxBytesPerFrame,
        sourceSha256: input.source.sha256,
        policyRevision: String(input.posterPolicy.policyRevision),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      frames.push({
        role,
        requestedTimestampMs: role === "poster" ? timestampMs : null,
        timestampMs,
        sha256: artifact.canonicalSha256,
        artifactRef: artifact.artifactRef,
      });
    }
    return {
      status: "completed",
      attempt,
      context: transformContext,
      extraction: {
        evidenceRef: `qencode:frames:${providerJobId}`,
        adapterRevision,
        sourceSha256: input.source.sha256,
        videoRevision: input.binding.videoRevision,
        posterPolicyRevision: input.posterPolicy.policyRevision,
        frames: frames as [
          (typeof frames)[number],
          (typeof frames)[number],
          (typeof frames)[number],
        ],
      },
    };
  } catch (error) {
    if (error instanceof QencodeMalformedResponse) {
      return { status: "malformed_response", reason: "unsupported_shape", attempt: input.attempt };
    }
    return retryable(
      input,
      error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "transport",
    );
  }
}

function cancelJob(
  input: MediaTransformCancelInput,
): Effect.Effect<MediaTransformCancelOutcome, MediaTransformRequestInvalid> {
  if (!SAFE_IDENTIFIER.test(input.requestId) || !QENCODE_JOB_ID.test(input.providerJobId)) {
    return Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_job_id" }));
  }
  // Qencode's documented transcoding API has no cancellation endpoint.
  return Effect.succeed({ status: "unavailable", reason: "disabled" });
}

export function makeQencodeMediaTransform(
  options: QencodeMediaTransformOptions = {},
): MediaTransformService {
  if (options.enabled !== true) {
    const unavailable = (input: { readonly attempt: MediaTransformAttempt }) =>
      Effect.succeed({
        status: "unavailable" as const,
        reason: "disabled" as const,
        attempt: input.attempt,
      });
    return {
      probe: unavailable as MediaTransformService["probe"],
      extractAudioSample: unavailable,
      extractVideoAudio: unavailable,
      extractVideoFrames: unavailable,
      extractCanonicalAudioSegment: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
      alignVideoSoundtrackToSong: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
      cancelJob: () => Effect.succeed({ status: "unavailable", reason: "disabled" }),
    };
  }
  if (
    options.apiKey.trim().length < 8 ||
    options.apiKey === "PENDING" ||
    typeof options.transport.createTask !== "function" ||
    typeof options.transport.startTask !== "function" ||
    typeof options.transport.getStatus !== "function" ||
    typeof options.sourceGateway.issue !== "function" ||
    typeof options.artifacts.readJson !== "function" ||
    typeof options.artifacts.seal !== "function"
  ) {
    throw new MediaTransformRequestInvalid({ reason: "invalid_credentials" });
  }
  const adapterRevision = options.adapterRevision ?? QENCODE_ADAPTER_REVISION;
  if (!SAFE_IDENTIFIER.test(adapterRevision)) {
    throw new MediaTransformRequestInvalid({ reason: "invalid_adapter_revision" });
  }
  const probeVideo = (input: MediaTransformVideoProbeInput) => {
    const invalid = invalidVideoInput(input);
    return invalid === null
      ? Effect.promise(() => resumeJob(input, options, adapterRevision))
      : Effect.fail(invalid);
  };
  const audioVideo = (input: MediaTransformVideoAudioInput) => {
    const invalid = invalidVideoInput(input);
    return invalid === null
      ? Effect.promise(() => resumeJob(input, options, adapterRevision))
      : Effect.fail(invalid);
  };
  const framesVideo = (input: MediaTransformVideoFramesInput) => {
    const invalid = invalidVideoInput(input);
    return invalid === null
      ? Effect.promise(() => resumeJob(input, options, adapterRevision))
      : Effect.fail(invalid);
  };
  return {
    probe: ((input: MediaTransformProbeInput | MediaTransformVideoProbeInput) =>
      input.version === "media-transform-video-probe-input-v1"
        ? probeVideo(input)
        : Effect.succeed({
            status: "unavailable",
            reason: "disabled",
            attempt: input.attempt,
          })) as MediaTransformService["probe"],
    extractAudioSample: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
    extractVideoAudio: audioVideo,
    extractVideoFrames: framesVideo,
    extractCanonicalAudioSegment: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
    alignVideoSoundtrackToSong: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
    cancelJob,
  };
}
