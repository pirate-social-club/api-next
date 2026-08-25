import {
  MEDIA_TRANSCRIPT_MAX_DURATION_MS,
  MEDIA_TRANSCRIPT_MAX_LENGTH,
  MEDIA_TRANSCRIPT_SEGMENT_MAX_COUNT,
  MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH,
  type MediaDetectedLanguageEvidence,
  type MediaProviderFailureTag,
  type MediaTranscriptSegment,
} from "@pirate/application/media-provider-contracts";
import { Option, Predicate, Schema } from "effect";
import type {
  ElevenLabsAsrLimits,
  ElevenLabsAsrResponseBody,
  ElevenLabsAsrTransportResponse,
} from "./elevenlabs-asr-types.ts";
import { ELEVENLABS_ASR_HARD_MAX_PROVIDER_ENTRIES } from "./elevenlabs-asr-types.ts";

const PROVIDER_IDENTIFIER_MAX_BYTES = 256 as const;

const ProviderIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PROVIDER_IDENTIFIER_MAX_BYTES),
  Schema.makeFilter((value) =>
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= PROVIDER_IDENTIFIER_MAX_BYTES &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
    })
      ? undefined
      : "Expected a bounded provider identifier",
  ),
);

const ProviderLogProbability = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isFinite(value) && value <= 0
      ? undefined
      : "Expected a finite provider log probability no greater than zero",
  ),
);

const ProviderAudioDuration = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isFinite(value) && value >= 0 && value * 1_000 <= MEDIA_TRANSCRIPT_MAX_DURATION_MS
      ? undefined
      : "Expected a bounded provider audio duration",
  ),
);

const EmptyProviderCollection = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(0));

const ProviderWord = Schema.Struct({
  text: Schema.String,
  start: Schema.optional(Schema.NullOr(Schema.Number)),
  end: Schema.optional(Schema.NullOr(Schema.Number)),
  type: Schema.Literals(["word", "spacing", "audio_event"]),
  speaker_id: Schema.optional(Schema.NullOr(ProviderIdentifier)),
  logprob: ProviderLogProbability,
  characters: Schema.optional(Schema.NullOr(EmptyProviderCollection)),
  channel_index: Schema.optional(Schema.Null),
});

const ProviderResponse = Schema.Struct({
  language_code: Schema.String,
  language_probability: Schema.Number,
  text: Schema.String,
  words: Schema.Array(ProviderWord),
  channel_index: Schema.optional(Schema.Null),
  additional_formats: Schema.optional(Schema.NullOr(EmptyProviderCollection)),
  transcription_id: Schema.optional(Schema.NullOr(ProviderIdentifier)),
  entities: Schema.optional(Schema.NullOr(EmptyProviderCollection)),
  audio_duration_secs: Schema.optional(Schema.NullOr(ProviderAudioDuration)),
});

type ProviderResponseValue = Schema.Schema.Type<typeof ProviderResponse>;
type ProviderWordValue = Schema.Schema.Type<typeof ProviderWord>;

export type ElevenLabsAsrParsedResponse =
  | Readonly<{
      readonly kind: "transcript";
      readonly transcript: string;
      readonly segments: readonly MediaTranscriptSegment[];
      readonly detected_languages: readonly MediaDetectedLanguageEvidence[];
    }>
  | Readonly<{
      readonly kind: "no_speech";
      readonly evidence: Readonly<{
        readonly language_code: string;
        readonly language_probability: number;
        readonly text: string;
        readonly events: ReadonlyArray<
          Readonly<{
            readonly type: "audio_event";
            readonly text: string;
            readonly start_ms: number;
            readonly end_ms: number;
          }>
        >;
      }>;
    }>
  | Readonly<{ readonly kind: "failure"; readonly failure: MediaProviderFailureTag }>;

function headerValue(
  headers: Headers | Readonly<Record<string, string>>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (!Predicate.isObject(headers)) return null;
  const expected = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === expected);
  return key === undefined || !Predicate.isString(headers[key]) ? null : headers[key];
}

