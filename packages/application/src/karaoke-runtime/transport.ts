import type { KaraokeLineScore, KaraokeRecognizedWord, KaraokeSessionSummary } from "./scoring";

export const KARAOKE_TRANSPORT_PROTOCOL_VERSION = 1 as const;

export interface KaraokeTransportEnvelope {
  protocolVersion: typeof KARAOKE_TRANSPORT_PROTOCOL_VERSION;
  sessionId: string;
  attemptId: string;
  sequence: number;
}

export interface KaraokeLineIdentity {
  lineId: string;
  lineIndex: number;
  scoredLineIndex: number;
}

export type KaraokeClientEvent = KaraokeTransportEnvelope &
  (
    | { type: "start"; postId: string; startedAtAudioMs: number }
    | { type: "playback_sync"; audioTimeMs: number; playing: boolean }
    | { type: "pause"; audioTimeMs: number }
    | { type: "resume"; audioTimeMs: number }
    | { type: "seek"; audioTimeMs: number }
    | ({ type: "line_boundary"; audioTimeMs: number } & KaraokeLineIdentity)
    | { type: "finish"; audioTimeMs: number }
    | { type: "abort"; code: string }
  );

export type KaraokeClientBinaryFrame = KaraokeTransportEnvelope & {
  type: "audio_chunk";
  chunkId: number;
  pcm16: ArrayBuffer;
  sampleRate: 16000;
  songStartMs: number;
  songEndMs: number;
};

export type KaraokeStreamingSttEvent = KaraokeTransportEnvelope &
  (
    | {
        type: "stt_partial";
        deliveredAtAudioMs: number;
        text: string;
        words: KaraokeRecognizedWord[];
      }
    | {
        type: "stt_final";
        deliveredAtAudioMs: number;
        text: string;
        words: KaraokeRecognizedWord[];
      }
  );

export type KaraokeServerEvent = KaraokeTransportEnvelope & { eventId: string } & (
    | { type: "stt_partial"; text: string; words: KaraokeRecognizedWord[] }
    | { type: "stt_final"; text: string; words: KaraokeRecognizedWord[] }
    | { type: "line_score"; result: KaraokeLineScore }
    | { type: "summary"; summary: KaraokeSessionSummary }
    | { type: "session_error"; code: string; message?: string }
  );

export type KaraokeTransportErrorCode =
  | "binary_invalid_sample_rate"
  | "binary_magic_mismatch"
  | "binary_odd_pcm_length"
  | "binary_oversized_frame"
  | "binary_truncated"
  | "binary_unknown_flags"
  | "binary_version_mismatch"
  | "invalid_event_payload"
  | "unsupported_protocol_version"
  | "session_identity_mismatch"
  | "non_monotonic_sequence"
  | "line_identity_mismatch"
  | "stt_adapter_start_failed"
  | "karaoke_scoring_disabled"
  | "session_not_recording"
  | "session_aborted";

export interface KaraokeTransportError {
  code: KaraokeTransportErrorCode;
  message: string;
  sequence?: number;
}

