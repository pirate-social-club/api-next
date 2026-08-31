import {
  MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS,
  type MediaTransformAcceptedAttempt,
  type MediaTransformAttemptContext,
  type MediaTransformAudioSampleInput,
  type MediaTransformAudioSampleOutcome,
  type MediaTransformProbe,
  type MediaTransformProbeInput,
  type MediaTransformProbeOutcome,
  MediaTransformRequestInvalid,
  type MediaTransformService,
  mediaTransformSampleWindow,
} from "@pirate/application/media/transform";
import { Effect } from "effect";

const ADAPTER_REVISION = "r2-mp3-frame-window-v1";
const AUDIO_MPEG = "audio/mpeg";
const MAXIMUM_SOURCE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_INITIAL_SCAN_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

type Mp3Frame = Readonly<{
  readonly bitrateBps: number;
  readonly byteLength: number;
  readonly channels: 1 | 2;
  readonly durationMs: number;
  readonly sampleRateHz: number;
  readonly version: 1 | 2 | 2.5;
}>;

export type Mp3FrameWindow = Readonly<{
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly offsetMs: number;
}>;

class Mp3WindowFailure extends Error {
  constructor(
    readonly reason:
      | "aborted"
      | "duration_exceeded"
      | "inconsistent_media_facts"
      | "output_too_large"
      | "stream_failed"
      | "unsupported_codec",
  ) {
    super(reason);
    this.name = "Mp3WindowFailure";
  }
}

type Mp3StreamReader = Readonly<{
  readonly read: () => Promise<
    Readonly<{ readonly done: boolean; readonly value: Uint8Array | undefined }>
  >;
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly releaseLock: () => void;
}>;

class StreamBytes {
  readonly #reader: Mp3StreamReader;
  readonly #signal: AbortSignal;
  #buffer = new Uint8Array(0);
  #offset = 0;
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
    this.#reader = stream.getReader();
    this.#signal = signal;
  }

  get available(): number {
    return this.#buffer.byteLength - this.#offset;
  }

  async ensure(count: number): Promise<boolean> {
    while (this.available < count && !this.#ended) {
      if (this.#signal.aborted) throw new Mp3WindowFailure("aborted");
      let next: Readonly<{ readonly done: boolean; readonly value: Uint8Array | undefined }>;
      try {
        next = await this.#reader.read();
      } catch {
        throw new Mp3WindowFailure(this.#signal.aborted ? "aborted" : "stream_failed");
      }
      if (next.done) {
        this.#ended = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) throw new Mp3WindowFailure("stream_failed");
      const retained = this.#buffer.subarray(this.#offset);
      const combined = new Uint8Array(retained.byteLength + next.value.byteLength);
      combined.set(retained);
      combined.set(next.value, retained.byteLength);
      this.#buffer = combined;
      this.#offset = 0;
    }
    return this.available >= count;
  }

  view(count: number): Uint8Array {
    return this.#buffer.subarray(this.#offset, this.#offset + count);
  }

  take(count: number): Uint8Array {
    const value = this.#buffer.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return value;
  }

  discard(count: number): void {
    this.#offset += count;
  }

  async cancel(reason: string): Promise<void> {
    try {
      await this.#reader.cancel(reason);
    } catch {
      // Cancellation is cleanup after a selected outcome.
    }
  }

  release(): void {
    this.#reader.releaseLock();
  }
}

function synchsafe(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.byteLength) return null;
  const values = bytes.subarray(offset, offset + 4);
  if (values.some((value) => value > 0x7f)) return null;
  return values.reduce((total, value) => total * 128 + value, 0);
}

function parseMp3Frame(bytes: Uint8Array): Mp3Frame | null {
  if (bytes.byteLength < 4) return null;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null;
  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) return null;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const version: 1 | 2 | 2.5 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const mpeg1Bitrates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Bitrates = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateKbps = (version === 1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex - 1];
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex];
  if (bitrateKbps === undefined || baseSampleRate === undefined) return null;
  const sampleRateHz =
    version === 1 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
  const padding = (third >> 1) & 1;
  const byteLength =
    Math.floor(((version === 1 ? 144 : 72) * bitrateKbps * 1_000) / sampleRateHz) + padding;
  if (byteLength < 4) return null;
  const samples = version === 1 ? 1_152 : 576;
  return {
    bitrateBps: bitrateKbps * 1_000,
    byteLength,
    channels: ((fourth >> 6) & 0x03) === 3 ? 1 : 2,
    durationMs: (samples * 1_000) / sampleRateHz,
    sampleRateHz,
    version,
  };
}

