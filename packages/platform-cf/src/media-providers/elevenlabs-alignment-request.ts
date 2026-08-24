import { Predicate } from "effect";
import {
  ELEVENLABS_ALIGNMENT_ADAPTER_REVISION,
  ELEVENLABS_ALIGNMENT_BOUNDARY_RANDOM_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_API_KEY_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_RESPONSE_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TIMEOUT_MS,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TIMING_MS,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TIMINGS,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES,
  ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY_PREFIX,
  type ElevenLabsAlignmentAudioRevision,
  type ElevenLabsAlignmentContext,
  type ElevenLabsAlignmentInput,
  type ElevenLabsAlignmentLimits,
  type ElevenLabsAlignmentOutcome,
  type ElevenLabsAlignmentRandomBytes,
  type ElevenLabsAlignmentRequestBody,
  type ElevenLabsAlignmentValidatedInput,
} from "./elevenlabs-alignment-types.ts";

export function unavailable<T extends ElevenLabsAlignmentOutcome>(outcome: T): T {
  return outcome;
}

export function permanent(
  reason: "invalid_request" | "provider_rejected" | "configuration",
  context?: ElevenLabsAlignmentContext,
  provider_status?: number,
): ElevenLabsAlignmentOutcome {
  return unavailable({
    status: "unavailable",
    alignment: "unavailable",
    outcome: "permanent",
    reason,
    ...(context === undefined ? {} : { context }),
    ...(provider_status === undefined ? {} : { provider_status }),
  });
}

export function retryable(
  reason: "rate_limited" | "provider_unavailable" | "transport",
  context?: ElevenLabsAlignmentContext,
  provider_status?: number,
  retry_after_seconds?: number,
): ElevenLabsAlignmentOutcome {
  return unavailable({
    status: "unavailable",
    alignment: "unavailable",
    outcome: "retryable",
    reason,
    ...(context === undefined ? {} : { context }),
    ...(provider_status === undefined ? {} : { provider_status }),
    ...(retry_after_seconds === undefined ? {} : { retry_after_seconds }),
  });
}

function safeIdentifier(value: unknown, maximum: number): value is string {
  return (
    Predicate.isString(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
    })
  );
}

/** API keys are opaque, visible ASCII header values and never carry whitespace. */
export function validateApiKey(value: unknown): value is string {
  if (!Predicate.isString(value)) return false;
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.byteLength > 0 &&
    bytes.byteLength <= ELEVENLABS_ALIGNMENT_HARD_MAX_API_KEY_BYTES &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e;
    })
  );
}

function contextFor(input: ElevenLabsAlignmentInput): ElevenLabsAlignmentContext {
  return {
    operation_id: input.operation_id,
    post_id: input.post_id,
    audio_revision: input.audio.audio_revision,
    analysis_revision: input.transcript.analysis_revision,
    canonical_audio_sha256: input.audio.canonical_audio_sha256,
    transcript_artifact_ref: input.transcript.artifact_ref,
    adapter_revision: ELEVENLABS_ALIGNMENT_ADAPTER_REVISION,
  };
}

export function validateLimits(
  limits: ElevenLabsAlignmentLimits | undefined,
): limits is ElevenLabsAlignmentLimits {
  if (limits === undefined || !Predicate.isObject(limits)) return false;
  return (
    Predicate.isNumber(limits.max_audio_bytes) &&
    Number.isSafeInteger(limits.max_audio_bytes) &&
    limits.max_audio_bytes > 0 &&
    limits.max_audio_bytes <= ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES &&
    Predicate.isNumber(limits.max_transcript_bytes) &&
    Number.isSafeInteger(limits.max_transcript_bytes) &&
    limits.max_transcript_bytes > 0 &&
    limits.max_transcript_bytes <= ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES &&
    Predicate.isNumber(limits.timeout_ms) &&
    Number.isSafeInteger(limits.timeout_ms) &&
    limits.timeout_ms > 0 &&
    limits.timeout_ms <= ELEVENLABS_ALIGNMENT_HARD_MAX_TIMEOUT_MS &&
    Predicate.isNumber(limits.max_response_bytes) &&
    Number.isSafeInteger(limits.max_response_bytes) &&
    limits.max_response_bytes > 0 &&
    limits.max_response_bytes <= ELEVENLABS_ALIGNMENT_HARD_MAX_RESPONSE_BYTES &&
    Predicate.isNumber(limits.max_timings) &&
    Number.isSafeInteger(limits.max_timings) &&
    limits.max_timings > 0 &&
    limits.max_timings <= ELEVENLABS_ALIGNMENT_HARD_MAX_TIMINGS &&
    Predicate.isNumber(limits.max_timing_ms) &&
    Number.isSafeInteger(limits.max_timing_ms) &&
    limits.max_timing_ms > 0 &&
    limits.max_timing_ms <= ELEVENLABS_ALIGNMENT_HARD_MAX_TIMING_MS
  );
}