function invalidPayload(message: string, sequence?: number): KaraokeTransportError {
  return { code: "invalid_event_payload", message, sequence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateEnvelopeShape(value: Record<string, unknown>): KaraokeTransportError | null {
  const sequence = typeof value.sequence === "number" ? value.sequence : undefined;
  if (value.protocolVersion !== KARAOKE_TRANSPORT_PROTOCOL_VERSION) {
    return invalidPayload("protocolVersion must be 1", sequence);
  }
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    return invalidPayload("sessionId must be a non-empty string", sequence);
  }
  if (typeof value.attemptId !== "string" || !value.attemptId) {
    return invalidPayload("attemptId must be a non-empty string", sequence);
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    return invalidPayload("sequence must be a non-negative safe integer", sequence);
  }
  return null;
}

function validateWords(value: unknown, sequence?: number): KaraokeTransportError | null {
  if (!Array.isArray(value)) return invalidPayload("words must be an array", sequence);
  for (const word of value) {
    if (!isRecord(word) || typeof word.text !== "string") {
      return invalidPayload("each recognized word must contain text", sequence);
    }
    if (
      !isFiniteNonNegative(word.startMs) ||
      !isFiniteNonNegative(word.endMs) ||
      word.endMs < word.startMs
    ) {
      return invalidPayload("recognized word timing must be a valid non-negative range", sequence);
    }
    if (
      word.confidence !== undefined &&
      word.confidence !== null &&
      typeof word.confidence !== "number"
    ) {
      return invalidPayload("recognized word confidence must be numeric or null", sequence);
    }
  }
  return null;
}

export function validateKaraokeClientEventPayload(value: unknown): KaraokeTransportError | null {
  if (!isRecord(value)) return invalidPayload("client event must be an object");
  const envelopeError = validateEnvelopeShape(value);
  if (envelopeError) return envelopeError;
  const sequence = value.sequence as number;
  const audioTimeValid = () => isFiniteNonNegative(value.audioTimeMs);
  switch (value.type) {
    case "start":
      return typeof value.postId === "string" &&
        value.postId.length > 0 &&
        isFiniteNonNegative(value.startedAtAudioMs)
        ? null
        : invalidPayload("start requires postId and startedAtAudioMs", sequence);
    case "playback_sync":
      return audioTimeValid() && typeof value.playing === "boolean"
        ? null
        : invalidPayload("playback_sync requires audioTimeMs and playing", sequence);
    case "pause":
    case "resume":
    case "seek":
    case "finish":
      return audioTimeValid()
        ? null
        : invalidPayload(`${String(value.type)} requires audioTimeMs`, sequence);
    case "line_boundary":
      return audioTimeValid() &&
        typeof value.lineId === "string" &&
        value.lineId.length > 0 &&
        Number.isSafeInteger(value.lineIndex) &&
        (value.lineIndex as number) >= 0 &&
        Number.isSafeInteger(value.scoredLineIndex) &&
        (value.scoredLineIndex as number) >= 0
        ? null
        : invalidPayload("line_boundary requires complete line identity and audioTimeMs", sequence);
    case "abort":
      return typeof value.code === "string" && value.code.length > 0
        ? null
        : invalidPayload("abort requires a non-empty code", sequence);
    default:
      return invalidPayload("unknown karaoke client event type", sequence);
  }
}

export function validateKaraokeStreamingSttEventPayload(
  value: unknown,
): KaraokeTransportError | null {
  if (!isRecord(value)) return invalidPayload("STT event must be an object");
  const envelopeError = validateEnvelopeShape(value);
  if (envelopeError) return envelopeError;
  const sequence = value.sequence as number;
  if (value.type !== "stt_partial" && value.type !== "stt_final") {
    return invalidPayload("unknown STT event type", sequence);
  }
  if (!isFiniteNonNegative(value.deliveredAtAudioMs) || typeof value.text !== "string") {
    return invalidPayload("STT event requires deliveredAtAudioMs and text", sequence);
  }
  return validateWords(value.words, sequence);
}

export function parseKaraokeClientEvent(value: unknown): KaraokeClientEvent | null {
  return validateKaraokeClientEventPayload(value) ? null : (value as KaraokeClientEvent);
}

export function parseKaraokeStreamingSttEvent(value: unknown): KaraokeStreamingSttEvent | null {
  return validateKaraokeStreamingSttEventPayload(value)
    ? null
    : (value as KaraokeStreamingSttEvent);
}

export function validateKaraokeTransportEnvelope(input: {
  attemptId: string;
  event: KaraokeTransportEnvelope;
  lastSequence: number | null;
  sessionId: string;
}): KaraokeTransportError | null {
  if (input.event.protocolVersion !== KARAOKE_TRANSPORT_PROTOCOL_VERSION) {
    return {
      code: "unsupported_protocol_version",
      message: `Unsupported karaoke protocol version: ${input.event.protocolVersion}`,
      sequence: input.event.sequence,
    };
  }

  if (input.event.sessionId !== input.sessionId || input.event.attemptId !== input.attemptId) {
    return {
      code: "session_identity_mismatch",
      message: "Karaoke transport event does not belong to this session attempt",
      sequence: input.event.sequence,
    };
  }

  if (input.lastSequence !== null && input.event.sequence <= input.lastSequence) {
    return {
      code: "non_monotonic_sequence",
      message: `Karaoke transport sequence ${input.event.sequence} is not after ${input.lastSequence}`,
      sequence: input.event.sequence,
    };
  }

  return null;
}