/** Probe one sealed MP3 by walking every complete frame. */
export async function readMp3Probe(
  stream: ReadableStream<Uint8Array>,
  maximumDurationMs: number,
  signal: AbortSignal,
): Promise<MediaTransformProbe> {
  const reader = new StreamBytes(stream, signal);
  let durationMs = 0;
  let audioBytes = 0;
  let frames = 0;
  let first: Mp3Frame | null = null;
  let variableBitrate = false;
  try {
    await discardId3(reader);
    let scanned = 0;
    while (true) {
      if (!(await reader.ensure(4))) throw new Mp3WindowFailure("unsupported_codec");
      if (parseMp3Frame(reader.view(4)) !== null) break;
      reader.discard(1);
      scanned += 1;
      if (scanned > MAXIMUM_INITIAL_SCAN_BYTES) {
        throw new Mp3WindowFailure("unsupported_codec");
      }
    }

    while (true) {
      if (!(await reader.ensure(4))) {
        if (reader.available === 0 && frames > 0) break;
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      const header = reader.view(4);
      const frame = parseMp3Frame(header);
      if (frame === null) {
        if (header[0] === 0x54 && header[1] === 0x41 && header[2] === 0x47) {
          if (!(await reader.ensure(128))) {
            throw new Mp3WindowFailure("inconsistent_media_facts");
          }
          reader.discard(128);
          if ((await reader.ensure(1)) || reader.available !== 0) {
            throw new Mp3WindowFailure("inconsistent_media_facts");
          }
          break;
        }
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      if (
        first !== null &&
        (frame.version !== first.version ||
          frame.sampleRateHz !== first.sampleRateHz ||
          frame.channels !== first.channels)
      ) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      first ??= frame;
      variableBitrate ||= frame.bitrateBps !== first.bitrateBps;
      if (!(await reader.ensure(frame.byteLength))) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      reader.discard(frame.byteLength);
      frames += 1;
      audioBytes += frame.byteLength;
      durationMs += frame.durationMs;
      if (durationMs > maximumDurationMs) {
        throw new Mp3WindowFailure("duration_exceeded");
      }
    }
  } finally {
    await reader.cancel("probe_complete");
    reader.release();
  }

  if (first === null || frames === 0 || durationMs <= 0) {
    throw new Mp3WindowFailure("unsupported_codec");
  }
  return {
    version: "media-transform-probe-v1",
    durationMs: Math.round(durationMs),
    container: "mp3",
    mimeType: AUDIO_MPEG,
    tracks: [
      {
        kind: "audio",
        codec: "mp3",
        channels: first.channels,
        sampleRateHz: first.sampleRateHz,
        bitrateBps: variableBitrate
          ? Math.round((audioBytes * 8 * 1_000) / durationMs)
          : first.bitrateBps,
        bitrateMode: variableBitrate ? "variable" : "constant",
      },
    ],
  };
}

async function discardId3(reader: StreamBytes): Promise<void> {
  if (!(await reader.ensure(10))) throw new Mp3WindowFailure("unsupported_codec");
  const header = reader.view(10);
  if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return;
  const tagBytes = synchsafe(header, 6);
  if (tagBytes === null) throw new Mp3WindowFailure("unsupported_codec");
  const footerBytes = ((header[5] ?? 0) & 0x10) === 0 ? 0 : 10;
  let remaining = 10 + tagBytes + footerBytes;
  while (remaining > 0) {
    if (!(await reader.ensure(1))) throw new Mp3WindowFailure("unsupported_codec");
    const selected = Math.min(remaining, reader.available);
    reader.discard(selected);
    remaining -= selected;
  }
}

function joinBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Select a target-duration MP3 window using complete source frames only. */
export async function readMp3FrameWindow(
  stream: ReadableStream<Uint8Array>,
  sourceDurationMs: number,
  variant: "primary" | "alternate",
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Mp3FrameWindow> {
  const window = mediaTransformSampleWindow(sourceDurationMs, variant);
  const reader = new StreamBytes(stream, signal);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let elapsedMs = 0;
  let selectedOffsetMs: number | null = null;
  let selectedDurationMs = 0;
  let expected: Pick<Mp3Frame, "channels" | "sampleRateHz" | "version"> | null = null;
  let completed = false;
  try {
    await discardId3(reader);
    let scanned = 0;
    while (true) {
      if (!(await reader.ensure(4))) throw new Mp3WindowFailure("unsupported_codec");
      if (parseMp3Frame(reader.view(4)) !== null) break;
      reader.discard(1);
      scanned += 1;
      if (scanned > MAXIMUM_INITIAL_SCAN_BYTES) {
        throw new Mp3WindowFailure("unsupported_codec");
      }
    }

    while (true) {
      if (!(await reader.ensure(4))) throw new Mp3WindowFailure("inconsistent_media_facts");
      const frame = parseMp3Frame(reader.view(4));
      if (frame === null) throw new Mp3WindowFailure("inconsistent_media_facts");
      if (
        expected !== null &&
        (frame.version !== expected.version ||
          frame.sampleRateHz !== expected.sampleRateHz ||
          frame.channels !== expected.channels)
      ) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      expected ??= frame;
      if (!(await reader.ensure(frame.byteLength))) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      const frameEndMs = elapsedMs + frame.durationMs;
      if (frameEndMs > window.offsetMs) {
        selectedOffsetMs ??= elapsedMs;
        byteLength += frame.byteLength;
        if (byteLength > maximumBytes) throw new Mp3WindowFailure("output_too_large");
        chunks.push(reader.take(frame.byteLength));
        selectedDurationMs += frame.durationMs;
        if (selectedDurationMs >= window.durationMs) {
          completed = true;
          await reader.cancel("sample_complete");
          return {
            bytes: joinBytes(chunks, byteLength),
            durationMs: Math.round(selectedDurationMs),
            offsetMs: Math.round(selectedOffsetMs),
          };
        }
      } else {
        reader.discard(frame.byteLength);
      }
      elapsedMs = frameEndMs;
    }
  } finally {
    if (!completed) await reader.cancel("sample_failed");
    reader.release();
  }
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Mp3TransformInput = MediaTransformProbeInput | MediaTransformAudioSampleInput;

function acceptedAttempt(
  input: Mp3TransformInput,
  kind: "probe" | "sample",
): MediaTransformAcceptedAttempt {
  return {
    version: "media-transform-attempt-v1",
    runtimeFence: input.attempt.runtimeFence,
    providerJobId: `r2-mp3-${kind}-${input.binding.requestId}`,
  };
}

function context(input: Mp3TransformInput): MediaTransformAttemptContext {
  return {
    version: "media-transform-attempt-context-v1",
    operationId: input.binding.operationId,
    audioRevision: input.binding.audioRevision,
    analysisRevision: input.binding.analysisRevision,
    canonicalAudioSha256: input.binding.canonicalAudioSha256,
    requestId: input.binding.requestId,
    adapterRevision: ADAPTER_REVISION,
  };
}

function invalidProbeInput(input: MediaTransformProbeInput): MediaTransformRequestInvalid | null {
  const { binding, attempt } = input;
  if (input.version !== "media-transform-probe-input-v1") {
    return new MediaTransformRequestInvalid({ reason: "invalid_input_version" });
  }
  if (
    !SAFE_ID.test(binding.operationId) ||
    !SAFE_ID.test(binding.requestId) ||
    !Number.isSafeInteger(binding.audioRevision) ||
    binding.audioRevision < 1 ||
    !Number.isSafeInteger(binding.analysisRevision) ||
    binding.analysisRevision < 0 ||
    !SHA256.test(binding.canonicalAudioSha256)
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_binding" });
  }
  if (
    input.source.objectKey.length < 1 ||
    input.source.objectKey.length > 1_024 ||
    input.source.objectKey.startsWith("/") ||
    input.source.objectKey.includes("\\") ||
    input.source.objectKey.split("/").includes("..")
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_source" });
  }
  if (
    attempt.version !== "media-transform-attempt-v1" ||
    !Number.isSafeInteger(attempt.runtimeFence.submittedAtMs) ||
    !Number.isSafeInteger(attempt.runtimeFence.runtimeDeadlineMs) ||
    attempt.runtimeFence.runtimeDeadlineMs <= attempt.runtimeFence.submittedAtMs
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_runtime_fence" });
  }
  const expectedJobId = `r2-mp3-probe-${binding.requestId}`;
  if (attempt.providerJobId !== undefined && attempt.providerJobId !== expectedJobId) {
    return new MediaTransformRequestInvalid({ reason: "invalid_job_id" });
  }
  return null;
}

function invalidInput(input: MediaTransformAudioSampleInput): MediaTransformRequestInvalid | null {
  const { binding, attempt } = input;
  if (input.version !== "media-transform-audio-sample-input-v1") {
    return new MediaTransformRequestInvalid({ reason: "invalid_input_version" });
  }
  if (
    !SAFE_ID.test(binding.operationId) ||
    !SAFE_ID.test(binding.requestId) ||
    !Number.isSafeInteger(binding.audioRevision) ||
    binding.audioRevision < 1 ||
    !Number.isSafeInteger(binding.analysisRevision) ||
    binding.analysisRevision < 0 ||
    !SHA256.test(binding.canonicalAudioSha256)
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_binding" });
  }
  if (
    input.source.objectKey.length < 1 ||
    input.source.objectKey.length > 1_024 ||
    input.source.objectKey.startsWith("/") ||
    input.source.objectKey.includes("\\") ||
    input.source.objectKey.split("/").includes("..")
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_source" });
  }
  if (
    !Number.isSafeInteger(input.sourceDurationMs) ||
    input.sourceDurationMs < 1 ||
    input.sourceDurationMs > MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_source_duration" });
  }
  if (input.variant !== "primary" && input.variant !== "alternate") {
    return new MediaTransformRequestInvalid({ reason: "invalid_variant" });
  }
  if (
    attempt.version !== "media-transform-attempt-v1" ||
    !Number.isSafeInteger(attempt.runtimeFence.submittedAtMs) ||
    !Number.isSafeInteger(attempt.runtimeFence.runtimeDeadlineMs) ||
    attempt.runtimeFence.runtimeDeadlineMs <= attempt.runtimeFence.submittedAtMs
  ) {
    return new MediaTransformRequestInvalid({ reason: "invalid_runtime_fence" });
  }
  const expectedJobId = `r2-mp3-sample-${binding.requestId}`;
  if (attempt.providerJobId !== undefined && attempt.providerJobId !== expectedJobId) {
    return new MediaTransformRequestInvalid({ reason: "invalid_job_id" });
  }
  return null;
}

function sameObject(expected: R2Object, actual: R2Object): boolean {
  return (
    expected.key === actual.key &&
    expected.version === actual.version &&
    expected.etag === actual.etag &&
    expected.size === actual.size &&
    expected.httpMetadata?.contentType === actual.httpMetadata?.contentType
  );
}

function hasBody(value: R2Object | R2ObjectBody): value is R2ObjectBody {
  return "body" in value && value.body instanceof ReadableStream;
}

function outputObjectKey(input: MediaTransformAudioSampleInput): string {
  return [
    "media-transform",
    input.binding.operationId,
    `audio-r${input.binding.audioRevision}`,
    `analysis-r${input.binding.analysisRevision}`,
    input.binding.requestId,
    `${input.variant}.mp3`,
  ].join("/");
}

function retainedObjectMatches(
  object: R2Object,
  input: MediaTransformAudioSampleInput,
  source: R2Object,
  window: Mp3FrameWindow,
  sampleSha256: string,
): boolean {
  const metadata = object.customMetadata ?? {};
  return (
    object.size === window.bytes.byteLength &&
    object.httpMetadata?.contentType === AUDIO_MPEG &&
    metadata["adapter-revision"] === ADAPTER_REVISION &&
    metadata["canonical-audio-sha256"] === input.binding.canonicalAudioSha256 &&
    metadata["source-key"] === source.key &&
    metadata["source-version"] === source.version &&
    metadata["source-etag"] === source.etag &&
    metadata["sample-sha256"] === sampleSha256 &&
    metadata["sample-variant"] === input.variant
  );
}

async function probeFromR2(
  input: MediaTransformProbeInput,
  originals: R2Bucket,
): Promise<MediaTransformProbeOutcome> {
  const base = { attempt: acceptedAttempt(input, "probe"), context: context(input) } as const;
  let source: R2Object | null;
  try {
    source = await originals.head(input.source.objectKey);
  } catch {
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  if (
    source === null ||
    source.size < 1 ||
    source.size > MAXIMUM_SOURCE_BYTES ||
    source.httpMetadata?.contentType !== AUDIO_MPEG
  ) {
    return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
  }
  const storedSha256 = source.checksums.sha256;
  if (
    storedSha256 !== undefined &&
    bytesToHex(storedSha256) !== input.binding.canonicalAudioSha256
  ) {
    return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
  }
  let selected: R2Object | R2ObjectBody | null;
  try {
    selected = await originals.get(input.source.objectKey, {
      onlyIf: { etagMatches: source.etag },
    });
  } catch {
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  if (selected === null || !hasBody(selected) || !sameObject(source, selected)) {
    if (selected !== null && hasBody(selected)) void selected.body.cancel("object_changed");
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  try {
    return {
      ...base,
      status: "completed",
      probe: await readMp3Probe(
        selected.body,
        MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS,
        input.signal ?? new AbortController().signal,
      ),
    };
  } catch (error) {
    if (!(error instanceof Mp3WindowFailure)) {
      return { ...base, status: "retryable_failure", reason: "transport" };
    }
    if (error.reason === "duration_exceeded") {
      return { ...base, status: "rejected", reason: "duration_exceeded" };
    }
    if (error.reason === "unsupported_codec") {
      return { ...base, status: "rejected", reason: "unsupported_codec" };
    }
    if (error.reason === "inconsistent_media_facts") {
      return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
    }
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
}

async function sampleFromR2(
  input: MediaTransformAudioSampleInput,
  originals: R2Bucket,
  derived: R2Bucket,
  maximumSampleBytes: number,
): Promise<MediaTransformAudioSampleOutcome> {
  const base = { attempt: acceptedAttempt(input, "sample"), context: context(input) } as const;
  let source: R2Object | null;
  try {
    source = await originals.head(input.source.objectKey);
  } catch {
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  if (
    source === null ||
    source.size < 1 ||
    source.size > MAXIMUM_SOURCE_BYTES ||
    source.httpMetadata?.contentType !== AUDIO_MPEG
  ) {
    return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
  }
  const storedSha256 = source.checksums.sha256;
  if (
    storedSha256 !== undefined &&
    bytesToHex(storedSha256) !== input.binding.canonicalAudioSha256
  ) {
    return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
  }
  let selected: R2Object | R2ObjectBody | null;
  try {
    selected = await originals.get(input.source.objectKey, {
      onlyIf: { etagMatches: source.etag },
    });
  } catch {
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  if (selected === null || !hasBody(selected) || !sameObject(source, selected)) {
    if (selected !== null && hasBody(selected)) void selected.body.cancel("object_changed");
    return { ...base, status: "retryable_failure", reason: "transport" };
  }

  let window: Mp3FrameWindow;
  try {
    window = await readMp3FrameWindow(
      selected.body,
      input.sourceDurationMs,
      input.variant,
      maximumSampleBytes,
      input.signal ?? new AbortController().signal,
    );
  } catch (error) {
    if (!(error instanceof Mp3WindowFailure)) {
      return { ...base, status: "retryable_failure", reason: "transport" };
    }
    if (error.reason === "output_too_large") {
      return { ...base, status: "rejected", reason: "output_too_large" };
    }
    if (error.reason === "unsupported_codec") {
      return { ...base, status: "rejected", reason: "unsupported_codec" };
    }
    if (error.reason === "inconsistent_media_facts") {
      return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
    }
    return { ...base, status: "retryable_failure", reason: "transport" };
  }

  const key = outputObjectKey(input);
  const sampleSha256 = bytesToHex(await crypto.subtle.digest("SHA-256", window.bytes));
  const customMetadata = {
    "adapter-revision": ADAPTER_REVISION,
    "canonical-audio-sha256": input.binding.canonicalAudioSha256,
    "source-key": source.key,
    "source-version": source.version,
    "source-etag": source.etag,
    "sample-sha256": sampleSha256,
    "sample-variant": input.variant,
  };
  let written: R2Object | null;
  try {
    written = await derived.put(key, window.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: AUDIO_MPEG },
      customMetadata,
      sha256: sampleSha256,
    });
  } catch {
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  let observed: R2Object | null;
  try {
    observed = await derived.head(key);
  } catch {
    return { ...base, status: "retryable_failure", reason: "transport" };
  }
  if (
    observed === null ||
    !retainedObjectMatches(observed, input, source, window, sampleSha256) ||
    (written !== null && !sameObject(written, observed))
  ) {
    return { ...base, status: "rejected", reason: "inconsistent_media_facts" };
  }
  return {
    ...base,
    status: "completed",
    artifact: {
      version: "media-transform-sample-artifact-v1",
      objectKey: key,
      contentType: AUDIO_MPEG,
      byteLength: window.bytes.byteLength,
      offsetMs: window.offsetMs,
      durationMs: window.durationMs,
      variant: input.variant,
      retainedObjectVerification: "required",
    },
  };
}

export function makeR2Mp3SampleMediaTransform(
  input: Readonly<{
    readonly providerTransform: MediaTransformService;
    readonly immutableOriginals: R2Bucket;
    readonly derivedArtifacts: R2Bucket;
    readonly maximumSampleBytes: number;
  }>,
): MediaTransformService {
  if (
    !Number.isSafeInteger(input.maximumSampleBytes) ||
    input.maximumSampleBytes < 1 ||
    input.maximumSampleBytes > 5_000_000
  ) {
    throw new MediaTransformRequestInvalid({ reason: "invalid_limits" });
  }
  return {
    probe: (request) =>
      Effect.suspend(() => {
        const invalid = invalidProbeInput(request);
        if (invalid !== null) return Effect.fail(invalid);
        return Effect.promise(() => probeFromR2(request, input.immutableOriginals));
      }),
    extractAudioSample: (request) =>
      Effect.suspend(() => {
        const invalid = invalidInput(request);
        if (invalid !== null) return Effect.fail(invalid);
        return Effect.promise(() =>
          sampleFromR2(
            request,
            input.immutableOriginals,
            input.derivedArtifacts,
            input.maximumSampleBytes,
          ),
        );
      }),
    extractCanonicalAudioSegment: input.providerTransform.extractCanonicalAudioSegment,
    alignVideoSoundtrackToSong: input.providerTransform.alignVideoSoundtrackToSong,
    cancelAssembly: input.providerTransform.cancelAssembly,
  };
}

export const MEDIA_MP3_SAMPLE_ADAPTER_REVISION = ADAPTER_REVISION;
