import type {
  MediaProcessingAlignmentPort,
  MediaProcessingArtifactReader,
  MediaProcessingAuthority,
  MediaProcessingEmbeddedMetadata,
  MediaProcessingMetadataPort,
  MediaProcessingProviders,
} from "@pirate/application/media/processing-contracts";
import type { MediaTransformSampleArtifact } from "@pirate/application/media/transform";
import type {
  AcrCloudTransport,
  AcrCloudTransportRequest,
  AcrCloudTransportResponse,
} from "./media-providers/acrcloud-protocol.ts";
import { endpointForAcrCloud } from "./media-providers/acrcloud-protocol.ts";
import type { ElevenLabsAlignmentAdapter } from "./media-providers/elevenlabs-alignment.ts";
import {
  ELEVENLABS_ALIGNMENT_ADAPTER_REVISION,
  ELEVENLABS_ALIGNMENT_ENDPOINT,
  type ElevenLabsAlignmentAudioSource,
  type ElevenLabsAlignmentOutcome,
  type ElevenLabsAlignmentResponseBody,
  type ElevenLabsAlignmentTransport,
} from "./media-providers/elevenlabs-alignment-types.ts";
import {
  TRANSLOADIT_ASSEMBLIES_PATH,
  TRANSLOADIT_ORIGIN,
  type TransloaditTransport,
  type TransloaditTransportRequest,
  type TransloaditTransportResponse,
} from "./media-transform-protocol.ts";

export {
  MEDIA_MP3_SAMPLE_ADAPTER_REVISION,
  makeR2Mp3SampleMediaTransform,
  readMp3FrameWindow,
} from "./media-mp3-sample.ts";

const IMMUTABLE_REF_PREFIX = "media://immutable/";
const SHA256 = /^[0-9a-f]{64}$/u;
const TRANSLOADIT_JOB_URL = new RegExp(
  `^${TRANSLOADIT_ORIGIN.replaceAll(".", "\\.")}${TRANSLOADIT_ASSEMBLIES_PATH}/[a-f0-9]{32}$`,
  "u",
);
const ID3_HEADER_BYTES = 10;
const ID3_MAX_TAG_BYTES = 1_048_576;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type MediaProcessingFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

export type MediaProcessingRuntime = Readonly<{
  readonly enabled: boolean;
  readonly providers: MediaProcessingProviders | null;
}>;

export type MediaProcessingRuntimeOptions =
  | Readonly<{ readonly enabled?: false }>
  | Readonly<{ readonly enabled: true; readonly providers: MediaProcessingProviders }>;

export class MediaProcessingArtifactFailure extends Error {
  constructor(
    readonly reason:
      | "aborted"
      | "invalid_reference"
      | "object_missing"
      | "object_changed"
      | "object_too_large"
      | "object_shape_mismatch"
      | "stream_failed",
  ) {
    super(reason);
    this.name = "MediaProcessingArtifactFailure";
  }
}

export class MediaProcessingTransportFailure extends Error {
  constructor(readonly reason: "invalid_request" | "network") {
    super(reason);
    this.name = "MediaProcessingTransportFailure";
  }
}

type VerifiedR2Object = Readonly<{
  readonly object: R2Object;
  readonly body: ReadableStream<Uint8Array>;
}>;

function hasBody(value: R2Object | R2ObjectBody): value is R2ObjectBody {
  return "body" in value && value.body instanceof ReadableStream;
}

function sameR2Identity(expected: R2Object, actual: R2Object): boolean {
  return (
    expected.key === actual.key &&
    expected.version === actual.version &&
    expected.etag === actual.etag &&
    expected.size === actual.size &&
    expected.httpMetadata?.contentType === actual.httpMetadata?.contentType
  );
}

function responseStream(response: Response): ReadableStream<Uint8Array> {
  return (
    response.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
  );
}

function validFetchRequest(
  request: Readonly<{
    method: string;
    url: string;
    redirect: "error";
  }>,
  method: string,
  url: string | RegExp,
): boolean {
  return (
    request.method === method &&
    request.redirect === "error" &&
    (typeof url === "string" ? request.url === url : url.test(request.url))
  );
}

async function fetchResponse(
  fetcher: MediaProcessingFetch,
  request: Readonly<{
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: BodyInit;
    readonly signal: AbortSignal;
    readonly redirect: "error";
  }>,
): Promise<Response> {
  try {
    return await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: request.signal,
      redirect: "error",
    });
  } catch (error) {
    const diagnostic =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message.replaceAll(request.url, "[endpoint]").slice(0, 200),
          }
        : { name: "UnknownTransportError", message: "non-error transport rejection" };
    console.error("media_processing_transport_failure", diagnostic);
    throw new MediaProcessingTransportFailure("network");
  }
}