export function validateInput(
  input: ElevenLabsAlignmentInput,
  limits: ElevenLabsAlignmentLimits,
): ElevenLabsAlignmentValidatedInput | ElevenLabsAlignmentOutcome {
  if (
    !Predicate.isObject(input) ||
    !Predicate.isObject(input.audio) ||
    !Predicate.isObject(input.audio.source) ||
    !Predicate.isFunction(input.audio.source.open) ||
    !Predicate.isObject(input.transcript)
  ) {
    return permanent("invalid_request");
  }
  if (!safeIdentifier(input.request_id, 128)) return permanent("invalid_request");
  if (!safeIdentifier(input.operation_id, 128) || !safeIdentifier(input.post_id, 128)) {
    return permanent("invalid_request");
  }
  if (
    !Predicate.isNumber(input.audio.audio_revision) ||
    !Number.isSafeInteger(input.audio.audio_revision) ||
    input.audio.audio_revision <= 0
  ) {
    return permanent("invalid_request");
  }
  if (
    !Predicate.isString(input.audio.canonical_audio_sha256) ||
    !/^[0-9a-f]{64}$/u.test(input.audio.canonical_audio_sha256)
  ) {
    return permanent("invalid_request");
  }
  if (
    !Predicate.isNumber(input.audio.source.byteLength) ||
    !Number.isSafeInteger(input.audio.source.byteLength) ||
    input.audio.source.byteLength <= 0
  ) {
    return permanent("invalid_request");
  }
  if (input.audio.source.byteLength > limits.max_audio_bytes) return permanent("invalid_request");
  if (
    !Predicate.isString(input.audio.mime_type) ||
    input.audio.mime_type.length > 128 ||
    !/^audio\/[a-z0-9][a-z0-9.+-]*$/u.test(input.audio.mime_type)
  ) {
    return permanent("invalid_request");
  }
  if (
    input.audio.filename !== undefined &&
    (!safeIdentifier(input.audio.filename, 128) ||
      input.audio.filename.includes("/") ||
      input.audio.filename.includes("\\") ||
      input.audio.filename.includes('"'))
  ) {
    return permanent("invalid_request");
  }
  if (!safeIdentifier(input.transcript.artifact_ref, 512)) return permanent("invalid_request");
  if (!safeIdentifier(input.transcript.operation_id, 128)) return permanent("invalid_request");
  if (
    input.transcript.operation_id !== input.operation_id ||
    input.transcript.audio_revision !== input.audio.audio_revision ||
    input.transcript.canonical_audio_sha256 !== input.audio.canonical_audio_sha256 ||
    !Predicate.isNumber(input.transcript.analysis_revision) ||
    !Number.isSafeInteger(input.transcript.analysis_revision) ||
    input.transcript.analysis_revision <= 0
  ) {
    return permanent("invalid_request");
  }
  if (!Predicate.isString(input.transcript.transcript)) return permanent("invalid_request");
  const transcriptBytes = new TextEncoder().encode(input.transcript.transcript);
  if (transcriptBytes.byteLength > limits.max_transcript_bytes) return permanent("invalid_request");

  return { input, context: contextFor(input) };
}

export class ElevenLabsAlignmentBodyError extends Error {
  readonly reason: "boundary_collision" | "audio_length_mismatch" | "invalid_audio_chunk";

  constructor(reason: ElevenLabsAlignmentBodyError["reason"]) {
    super(reason);
    this.name = "ElevenLabsAlignmentBodyError";
    this.reason = reason;
  }
}

function cryptographicRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function makeBoundary(randomBytes: ElevenLabsAlignmentRandomBytes): string | null {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(ELEVENLABS_ALIGNMENT_BOUNDARY_RANDOM_BYTES);
  } catch {
    return null;
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== ELEVENLABS_ALIGNMENT_BOUNDARY_RANDOM_BYTES
  ) {
    return null;
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY_PREFIX}${hex}`;
}

function prefixTable(pattern: Uint8Array): Uint32Array {
  const table = new Uint32Array(pattern.byteLength);
  for (let index = 1, matched = 0; index < pattern.byteLength; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = table[matched - 1] ?? 0;
    if (pattern[index] === pattern[matched]) matched += 1;
    table[index] = matched;
  }
  return table;
}

function hasBoundary(
  chunk: Uint8Array,
  boundary: Uint8Array,
  table: Uint32Array,
  startingMatch: number,
): { readonly collision: boolean; readonly match: number } {
  let matched = startingMatch;
  for (const byte of chunk) {
    while (matched > 0 && byte !== boundary[matched]) matched = table[matched - 1] ?? 0;
    if (byte === boundary[matched]) matched += 1;
    if (matched === boundary.byteLength) return { collision: true, match: matched };
  }
  return { collision: false, match: matched };
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

function multipartHeader(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Builds a replayable chunked body without copying the caller's audio. */
export function encodeElevenLabsAlignmentMultipart(
  input: Readonly<{
    readonly audio: ElevenLabsAlignmentAudioRevision;
    readonly transcript: string;
    readonly random_bytes?: ElevenLabsAlignmentRandomBytes;
  }>,
): ElevenLabsAlignmentRequestBody | null {
  if (
    !Predicate.isObject(input) ||
    !Predicate.isObject(input.audio) ||
    !Predicate.isObject(input.audio.source) ||
    !Predicate.isFunction(input.audio.source.open) ||
    !Predicate.isString(input.transcript)
  ) {
    return null;
  }
  const source = Object.freeze({
    byteLength: input.audio.source.byteLength,
    open: input.audio.source.open,
  });
  const transcript = input.transcript;
  const randomBytes = input.random_bytes ?? cryptographicRandomBytes;
  const boundary = makeBoundary(randomBytes);
  if (boundary === null) return null;
  const encoder = new TextEncoder();
  const filename = input.audio.filename ?? "alignment-audio.bin";
  const transcriptBytes = encoder.encode(transcript);
  const boundaryBytes = encoder.encode(boundary);
  if (
    !Predicate.isNumber(source.byteLength) ||
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength <= 0 ||
    source.byteLength > ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES ||
    transcriptBytes.byteLength > ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES
  ) {
    return null;
  }
  if (containsBytes(transcriptBytes, boundaryBytes)) return null;

  const fileHeader = multipartHeader(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${input.audio.mime_type}\r\n\r\n`,
  );
  const fileSuffix = multipartHeader("\r\n");
  const textHeader = multipartHeader(
    `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n`,
  );
  const closing = multipartHeader(`\r\n--${boundary}--\r\n`);
  const byteLength =
    fileHeader.byteLength +
    source.byteLength +
    fileSuffix.byteLength +
    textHeader.byteLength +
    transcriptBytes.byteLength +
    closing.byteLength;
  if (byteLength > ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES) return null;

  return {
    byteLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
    open: async function* (signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      yield fileHeader;
      let actualAudioBytes = 0;
      const table = prefixTable(boundaryBytes);
      let boundaryMatch = 0;
      for await (const chunk of source.open(signal)) {
        if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
        if (!(chunk instanceof Uint8Array)) {
          throw new ElevenLabsAlignmentBodyError("invalid_audio_chunk");
        }
        actualAudioBytes += chunk.byteLength;
        if (actualAudioBytes > source.byteLength) {
          throw new ElevenLabsAlignmentBodyError("audio_length_mismatch");
        }
        const match = hasBoundary(chunk, boundaryBytes, table, boundaryMatch);
        if (match.collision) throw new ElevenLabsAlignmentBodyError("boundary_collision");
        boundaryMatch = match.match;
        yield chunk;
      }
      if (actualAudioBytes !== source.byteLength) {
        throw new ElevenLabsAlignmentBodyError("audio_length_mismatch");
      }
      yield fileSuffix;
      yield textHeader;
      yield transcriptBytes;
      yield closing;
    },
  };
}
