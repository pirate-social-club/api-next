import { Predicate } from "effect";
import { unavailable } from "./elevenlabs-alignment-request.ts";
import type {
  ElevenLabsAlignmentContext,
  ElevenLabsAlignmentLimits,
  ElevenLabsAlignmentOutcome,
  ElevenLabsAlignmentResponseBody,
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

/** Official loss is a non-negative finite JSON number; it is never projected. */
function validLoss(value: unknown): value is number {
  return Predicate.isNumber(value) && Number.isFinite(value) && value >= 0;
}

function timingMilliseconds(
  start: unknown,
  end: unknown,
  previousEndMs: number,
  maxTimingMs: number,
): { readonly startMs: number; readonly endMs: number } | null {
  if (
    !Predicate.isNumber(start) ||
    !Number.isFinite(start) ||
    !Predicate.isNumber(end) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end * 1000 > maxTimingMs
  ) {
    return null;
  }
  const startMs = Math.round(start * 1000);
  const endMs = Math.round(end * 1000);
  return endMs > startMs && startMs >= previousEndMs ? { startMs, endMs } : null;
}

type AlignmentTextTiming = Readonly<{
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}>;

/** Words omit whitespace; bind their text and intervals to character spans in order. */
function wordsBindToCharacters(
  characters: readonly AlignmentTextTiming[],
  words: readonly AlignmentTextTiming[],
): boolean {
  const characterText = characters.map((character) => character.text).join("");
  const ranges: Array<Readonly<{ start: number; end: number; timing: AlignmentTextTiming }>> = [];
  let offset = 0;
  for (const character of characters) {
    const end = offset + character.text.length;
    ranges.push({ start: offset, end, timing: character });
    offset = end;
  }
  let cursor = 0;
  for (const word of words) {
    while (cursor < characterText.length && /\s/u.test(characterText[cursor] ?? "")) cursor += 1;
    if (!characterText.startsWith(word.text, cursor)) return false;
    const end = cursor + word.text.length;
    const covered = ranges.filter((range) => range.end > cursor && range.start < end);
    const first = covered[0];
    const last = covered.at(-1);
    if (
      first === undefined ||
      last === undefined ||
      word.startMs > first.timing.startMs ||
      word.endMs < last.timing.endMs
    ) {
      return false;
    }
    cursor = end;
  }
  while (cursor < characterText.length && /\s/u.test(characterText[cursor] ?? "")) cursor += 1;
  return cursor === characterText.length;
}

function parseProviderTimings(
  response: unknown,
  transcript: string,
  context: ElevenLabsAlignmentContext,
  limits: ElevenLabsAlignmentLimits,
): ElevenLabsAlignmentOutcome {
  if (!Predicate.isObject(response)) return malformed("malformed_response", context);
  if (
    !hasOnlyKeys(response, ["characters", "words", "loss"]) ||
    !Array.isArray(response.characters) ||
    !Array.isArray(response.words) ||
    !validLoss(response.loss)
  ) {
    return malformed("malformed_response", context);
  }

  const characters = response.characters;
  const words = response.words;
  if (characters.length > limits.max_timings || words.length > limits.max_timings) {
    return malformed("oversized_response", context);
  }
  if (characters.length === 0 && words.length === 0) {
    return transcript.length === 0 ? noSpeech(context) : malformed("malformed_response", context);
  }
  if (characters.length === 0) return malformed("malformed_response", context);

  const receivedCharacterParts: string[] = [];
  const characterTimings: ElevenLabsAlignmentTiming[] = [];
  const characterEntries: AlignmentTextTiming[] = [];
  let previousCharacterEndMs = 0;
  for (const [index, entry] of characters.entries()) {
    if (
      !Predicate.isObject(entry) ||
      !hasOnlyKeys(entry, ["text", "start", "end"]) ||
      !Predicate.isString(entry.text) ||
      entry.text.length === 0 ||
      entry.text.length > 4_096
    ) {
      return malformed("malformed_response", context);
    }
    const timing = timingMilliseconds(
      entry.start,
      entry.end,
      previousCharacterEndMs,
      limits.max_timing_ms,
    );
    if (timing === null) return malformed("invalid_timing", context);
    previousCharacterEndMs = timing.endMs;
    receivedCharacterParts.push(entry.text);
    characterEntries.push({ text: entry.text, startMs: timing.startMs, endMs: timing.endMs });
    characterTimings.push({
      token_index: index,
      start_ms: timing.startMs,
      end_ms: timing.endMs,
      kind: /^\s+$/u.test(entry.text) ? "spacing" : "character",
    });
  }

  const wordTimings: ElevenLabsAlignmentTiming[] = [];
  const wordEntries: AlignmentTextTiming[] = [];
  let previousWordEndMs = 0;
  for (const entry of words) {
    if (
      !Predicate.isObject(entry) ||
      !hasOnlyKeys(entry, ["text", "start", "end", "loss"]) ||
      !Predicate.isString(entry.text) ||
      entry.text.length === 0 ||
      entry.text.length > 4_096 ||
      !validLoss(entry.loss)
    ) {
      return malformed("malformed_response", context);
    }
    const timing = timingMilliseconds(
      entry.start,
      entry.end,
      previousWordEndMs,
      limits.max_timing_ms,
    );
    if (timing === null) return malformed("invalid_timing", context);
    previousWordEndMs = timing.endMs;
    wordEntries.push({ text: entry.text, startMs: timing.startMs, endMs: timing.endMs });
    wordTimings.push({
      token_index: wordTimings.length,
      start_ms: timing.startMs,
      end_ms: timing.endMs,
      kind: "word",
    });
  }

  const receivedCharacters = receivedCharacterParts.join("");
  if (receivedCharacters !== transcript) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "transcript_mismatch",
      reason: "transcript_mismatch",
      context,
      expected_text_length: transcript.length,
      received_text_length: receivedCharacters.length,
    });
  }

  const wordAlignmentProven =
    words.length > 0 && wordsBindToCharacters(characterEntries, wordEntries);
  return {
    status: "ready",
    alignment: "ready",
    outcome: "ready",
    context,
    mode: wordAlignmentProven ? "word" : "character",
    timings: wordAlignmentProven ? wordTimings : characterTimings,
  };
}