/** Fixed Transloadit transport. Adapter-owned signed bodies never enter errors or observations. */
export function makeTransloaditFetchTransport(
  fetcher: MediaProcessingFetch = fetch,
): TransloaditTransport {
  return {
    request: async (
      request: TransloaditTransportRequest,
    ): Promise<TransloaditTransportResponse> => {
      const create = validFetchRequest(
        request,
        "POST",
        `${TRANSLOADIT_ORIGIN}${TRANSLOADIT_ASSEMBLIES_PATH}`,
      );
      const job =
        (request.method === "GET" || request.method === "DELETE") &&
        validFetchRequest(request, request.method, TRANSLOADIT_JOB_URL);
      if (!create && !job) throw new MediaProcessingTransportFailure("invalid_request");
      const response = await fetchResponse(fetcher, {
        ...request,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return { status: response.status, headers: response.headers, body: responseStream(response) };
    },
  };
}

/** The ACR host is frozen by composition and every request is exact-path, POST, no-redirect. */
export function makeAcrCloudFetchTransport(
  host: string,
  fetcher: MediaProcessingFetch = fetch,
): AcrCloudTransport {
  const endpoint = endpointForAcrCloud(host);
  return {
    request: async (request: AcrCloudTransportRequest): Promise<AcrCloudTransportResponse> => {
      if (!validFetchRequest(request, "POST", endpoint)) {
        throw new MediaProcessingTransportFailure("invalid_request");
      }
      const response = await fetchResponse(fetcher, {
        ...request,
        body: request.body,
      });
      return { status: response.status, headers: response.headers, body: responseStream(response) };
    },
  };
}

function asyncIterableStream(
  iterable: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        await iterator.return?.();
        controller.error(new DOMException("cancelled", "AbortError"));
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else if (next.value instanceof Uint8Array) controller.enqueue(next.value);
        else controller.error(new TypeError("invalid transport body chunk"));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function alignmentResponseBody(response: Response): ElevenLabsAlignmentResponseBody {
  const stream = responseStream(response);
  let opened = false;
  return {
    open: async function* (signal?: AbortSignal) {
      if (opened) throw new TypeError("alignment response body is one-pass");
      opened = true;
      const reader = stream.getReader();
      try {
        while (true) {
          if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
    cancel: (reason) => stream.cancel(reason),
  };
}

/** Forced alignment is the only ElevenLabs endpoint permitted by this transport. */
export function makeElevenLabsAlignmentFetchTransport(
  fetcher: MediaProcessingFetch = fetch,
): ElevenLabsAlignmentTransport {
  return async (request) => {
    if (request.method !== "POST" || request.url !== ELEVENLABS_ALIGNMENT_ENDPOINT) {
      throw new MediaProcessingTransportFailure("invalid_request");
    }
    const body = asyncIterableStream(request.body.open(request.signal), request.signal);
    const response = await fetchResponse(fetcher, { ...request, body, redirect: "error" });
    return {
      status: response.status,
      headers: response.headers,
      body: alignmentResponseBody(response),
    };
  };
}

async function selectVerifiedObject(
  bucket: R2Bucket,
  key: string,
  range?: Readonly<{ readonly offset: number; readonly length: number }>,
): Promise<VerifiedR2Object> {
  let expected: R2Object | null;
  try {
    expected = await bucket.head(key);
  } catch {
    throw new MediaProcessingArtifactFailure("stream_failed");
  }
  if (expected === null) throw new MediaProcessingArtifactFailure("object_missing");
  let selected: R2Object | R2ObjectBody | null;
  try {
    selected = await bucket.get(key, {
      onlyIf: { etagMatches: expected.etag },
      ...(range === undefined ? {} : { range }),
    });
  } catch {
    throw new MediaProcessingArtifactFailure("stream_failed");
  }
  if (selected === null || !hasBody(selected) || !sameR2Identity(expected, selected)) {
    if (selected !== null && hasBody(selected)) void selected.body.cancel("object_changed");
    throw new MediaProcessingArtifactFailure("object_changed");
  }
  return { object: expected, body: selected.body };
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    void stream.cancel("invalid_bound");
    throw new MediaProcessingArtifactFailure("object_too_large");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel("aborted");
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new MediaProcessingArtifactFailure("aborted");
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new MediaProcessingArtifactFailure("stream_failed");
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("object_too_large");
        throw new MediaProcessingArtifactFailure("object_too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof MediaProcessingArtifactFailure) throw error;
    throw new MediaProcessingArtifactFailure(signal.aborted ? "aborted" : "stream_failed");
  } finally {
    signal.removeEventListener("abort", abort);
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

/** HEAD + conditional GET binds Transloadit's retained R2 object before ACR sees bytes. */
export function makeR2MediaProcessingArtifactReader(
  retainedArtifacts: R2Bucket,
): MediaProcessingArtifactReader {
  return {
    readAudioSample: async (
      artifact: MediaTransformSampleArtifact,
      maximumBytes: number,
      signal: AbortSignal,
    ) => {
      if (
        artifact.retainedObjectVerification !== "required" ||
        (artifact.contentType !== "audio/mpeg" && artifact.contentType !== "audio/wav") ||
        !Number.isSafeInteger(artifact.byteLength) ||
        artifact.byteLength < 1 ||
        artifact.byteLength > maximumBytes
      ) {
        throw new MediaProcessingArtifactFailure("object_shape_mismatch");
      }
      const selected = await selectVerifiedObject(retainedArtifacts, artifact.objectKey);
      if (
        selected.object.size !== artifact.byteLength ||
        selected.object.httpMetadata?.contentType !== artifact.contentType
      ) {
        void selected.body.cancel("object_shape_mismatch");
        throw new MediaProcessingArtifactFailure("object_shape_mismatch");
      }
      const bytes = await readBoundedStream(selected.body, maximumBytes, signal);
      if (bytes.byteLength !== artifact.byteLength) {
        throw new MediaProcessingArtifactFailure("object_shape_mismatch");
      }
      return bytes;
    },
  };
}

function synchsafe(bytes: Uint8Array, offset: number): number | null {
  const values = bytes.subarray(offset, offset + 4);
  if (values.byteLength !== 4 || values.some((value) => value > 0x7f)) return null;
  return values.reduce((total, value) => total * 128 + value, 0);
}

function unsigned32(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.byteLength) return null;
  return (
    ((bytes[offset] ?? 0) * 0x1_00_00_00 +
      (bytes[offset + 1] ?? 0) * 0x1_00_00 +
      (bytes[offset + 2] ?? 0) * 0x1_00 +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  if (bytes.byteLength % 2 !== 0) throw new TypeError("invalid utf16 title");
  const units = new Uint16Array(bytes.byteLength / 2);
  for (let index = 0; index < units.length; index += 1) {
    const high = bytes[index * 2] ?? 0;
    const low = bytes[index * 2 + 1] ?? 0;
    units[index] = littleEndian ? low * 0x100 + high : high * 0x100 + low;
  }
  return String.fromCharCode(...units);
}

function decodeId3Text(frame: Uint8Array): string {
  const encoding = frame[0];
  const content = frame.subarray(1);
  let value: string;
  if (encoding === 0) value = new TextDecoder("windows-1252").decode(content);
  else if (encoding === 3) value = textDecoder.decode(content);
  else if (encoding === 1) {
    if (content.byteLength < 2) throw new TypeError("missing utf16 bom");
    const bom = (content[0] ?? 0) * 0x100 + (content[1] ?? 0);
    if (bom !== 0xfeff && bom !== 0xfffe) throw new TypeError("invalid utf16 bom");
    value = decodeUtf16(content.subarray(2), bom === 0xfffe);
  } else if (encoding === 2) value = decodeUtf16(content, false);
  else throw new TypeError("unsupported title encoding");
  const normalized = value.replace(/\0+$/u, "").trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (normalized.length === 0 || normalized.length > 200 || hasControlCharacter) {
    throw new TypeError("invalid embedded title");
  }
  return normalized;
}

type Id3Facts = Readonly<{ readonly title: string | null; readonly artworkPresent: boolean }>;

function parseId3(bytes: Uint8Array): Id3Facts {
  if (bytes.byteLength < ID3_HEADER_BYTES) return { title: null, artworkPresent: false };
  if (String.fromCharCode(...bytes.subarray(0, 3)) !== "ID3") {
    return { title: null, artworkPresent: false };
  }
  const major = bytes[3];
  const flags = bytes[5] ?? 0;
  if ((major !== 3 && major !== 4) || flags !== 0) throw new TypeError("unsupported id3 header");
  const tagBytes = synchsafe(bytes, 6);
  if (tagBytes === null || tagBytes + ID3_HEADER_BYTES > bytes.byteLength) {
    throw new TypeError("truncated id3 tag");
  }
  const end = ID3_HEADER_BYTES + tagBytes;
  let offset = ID3_HEADER_BYTES;
  let title: string | null = null;
  let artworkPresent = false;
  while (offset + 10 <= end) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (/^\0{4}$/u.test(id)) break;
    if (!/^[A-Z0-9]{4}$/u.test(id)) throw new TypeError("invalid id3 frame");
    const size = major === 4 ? synchsafe(bytes, offset + 4) : unsigned32(bytes, offset + 4);
    if (size === null || size < 0 || offset + 10 + size > end) {
      throw new TypeError("invalid id3 frame size");
    }
    const frame = bytes.subarray(offset + 10, offset + 10 + size);
    if (id === "TIT2") title = decodeId3Text(frame);
    if (id === "APIC") artworkPresent = true;
    offset += 10 + size;
  }
  return { title, artworkPresent };
}

function immutableObjectKey(reference: string): string {
  if (!reference.startsWith(IMMUTABLE_REF_PREFIX)) {
    throw new MediaProcessingArtifactFailure("invalid_reference");
  }
  const suffix = reference.slice(IMMUTABLE_REF_PREFIX.length);
  if (
    suffix.length === 0 ||
    suffix.length > 768 ||
    suffix.startsWith("/") ||
    suffix.includes("\\") ||
    suffix.split("/").includes("..")
  ) {
    throw new MediaProcessingArtifactFailure("invalid_reference");
  }
  return `immutable/${suffix}`;
}

export function makeR2EmbeddedMetadataPort(
  immutableOriginals: R2Bucket,
  maximumTagBytes = ID3_MAX_TAG_BYTES,
): MediaProcessingMetadataPort {
  return {
    extract: async (authority: MediaProcessingAuthority, signal: AbortSignal) => {
      if (authority.audio === null || authority.audio.contentType !== "audio/mpeg") {
        throw new MediaProcessingArtifactFailure("object_shape_mismatch");
      }
      const key = immutableObjectKey(authority.audio.immutableRef);
      const selected = await selectVerifiedObject(immutableOriginals, key, {
        offset: 0,
        length: Math.min(authority.audio.sizeBytes, maximumTagBytes + ID3_HEADER_BYTES),
      });
      if (
        selected.object.size !== authority.audio.sizeBytes ||
        selected.object.httpMetadata?.contentType !== authority.audio.contentType
      ) {
        void selected.body.cancel("object_shape_mismatch");
        throw new MediaProcessingArtifactFailure("object_shape_mismatch");
      }
      const bytes = await readBoundedStream(
        selected.body,
        maximumTagBytes + ID3_HEADER_BYTES,
        signal,
      );
      let facts: Id3Facts;
      try {
        facts = parseId3(bytes);
      } catch {
        return {
          evidenceRef: `metadata-evidence-${authority.operationId}-a${authority.analysisRevision}`,
          adapterRevision: "id3v2-mp3-metadata-v1",
          trackTitle: null,
          cover: { status: "rejected", reasonCode: "invalid" },
        };
      }
      return {
        evidenceRef: `metadata-evidence-${authority.operationId}-a${authority.analysisRevision}`,
        adapterRevision: "id3v2-mp3-metadata-v1",
        trackTitle: facts.title,
        cover: facts.artworkPresent
          ? { status: "rejected", reasonCode: "invalid" }
          : { status: "absent", reasonCode: "not_embedded" },
      } satisfies MediaProcessingEmbeddedMetadata;
    },
  };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function alignmentFailure(
  outcome: ElevenLabsAlignmentOutcome,
): Extract<
  Awaited<ReturnType<MediaProcessingAlignmentPort["align"]>>,
  { readonly status: "unavailable" }
> {
  if (outcome.outcome === "retryable" && outcome.reason === "rate_limited") {
    return { status: "unavailable", failureCode: "rate_limited" };
  }
  if (outcome.outcome === "timeout" || outcome.outcome === "cancelled") {
    return { status: "unavailable", failureCode: "timeout" };
  }
  if (outcome.outcome === "disabled") {
    return { status: "unavailable", failureCode: "elevenlabs_key_missing" };
  }
  if (outcome.outcome === "permanent" && outcome.reason === "configuration") {
    return { status: "unavailable", failureCode: "key_invalid" };
  }
  if (outcome.outcome === "malformed" || outcome.outcome === "transcript_mismatch") {
    return { status: "unavailable", failureCode: "invalid_response" };
  }
  if (outcome.outcome === "retryable") {
    return { status: "unavailable", failureCode: "provider_unavailable" };
  }
  return { status: "unavailable", failureCode: "alignment_failed" };
}

function r2AlignmentAudio(
  bucket: R2Bucket,
  key: string,
  expected: R2Object,
  digestState: { task: Promise<Readonly<{ sha256: string; bytes: number }>> | null },
): ElevenLabsAlignmentAudioSource {
  return {
    byteLength: expected.size,
    open: async function* (signal?: AbortSignal) {
      const selected = await selectVerifiedObject(bucket, key);
      if (!sameR2Identity(expected, selected.object)) {
        void selected.body.cancel("object_changed");
        throw new MediaProcessingArtifactFailure("object_changed");
      }
      const DigestStreamConstructor = (crypto as Crypto & { DigestStream: typeof DigestStream })
        .DigestStream;
      const digest = new DigestStreamConstructor("SHA-256");
      const [providerBody, digestBody] = selected.body.tee();
      digestState.task = digestBody.pipeTo(digest).then(async () => ({
        sha256: bytesToHex(await digest.digest),
        bytes: Number(digest.bytesWritten),
      }));
      const reader = providerBody.getReader();
      try {
        while (true) {
          if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

export function makeElevenLabsProcessingAlignmentPort(
  immutableOriginals: R2Bucket,
  adapter: Pick<ElevenLabsAlignmentAdapter, "align">,
  maximumAudioBytes: number,
): MediaProcessingAlignmentPort {
  return {
    align: async (input) => {
      if (!SHA256.test(input.canonicalAudioSha256)) {
        return { status: "unavailable", failureCode: "audio_missing" };
      }
      let key: string;
      try {
        key = immutableObjectKey(input.audioArtifactRef);
      } catch {
        return { status: "unavailable", failureCode: "audio_missing" };
      }
      let expected: R2Object | null;
      try {
        expected = await immutableOriginals.head(key);
      } catch {
        return { status: "unavailable", failureCode: "provider_unavailable" };
      }
      if (expected === null || expected.size < 1 || expected.size > maximumAudioBytes) {
        return { status: "unavailable", failureCode: "audio_missing" };
      }
      const digestState: {
        task: Promise<Readonly<{ sha256: string; bytes: number }>> | null;
      } = { task: null };
      const outcome = await adapter.align({
        request_id: `alignment-${input.operationId}-l${input.lyricsRevision}`,
        operation_id: input.operationId,
        post_id: input.postId,
        audio: {
          audio_revision: input.audioRevision,
          canonical_audio_sha256: input.canonicalAudioSha256,
          source: r2AlignmentAudio(immutableOriginals, key, expected, digestState),
          mime_type: expected.httpMetadata?.contentType ?? "application/octet-stream",
          filename: "canonical-audio",
        },
        transcript: {
          artifact_ref: `media://lyrics/${input.operationId}/${input.lyricsRevision}`,
          operation_id: input.operationId,
          audio_revision: input.audioRevision,
          analysis_revision: input.analysisRevision,
          canonical_audio_sha256: input.canonicalAudioSha256,
          transcript: input.lyrics,
        },
        signal: input.signal,
      });
      if (outcome.status !== "ready") return alignmentFailure(outcome);
      if (digestState.task === null) {
        return { status: "unavailable", failureCode: "invalid_response" };
      }
      let digest: Readonly<{ sha256: string; bytes: number }>;
      try {
        digest = await digestState.task;
      } catch {
        return { status: "unavailable", failureCode: "audio_missing" };
      }
      if (digest.sha256 !== input.canonicalAudioSha256 || digest.bytes !== expected.size) {
        return { status: "unavailable", failureCode: "audio_missing" };
      }
      const artifact = Object.freeze({
        version: "media-timed-lyrics-artifact-v1",
        operation_id: input.operationId,
        post_id: input.postId,
        audio_revision: input.audioRevision,
        analysis_revision: input.analysisRevision,
        lyrics_revision: input.lyricsRevision,
        canonical_audio_sha256: input.canonicalAudioSha256,
        adapter_revision: ELEVENLABS_ALIGNMENT_ADAPTER_REVISION,
        mode: outcome.mode,
        timings: outcome.timings,
      });
      const encoded = new TextEncoder().encode(JSON.stringify(artifact));
      const artifactSha256 = bytesToHex(await crypto.subtle.digest("SHA-256", encoded));
      return {
        status: "ready",
        artifactRef: `media://timed-lyrics/${input.operationId}/audio/${input.audioRevision}/analysis/${input.analysisRevision}/lyrics/${input.lyricsRevision}`,
        artifactSha256,
        artifact,
      };
    },
  };
}

/** Disabled is inert and does not even read the provider property. */
export function makeMediaProcessingRuntime(
  options: MediaProcessingRuntimeOptions = {},
): MediaProcessingRuntime {
  if (options.enabled !== true) return { enabled: false, providers: null };
  return { enabled: true, providers: options.providers };
}
