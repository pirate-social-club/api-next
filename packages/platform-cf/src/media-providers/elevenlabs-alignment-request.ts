import { Predicate } from "effect";
import {
  ELEVENLABS_ALIGNMENT_ADAPTER_REVISION,
  ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_RESPONSE_BYTES,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TIMEOUT_MS,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TIMING_MS,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TIMINGS,
  ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES,
  ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY,
  type ElevenLabsAlignmentAudioRevision,
  type ElevenLabsAlignmentContext,
  type ElevenLabsAlignmentInput,
  type ElevenLabsAlignmentLimits,
  type ElevenLabsAlignmentOutcome,
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
  if (!(input.audio.bytes instanceof Uint8Array) || input.audio.bytes.byteLength === 0) {
    return permanent("invalid_request");
  }
  if (input.audio.bytes.byteLength > limits.max_audio_bytes) return permanent("invalid_request");
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

function multipartPart(
  boundary: string,
  headers: readonly string[],
  value: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\n${headers.join("\r\n")}\r\n\r\n`);
  const suffix = encoder.encode("\r\n");
  const result = new Uint8Array(prefix.byteLength + value.byteLength + suffix.byteLength);
  result.set(prefix, 0);
  result.set(value, prefix.byteLength);
  result.set(suffix, prefix.byteLength + value.byteLength);
  return result;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
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

/** Encodes the exact request body used by the adapter and fake transports. */
export function encodeElevenLabsAlignmentMultipart(
  input: Readonly<{
    readonly audio: ElevenLabsAlignmentAudioRevision;
    readonly transcript: string;
  }>,
): Uint8Array | null {
  const encoder = new TextEncoder();
  const filename = input.audio.filename ?? "alignment-audio.bin";
  const transcriptBytes = encoder.encode(input.transcript);
  const boundaryBytes = encoder.encode(ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY);
  if (
    containsBytes(input.audio.bytes, boundaryBytes) ||
    containsBytes(transcriptBytes, boundaryBytes)
  ) {
    return null;
  }
  const audio = multipartPart(
    ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY,
    [
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${input.audio.mime_type}`,
    ],
    input.audio.bytes,
  );
  const text = multipartPart(
    ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY,
    ['Content-Disposition: form-data; name="text"'],
    transcriptBytes,
  );
  const closing = encoder.encode(`--${ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY}--\r\n`);
  const body = concatBytes([audio, text, closing]);
  return body.byteLength <= ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES ? body : null;
}
