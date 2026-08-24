import { Predicate } from "effect";
import { unavailable } from "./elevenlabs-alignment-request.ts";
import type {
  ElevenLabsAlignmentContext,
  ElevenLabsAlignmentLimits,
  ElevenLabsAlignmentOutcome,
  ElevenLabsAlignmentTiming,
} from "./elevenlabs-alignment-types.ts";

function hasOnlyKeys(
  value: { readonly [key: PropertyKey]: unknown },
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function malformed(
  reason: "malformed_response" | "invalid_timing" | "oversized_response",
  context: ElevenLabsAlignmentContext,
): ElevenLabsAlignmentOutcome {
  return unavailable({
    status: "unavailable",
    alignment: "unavailable",
    outcome: "malformed",
    reason,
    context,
  });
}

function noSpeech(context: ElevenLabsAlignmentContext): ElevenLabsAlignmentOutcome {
  return unavailable({
    status: "unavailable",
    alignment: "unavailable",
    outcome: "no_speech",
    reason: "no_speech",
    context,
  });
}

function parseProviderTimings(
  response: unknown,
  transcript: string,
  context: ElevenLabsAlignmentContext,
  limits: ElevenLabsAlignmentLimits,
): ElevenLabsAlignmentOutcome {
  if (!Predicate.isObject(response)) return malformed("malformed_response", context);
  if (
    !hasOnlyKeys(response, [
      "characters",
      "character_start_times_seconds",
      "character_end_times_seconds",
      "words",
      "loss",
    ]) ||
    !Array.isArray(response.characters) ||
    !Array.isArray(response.character_start_times_seconds) ||
    !Array.isArray(response.character_end_times_seconds) ||
    !Array.isArray(response.words) ||
    !Predicate.isNumber(response.loss) ||
    !Number.isFinite(response.loss) ||
    response.loss < 0
  ) {
    return malformed("malformed_response", context);
  }
  const characters = response.characters;
  const characterStarts = response.character_start_times_seconds;
  const characterEnds = response.character_end_times_seconds;
  const words = response.words;
  if (
    characters.length !== characterStarts.length ||
    characters.length !== characterEnds.length ||
    characters.length > limits.max_timings ||
    words.length > limits.max_timings
  ) {
    return characters.length > limits.max_timings || words.length > limits.max_timings
      ? malformed("oversized_response", context)
      : malformed("malformed_response", context);
  }
  if (characters.length === 0 && words.length === 0) return noSpeech(context);
  if (characters.length === 0 || words.length === 0) {
    return malformed("malformed_response", context);
  }

  let receivedCharacters = "";
  let previousCharacterEndMs = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const text = characters[index];
    const start = characterStarts[index];
    const end = characterEnds[index];
    if (
      !Predicate.isString(text) ||
      text.length === 0 ||
      text.length > 4_096 ||
      !Predicate.isNumber(start) ||
      !Number.isFinite(start) ||
      !Predicate.isNumber(end) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    ) {
      return malformed("invalid_timing", context);
    }
    const startMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);
    if (end * 1000 > limits.max_timing_ms || endMs <= startMs || startMs < previousCharacterEndMs) {
      return malformed("invalid_timing", context);
    }
    previousCharacterEndMs = endMs;
    receivedCharacters += text;
  }

  const timings: ElevenLabsAlignmentTiming[] = [];
  let receivedWords = "";
  let previousWordEndMs = 0;
  let totalDurationMs = 0;
  for (const entry of words) {
    if (!Predicate.isObject(entry) || !hasOnlyKeys(entry, ["text", "start", "end"])) {
      return malformed("malformed_response", context);
    }
    if (!Predicate.isString(entry.text) || entry.text.length === 0 || entry.text.length > 4_096) {
      return malformed("malformed_response", context);
    }
    if (
      !Predicate.isNumber(entry.start) ||
      !Number.isFinite(entry.start) ||
      !Predicate.isNumber(entry.end) ||
      !Number.isFinite(entry.end) ||
      entry.start < 0 ||
      entry.end <= entry.start
    ) {
      return malformed("invalid_timing", context);
    }
    if (entry.end * 1000 > limits.max_timing_ms) return malformed("invalid_timing", context);
    const startMs = Math.round(entry.start * 1000);
    const endMs = Math.round(entry.end * 1000);
    if (endMs <= startMs || startMs < previousWordEndMs) {
      return malformed("invalid_timing", context);
    }
    const kind: "word" | "spacing" = /^\s+$/u.test(entry.text) ? "spacing" : "word";
    timings.push({ token_index: timings.length, start_ms: startMs, end_ms: endMs, kind });
    receivedWords += entry.text;
    previousWordEndMs = endMs;
    totalDurationMs = endMs;
  }

  if (totalDurationMs > limits.max_timing_ms) return malformed("invalid_timing", context);
  if (receivedCharacters !== transcript || receivedWords !== transcript) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "transcript_mismatch",
      reason: "transcript_mismatch",
      context,
      expected_text_length: transcript.length,
      received_text_length: receivedWords.length,
    });
  }
  return {
    status: "ready",
    alignment: "ready",
    outcome: "ready",
    context,
    mode: "word",
    timings,
  };
}

function headerValue(
  headers: Readonly<Record<string, string>> | Headers,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const expected = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === expected);
  return key === undefined ? null : (headers[key] ?? null);
}

function responseBytes(body: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
}

export function parseElevenLabsAlignmentResponse(
  input: Readonly<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>> | Headers;
    readonly body: Uint8Array | ArrayBuffer | string;
    readonly transcript: string;
    readonly context: ElevenLabsAlignmentContext;
    readonly limits: ElevenLabsAlignmentLimits;
  }>,
): ElevenLabsAlignmentOutcome {
  if (input.status === 429) {
    const retryAfterSeconds = retryAfter(headerValue(input.headers, "retry-after"));
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "retryable",
      reason: "rate_limited",
      context: input.context,
      provider_status: input.status,
      ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
    });
  }
  if (input.status === 408 || input.status === 425 || input.status >= 500) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "retryable",
      reason: "provider_unavailable",
      context: input.context,
      provider_status: input.status,
    });
  }
  if (input.status < 200 || input.status >= 300) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "permanent",
      reason: "provider_rejected",
      context: input.context,
      provider_status: input.status,
    });
  }
  const declaredLength = headerValue(input.headers, "content-length");
  if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
    return malformed("malformed_response", input.context);
  }
  if (declaredLength !== null && Number(declaredLength) > input.limits.max_response_bytes) {
    return malformed("oversized_response", input.context);
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(headerValue(input.headers, "content-type") ?? "")) {
    return malformed("malformed_response", input.context);
  }
  const bytes = responseBytes(input.body);
  if (bytes.byteLength > input.limits.max_response_bytes) {
    return malformed("oversized_response", input.context);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return malformed("malformed_response", input.context);
  }
  return parseProviderTimings(parsed, input.transcript, input.context, input.limits);
}
