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
  if (Object.keys(response).length === 1 && response.status === "no_speech") {
    return noSpeech(context);
  }

  const hasWords = Object.hasOwn(response, "words");
  const hasCharacters = Object.hasOwn(response, "characters");
  if (hasWords === hasCharacters) return malformed("malformed_response", context);

  const mode: "word" | "character" = hasWords ? "word" : "character";
  let entries: unknown[];
  if (hasWords) {
    if (!hasOnlyKeys(response, ["words"]) || !Array.isArray(response.words)) {
      return malformed("malformed_response", context);
    }
    entries = response.words;
  } else if (
    Array.isArray(response.characters) &&
    response.characters.every((entry) => Predicate.isString(entry))
  ) {
    if (
      !hasOnlyKeys(response, [
        "characters",
        "character_start_times_seconds",
        "character_end_times_seconds",
      ])
    ) {
      return malformed("malformed_response", context);
    }
    const starts = response.character_start_times_seconds;
    const ends = response.character_end_times_seconds;
    if (
      !Array.isArray(starts) ||
      !Array.isArray(ends) ||
      response.characters.length !== starts.length ||
      response.characters.length !== ends.length
    ) {
      return malformed("malformed_response", context);
    }
    entries = response.characters.map((text, index) => ({
      text,
      start: starts[index],
      end: ends[index],
      type: "character",
    }));
  } else if (Array.isArray(response.characters)) {
    if (!hasOnlyKeys(response, ["characters"])) return malformed("malformed_response", context);
    entries = response.characters;
  } else {
    return malformed("malformed_response", context);
  }

  if (entries.length > limits.max_timings) return malformed("oversized_response", context);
  if (entries.length === 0) return noSpeech(context);

  const timings: ElevenLabsAlignmentTiming[] = [];
  const receivedParts: string[] = [];
  let previousEndMs = 0;
  let totalDurationMs = 0;
  for (const entry of entries) {
    if (
      !Predicate.isObject(entry) ||
      !hasOnlyKeys(entry, ["text", "start", "end", "type", "loss", "confidence"])
    ) {
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
    if (endMs <= startMs || startMs < previousEndMs) {
      return malformed("invalid_timing", context);
    }
    const kind: "word" | "character" | "spacing" =
      entry.type === "spacing" ? "spacing" : mode === "word" ? "word" : "character";
    if (
      entry.type !== undefined &&
      entry.type !== kind &&
      !(mode === "character" && entry.type === "word")
    ) {
      return malformed("malformed_response", context);
    }
    timings.push({ token_index: timings.length, start_ms: startMs, end_ms: endMs, kind });
    receivedParts.push(entry.text);
    previousEndMs = endMs;
    totalDurationMs = endMs;
  }

  if (totalDurationMs > limits.max_timing_ms) return malformed("invalid_timing", context);
  const received = receivedParts.join("");
  if (received !== transcript) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "transcript_mismatch",
      reason: "transcript_mismatch",
      context,
      expected_text_length: transcript.length,
      received_text_length: received.length,
    });
  }
  return {
    status: "ready",
    alignment: "ready",
    outcome: "ready",
    context,
    mode,
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