export function retryAfterMilliseconds(
  headers: Headers | Readonly<Record<string, string>>,
): number | undefined {
  const value = headerValue(headers, "retry-after")?.trim();
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const milliseconds = Math.round(Number(value) * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 120_000
    ? milliseconds
    : undefined;
}

export function failureForElevenLabsStatus(status: number): MediaProviderFailureTag | null {
  if (status >= 200 && status < 300) return null;
  if (status === 408 || status === 425 || status >= 500) return "provider_unavailable";
  if (status === 429) return "rate_limited";
  return "permanent_rejection";
}

async function cancelBody(body: ElevenLabsAsrResponseBody, reason: unknown): Promise<void> {
  try {
    await body.cancel(reason);
  } catch {
    // Provider bodies and provider errors are never exposed beyond this boundary.
  }
}

async function closeIterator(iterator: AsyncIterator<Uint8Array> | undefined): Promise<void> {
  try {
    await iterator?.return?.();
  } catch {
    // Body cancellation is still attempted independently by the caller.
  }
}

async function cleanupBody(
  body: ElevenLabsAsrResponseBody,
  iterator: AsyncIterator<Uint8Array> | undefined,
  reason: unknown,
): Promise<void> {
  await Promise.all([cancelBody(body, reason), closeIterator(iterator)]);
}

async function readBoundedBody(
  body: ElevenLabsAsrResponseBody,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!Predicate.isObject(body) || !Predicate.isFunction(body.open)) return null;
  let iterable: AsyncIterable<Uint8Array>;
  try {
    iterable = body.open(signal);
  } catch {
    await cancelBody(body, "body_open_failed");
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new DOMException("cancelled", "AbortError"));
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  void abortPromise.catch(() => undefined);
  try {
    iterator = iterable[Symbol.asyncIterator]();
    while (true) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      const next = await Promise.race([iterator.next(), abortPromise]);
      if (next.done === true) break;
      if (!(next.value instanceof Uint8Array)) {
        await cleanupBody(body, iterator, "invalid_response_chunk");
        return null;
      }
      total += next.value.byteLength;
      if (total > maximum) {
        await cleanupBody(body, iterator, "response_too_large");
        return null;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await cleanupBody(body, iterator, signal.aborted ? "cancelled" : "body_read_failed");
    if (signal.aborted) throw error;
    return null;
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function timing(
  entry: ProviderWordValue,
  allowAbsentOrZeroDuration: boolean,
):
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "timed"; readonly start_ms: number; readonly end_ms: number }>
  | null {
  const startAbsent = entry.start === undefined || entry.start === null;
  const endAbsent = entry.end === undefined || entry.end === null;
  if (startAbsent || endAbsent) {
    return allowAbsentOrZeroDuration && startAbsent === endAbsent ? { kind: "absent" } : null;
  }
  if (
    !Number.isFinite(entry.start) ||
    !Number.isFinite(entry.end) ||
    entry.start < 0 ||
    (allowAbsentOrZeroDuration ? entry.end < entry.start : entry.end <= entry.start) ||
    entry.end * 1_000 > MEDIA_TRANSCRIPT_MAX_DURATION_MS
  ) {
    return null;
  }
  const start_ms = Math.round(entry.start * 1_000);
  const end_ms = Math.round(entry.end * 1_000);
  return allowAbsentOrZeroDuration
    ? end_ms >= start_ms
      ? { kind: "timed", start_ms, end_ms }
      : null
    : end_ms > start_ms
      ? { kind: "timed", start_ms, end_ms }
      : null;
}

function appendSegment(
  segments: MediaTranscriptSegment[],
  textParts: string[],
  start_ms: number | undefined,
  end_ms: number | undefined,
): boolean {
  const text = textParts.join("");
  if (text.length === 0 || start_ms === undefined || end_ms === undefined) return false;
  const previous = segments.at(-1);
  if (end_ms <= start_ms || (previous !== undefined && start_ms < previous.end_ms)) return false;
  segments.push({ start_ms, end_ms, text });
  return segments.length <= MEDIA_TRANSCRIPT_SEGMENT_MAX_COUNT;
}

function segmentsFor(response: ProviderResponseValue):
  | Readonly<{
      readonly transcript: string;
      readonly segments: readonly MediaTranscriptSegment[];
    }>
  | MediaProviderFailureTag {
  if (response.words.map(({ text }) => text).join("") !== response.text) {
    return "unparseable_result";
  }
  const included = response.words.filter(({ type }) => type !== "audio_event");
  const transcript = included.map(({ text }) => text).join("");
  if (transcript.length === 0) return "unparseable_result";

  let previousAudioEventStart = 0;
  for (const entry of response.words) {
    if (entry.type !== "audio_event") continue;
    if (entry.text.length === 0 || entry.text.length > MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH) {
      return "malformed_response";
    }
    const value = timing(entry, false);
    if (value === null || value.kind !== "timed" || value.start_ms < previousAudioEventStart) {
      return "malformed_response";
    }
    previousAudioEventStart = value.start_ms;
  }

  const segments: MediaTranscriptSegment[] = [];
  let parts: string[] = [];
  let length = 0;
  let start_ms: number | undefined;
  let end_ms: number | undefined;
  let previousWordEnd = 0;
  let previousTimedEntryStart = 0;
  for (const entry of included) {
    if (entry.text.length === 0 || entry.text.length > MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH) {
      return "malformed_response";
    }
    const value = timing(entry, entry.type === "spacing");
    if (value === null) return "malformed_response";
    if (value.kind === "timed" && value.start_ms < previousTimedEntryStart) {
      return "malformed_response";
    }
    if (entry.type === "word" && (value.kind !== "timed" || value.start_ms < previousWordEnd)) {
      return "malformed_response";
    }
    if (
      length + entry.text.length > MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH &&
      !appendSegment(segments, parts, start_ms, end_ms)
    ) {
      return "malformed_response";
    }
    if (length + entry.text.length > MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH) {
      parts = [];
      length = 0;
      start_ms = undefined;
      end_ms = undefined;
    }
    parts.push(entry.text);
    length += entry.text.length;
    if (value.kind === "timed") previousTimedEntryStart = value.start_ms;
    if (entry.type === "word") {
      if (value.kind !== "timed") return "malformed_response";
      start_ms ??= value.start_ms;
      end_ms = value.end_ms;
      previousWordEnd = value.end_ms;
    }
  }
  if (!appendSegment(segments, parts, start_ms, end_ms)) return "malformed_response";
  return { transcript, segments };
}

function noSpeechEvidence(
  response: ProviderResponseValue,
): Extract<ElevenLabsAsrParsedResponse, { readonly kind: "no_speech" }> | null {
  if (
    response.text.length === 0 ||
    response.words.length === 0 ||
    response.language_probability !== 0
  ) {
    return null;
  }
  if (response.words.some(({ type }) => type !== "audio_event")) return null;
  if (response.words.map(({ text }) => text).join("") !== response.text) return null;

  let previousEnd = 0;
  const events: Array<{
    readonly type: "audio_event";
    readonly text: string;
    readonly start_ms: number;
    readonly end_ms: number;
  }> = [];
  for (const entry of response.words) {
    if (entry.text.length === 0 || entry.text.length > MEDIA_TRANSCRIPT_SEGMENT_MAX_LENGTH) {
      return null;
    }
    const value = timing(entry, false);
    if (value === null || value.kind !== "timed" || value.start_ms < previousEnd) return null;
    previousEnd = value.end_ms;
    events.push({
      type: "audio_event",
      text: entry.text,
      start_ms: value.start_ms,
      end_ms: value.end_ms,
    });
  }
  return {
    kind: "no_speech",
    evidence: {
      language_code: response.language_code,
      language_probability: response.language_probability,
      text: response.text,
      events,
    },
  };
}

function parseDocument(document: unknown): ElevenLabsAsrParsedResponse {
  const decoded = Schema.decodeUnknownOption(ProviderResponse, { onExcessProperty: "error" })(
    document,
  );
  if (Option.isNone(decoded)) return { kind: "failure", failure: "malformed_response" };
  const response = decoded.value;
  const textBytes = new TextEncoder().encode(response.text).byteLength;
  if (
    response.text.length > MEDIA_TRANSCRIPT_MAX_LENGTH ||
    textBytes > MEDIA_TRANSCRIPT_MAX_LENGTH * 4 ||
    response.words.length > ELEVENLABS_ASR_HARD_MAX_PROVIDER_ENTRIES
  ) {
    return { kind: "failure", failure: "malformed_response" };
  }
  if (response.audio_duration_secs !== undefined && response.audio_duration_secs !== null) {
    for (const entry of response.words) {
      if (
        entry.end !== undefined &&
        entry.end !== null &&
        entry.end > response.audio_duration_secs
      ) {
        return { kind: "failure", failure: "malformed_response" };
      }
    }
  }
  if (
    !/^[a-z]{2,3}$/u.test(response.language_code) ||
    !Number.isFinite(response.language_probability) ||
    response.language_probability < 0 ||
    response.language_probability > 1
  ) {
    return { kind: "failure", failure: "malformed_response" };
  }
  if (!response.words.some(({ type }) => type === "word")) {
    return noSpeechEvidence(response) ?? { kind: "failure", failure: "malformed_response" };
  }
  if (response.text.length === 0) return { kind: "failure", failure: "unparseable_result" };
  const segments = segmentsFor(response);
  if (typeof segments === "string") return { kind: "failure", failure: segments };
  return {
    kind: "transcript",
    transcript: segments.transcript,
    segments: segments.segments,
    detected_languages: [
      {
        language_bcp47: response.language_code,
        confidence: response.language_probability,
      },
    ],
  };
}

export async function parseElevenLabsAsrResponse(
  response: ElevenLabsAsrTransportResponse,
  limits: ElevenLabsAsrLimits,
  signal: AbortSignal,
): Promise<ElevenLabsAsrParsedResponse> {
  const statusFailure = failureForElevenLabsStatus(response.status);
  if (statusFailure !== null) {
    await cancelBody(response.body, "provider_status");
    return { kind: "failure", failure: statusFailure };
  }
  const declaredLength = headerValue(response.headers, "content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > limits.max_response_bytes) {
      await cancelBody(response.body, "response_too_large");
      return { kind: "failure", failure: "malformed_response" };
    }
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(headerValue(response.headers, "content-type") ?? "")) {
    await cancelBody(response.body, "wrong_content_type");
    return { kind: "failure", failure: "malformed_response" };
  }
  const bytes = await readBoundedBody(response.body, limits.max_response_bytes, signal);
  if (bytes === null) return { kind: "failure", failure: "malformed_response" };
  try {
    return parseDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return { kind: "failure", failure: "malformed_response" };
  }
}