function headerValue(
  headers: Readonly<Record<string, string>> | Headers,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (!Predicate.isObject(headers)) return null;
  const expected = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === expected);
  return key === undefined ? null : Predicate.isString(headers[key]) ? headers[key] : null;
}

type ReadBodyResult =
  | Readonly<{ readonly kind: "ok"; readonly bytes: Uint8Array }>
  | Readonly<{ readonly kind: "oversized" }>
  | Readonly<{ readonly kind: "malformed" }>;

function cancelResponseBody(body: ElevenLabsAlignmentResponseBody, reason: unknown): void {
  try {
    void Promise.resolve(body.cancel(reason)).catch(() => undefined);
  } catch {
    // Cancellation is best effort; the adapter never exposes provider bytes.
  }
}

function closeResponseIterator(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const result = iterator.return?.();
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // The body cancellation path remains authoritative.
  }
}

async function readResponseBody(
  body: ElevenLabsAlignmentResponseBody,
  maximum: number,
  signal?: AbortSignal,
): Promise<ReadBodyResult> {
  if (!Predicate.isObject(body) || !Predicate.isFunction(body.open)) {
    return { kind: "malformed" };
  }
  let iterable: AsyncIterable<Uint8Array>;
  try {
    iterable = body.open(signal);
  } catch {
    cancelResponseBody(body, "malformed_response");
    return { kind: "malformed" };
  }
  if (!Predicate.isObject(iterable)) {
    cancelResponseBody(body, "malformed_response");
    return { kind: "malformed" };
  }
  let iteratorFactory: unknown;
  try {
    iteratorFactory = iterable[Symbol.asyncIterator];
  } catch {
    cancelResponseBody(body, "malformed_response");
    return { kind: "malformed" };
  }
  if (!Predicate.isFunction(iteratorFactory)) {
    cancelResponseBody(body, "malformed_response");
    return { kind: "malformed" };
  }
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = iteratorFactory.call(iterable);
  } catch {
    cancelResponseBody(body, "malformed_response");
    return { kind: "malformed" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelReason: unknown;
  let abortListener: (() => void) | undefined;
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new DOMException("cancelled", "AbortError"));
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) abortListener();
        });
  if (abortPromise !== undefined) void abortPromise.catch(() => undefined);
  try {
    while (true) {
      const next =
        abortPromise === undefined
          ? await iterator.next()
          : await Promise.race([iterator.next(), abortPromise]);
      if (next.done === true) break;
      const chunk = next.value;
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      if (!(chunk instanceof Uint8Array)) {
        cancelReason = "malformed_response";
        return { kind: "malformed" };
      }
      total += chunk.byteLength;
      if (total > maximum) {
        cancelReason = "oversized_response";
        return { kind: "oversized" };
      }
      chunks.push(chunk);
    }
  } catch {
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    cancelReason = "malformed_response";
    return { kind: "malformed" };
  } finally {
    if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
    if (cancelReason !== undefined || signal?.aborted) {
      cancelResponseBody(body, cancelReason ?? "cancelled");
      closeResponseIterator(iterator);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
}

export async function parseElevenLabsAlignmentResponse(
  input: Readonly<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>> | Headers;
    readonly body: ElevenLabsAlignmentResponseBody;
    readonly transcript: string;
    readonly context: ElevenLabsAlignmentContext;
    readonly limits: ElevenLabsAlignmentLimits;
    readonly signal?: AbortSignal;
  }>,
): Promise<ElevenLabsAlignmentOutcome> {
  if (input.status === 429) {
    cancelResponseBody(input.body, "provider_status");
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
    cancelResponseBody(input.body, "provider_status");
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
    cancelResponseBody(input.body, "provider_status");
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
    cancelResponseBody(input.body, "malformed_response");
    return malformed("malformed_response", input.context);
  }
  if (declaredLength !== null && Number(declaredLength) > input.limits.max_response_bytes) {
    cancelResponseBody(input.body, "oversized_response");
    return malformed("oversized_response", input.context);
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(headerValue(input.headers, "content-type") ?? "")) {
    cancelResponseBody(input.body, "malformed_response");
    return malformed("malformed_response", input.context);
  }
  const read = await readResponseBody(input.body, input.limits.max_response_bytes, input.signal);
  if (read.kind === "oversized") return malformed("oversized_response", input.context);
  if (read.kind === "malformed") return malformed("malformed_response", input.context);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  } catch {
    return malformed("malformed_response", input.context);
  }
  return parseProviderTimings(parsed, input.transcript, input.context, input.limits);
}
