/**
 * Disabled-by-default ElevenLabs forced-alignment adapter.
 *
 * This module deliberately has no default network transport.  The processor
 * will provide a transport when the provider is enabled; tests use the same
 * boundary with a deterministic fake.  Audio and transcript bytes are only
 * present while an alignment call is in flight and are never copied into an
 * outcome or diagnostic.
 */

export const ELEVENLABS_ALIGNMENT_ENDPOINT = "https://api.elevenlabs.io/v1/forced-alignment";
export const ELEVENLABS_ALIGNMENT_ADAPTER_REVISION = "elevenlabs-alignment-adapter-v1";
export const ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY =
  "pirate-elevenlabs-alignment-v1-fixed-boundary";

/** The largest audio object accepted by this adapter. */
export const ELEVENLABS_ALIGNMENT_MAX_AUDIO_BYTES = 25_000_000;
/** This follows the private transcript ceiling in the song contracts. */
export const ELEVENLABS_ALIGNMENT_MAX_TRANSCRIPT_CHARS = 200_000;
export const ELEVENLABS_ALIGNMENT_MAX_TRANSCRIPT_BYTES = 800_000;
export const ELEVENLABS_ALIGNMENT_MAX_REQUEST_BYTES =
  ELEVENLABS_ALIGNMENT_MAX_AUDIO_BYTES + ELEVENLABS_ALIGNMENT_MAX_TRANSCRIPT_BYTES + 4_096;
export const ELEVENLABS_ALIGNMENT_MAX_RESPONSE_BYTES = 1_048_576;
export const ELEVENLABS_ALIGNMENT_MAX_TIMINGS = 10_000;
export const ELEVENLABS_ALIGNMENT_MAX_TIMING_MS = 86_400_000;
export const ELEVENLABS_ALIGNMENT_DEFAULT_TIMEOUT_MS = 120_000;
export const ELEVENLABS_ALIGNMENT_MAX_TIMEOUT_MS = 120_000;

type AlignmentMode = "word" | "character";
type TimingKind = "word" | "character" | "spacing";

export type ElevenLabsAlignmentTiming = Readonly<{
  readonly text: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly kind: TimingKind;
}>;

export type ElevenLabsAlignmentAudioRevision = Readonly<{
  readonly audio_revision: number;
  readonly canonical_audio_sha256: string;
  readonly bytes: Uint8Array;
  readonly mime_type: string;
  readonly filename?: string;
}>;

/** A private transcript selected by PostgreSQL authority. */
export type ElevenLabsAlignmentTranscriptArtifact = Readonly<{
  readonly artifact_ref: string;
  readonly operation_id: string;
  readonly audio_revision: number;
  readonly analysis_revision: number;
  readonly canonical_audio_sha256: string;
  readonly transcript: string;
}>;

export type ElevenLabsAlignmentInput = Readonly<{
  readonly request_id: string;
  readonly operation_id: string;
  readonly post_id: string;
  readonly audio: ElevenLabsAlignmentAudioRevision;
  readonly transcript: ElevenLabsAlignmentTranscriptArtifact;
  readonly signal?: AbortSignal;
}>;

export type ElevenLabsAlignmentTransportRequest = Readonly<{
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}>;

export type ElevenLabsAlignmentTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>> | Headers;
  readonly body: Uint8Array | ArrayBuffer | string;
}>;

export type ElevenLabsAlignmentTransport = (
  request: ElevenLabsAlignmentTransportRequest,
) => Promise<ElevenLabsAlignmentTransportResponse>;

type AlignmentContext = Readonly<{
  readonly operation_id: string;
  readonly post_id: string;
  readonly audio_revision: number;
  readonly analysis_revision: number;
  readonly canonical_audio_sha256: string;
  readonly transcript_artifact_ref: string;
  readonly adapter_revision: typeof ELEVENLABS_ALIGNMENT_ADAPTER_REVISION;
}>;

type AlignmentUnavailable = Readonly<{
  readonly status: "unavailable";
  readonly alignment: "unavailable";
  readonly context?: AlignmentContext;
}>;

export type ElevenLabsAlignmentOutcome =
  | (AlignmentUnavailable & {
      readonly outcome: "disabled";
      readonly reason: "disabled";
    })
  | (AlignmentUnavailable & {
      readonly outcome: "no_speech";
      readonly reason: "no_speech";
      readonly context: AlignmentContext;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "transcript_mismatch";
      readonly reason: "transcript_mismatch";
      readonly context: AlignmentContext;
      readonly expected_text_length: number;
      readonly received_text_length: number;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "retryable";
      readonly reason: "rate_limited" | "provider_unavailable" | "transport";
      readonly context?: AlignmentContext;
      readonly provider_status?: number;
      readonly retry_after_seconds?: number;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "timeout";
      readonly reason: "timeout";
      readonly context?: AlignmentContext;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "cancelled";
      readonly reason: "cancelled";
      readonly context?: AlignmentContext;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "permanent";
      readonly reason: "invalid_request" | "provider_rejected" | "configuration";
      readonly context?: AlignmentContext;
      readonly provider_status?: number;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "malformed";
      readonly reason: "malformed_response" | "invalid_timing" | "oversized_response";
      readonly context: AlignmentContext;
    })
  | Readonly<{
      readonly status: "ready";
      readonly alignment: "ready";
      readonly outcome: "ready";
      readonly context: AlignmentContext;
      readonly mode: AlignmentMode;
      readonly timings: readonly ElevenLabsAlignmentTiming[];
      readonly transcript: string;
    }>;

type ValidatedInput = Readonly<{
  readonly input: ElevenLabsAlignmentInput;
  readonly context: AlignmentContext;
  readonly transcriptBytes: Uint8Array;
}>;

class AlignmentAbort extends Error {
  readonly reason: "timeout" | "cancelled";

  constructor(reason: "timeout" | "cancelled") {
    super(reason);
    this.name = "AlignmentAbort";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeIdentifier(value: unknown, maximum: number): value is string {
  const containsControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
    });
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !containsControlCharacter
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function contextFor(input: ElevenLabsAlignmentInput): AlignmentContext {
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

function validateInput(
  input: ElevenLabsAlignmentInput,
): ValidatedInput | ElevenLabsAlignmentOutcome {
  if (!isSafeIdentifier(input.request_id, 128)) {
    return permanent("invalid_request");
  }
  if (!isSafeIdentifier(input.operation_id, 128) || !isSafeIdentifier(input.post_id, 128)) {
    return permanent("invalid_request");
  }
  if (!isPositiveSafeInteger(input.audio.audio_revision)) {
    return permanent("invalid_request");
  }
  if (!isSha256(input.audio.canonical_audio_sha256)) {
    return permanent("invalid_request");
  }
  if (!(input.audio.bytes instanceof Uint8Array) || input.audio.bytes.byteLength === 0) {
    return permanent("invalid_request");
  }
  if (input.audio.bytes.byteLength > ELEVENLABS_ALIGNMENT_MAX_AUDIO_BYTES) {
    return permanent("invalid_request");
  }
  if (
    typeof input.audio.mime_type !== "string" ||
    input.audio.mime_type.length > 128 ||
    !/^audio\/[a-z0-9][a-z0-9.+-]*$/u.test(input.audio.mime_type)
  ) {
    return permanent("invalid_request");
  }
  if (
    input.audio.filename !== undefined &&
    (!isSafeIdentifier(input.audio.filename, 128) ||
      input.audio.filename.includes("/") ||
      input.audio.filename.includes("\\") ||
      input.audio.filename.includes('"'))
  ) {
    return permanent("invalid_request");
  }
  if (!isSafeIdentifier(input.transcript.artifact_ref, 512)) {
    return permanent("invalid_request");
  }
  if (!isSafeIdentifier(input.transcript.operation_id, 128)) {
    return permanent("invalid_request");
  }
  if (
    input.transcript.operation_id !== input.operation_id ||
    input.transcript.audio_revision !== input.audio.audio_revision ||
    input.transcript.canonical_audio_sha256 !== input.audio.canonical_audio_sha256 ||
    !isPositiveSafeInteger(input.transcript.analysis_revision)
  ) {
    return permanent("invalid_request");
  }
  if (typeof input.transcript.transcript !== "string") {
    return permanent("invalid_request");
  }
  const transcriptBytes = new TextEncoder().encode(input.transcript.transcript);
  if (
    input.transcript.transcript.length > ELEVENLABS_ALIGNMENT_MAX_TRANSCRIPT_CHARS ||
    transcriptBytes.byteLength > ELEVENLABS_ALIGNMENT_MAX_TRANSCRIPT_BYTES
  ) {
    return permanent("invalid_request");
  }

  const context = contextFor(input);
  return { input, context, transcriptBytes };
}

function unavailable<T extends ElevenLabsAlignmentOutcome>(outcome: T): T {
  return outcome;
}

function permanent(
  reason: "invalid_request" | "provider_rejected" | "configuration",
  context?: AlignmentContext,
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

function retryable(
  reason: "rate_limited" | "provider_unavailable" | "transport",
  context?: AlignmentContext,
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
  return body.byteLength <= ELEVENLABS_ALIGNMENT_MAX_REQUEST_BYTES ? body : null;
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

function toResponseBytes(body: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
}

function parseProviderTimings(
  response: unknown,
  transcript: string,
  context: AlignmentContext,
): ElevenLabsAlignmentOutcome {
  if (!isRecord(response)) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "malformed",
      reason: "malformed_response",
      context,
    });
  }

  if (Object.keys(response).length === 1 && response.status === "no_speech") {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "no_speech",
      reason: "no_speech",
      context,
    });
  }

  const hasWords = Object.hasOwn(response, "words");
  const hasCharacters = Object.hasOwn(response, "characters");
  if (hasWords === hasCharacters) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "malformed",
      reason: "malformed_response",
      context,
    });
  }

  const mode: AlignmentMode = hasWords ? "word" : "character";
  let entries: unknown[];
  if (hasWords) {
    if (!hasOnlyKeys(response, ["words"]) || !Array.isArray(response.words)) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    entries = response.words;
  } else if (
    Array.isArray(response.characters) &&
    response.characters.every((entry) => typeof entry === "string")
  ) {
    if (
      !hasOnlyKeys(response, [
        "characters",
        "character_start_times_seconds",
        "character_end_times_seconds",
      ])
    ) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    const characterStarts = response.character_start_times_seconds;
    const characterEnds = response.character_end_times_seconds;
    if (
      !Array.isArray(characterStarts) ||
      !Array.isArray(characterEnds) ||
      response.characters.length !== characterStarts.length ||
      response.characters.length !== characterEnds.length
    ) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    entries = response.characters.map((text, index) => ({
      text,
      start: characterStarts[index],
      end: characterEnds[index],
      type: "character",
    }));
  } else if (Array.isArray(response.characters)) {
    if (!hasOnlyKeys(response, ["characters"])) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    entries = response.characters;
  } else {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "malformed",
      reason: "malformed_response",
      context,
    });
  }

  if (entries.length > ELEVENLABS_ALIGNMENT_MAX_TIMINGS) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "malformed",
      reason: "oversized_response",
      context,
    });
  }
  if (entries.length === 0) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "no_speech",
      reason: "no_speech",
      context,
    });
  }

  const timings: ElevenLabsAlignmentTiming[] = [];
  let previousEndMs = 0;
  let totalDurationMs = 0;
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["text", "start", "end", "type", "loss", "confidence"])
    ) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    if (typeof entry.text !== "string" || entry.text.length === 0 || entry.text.length > 4_096) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    if (
      !isFiniteNumber(entry.start) ||
      !isFiniteNumber(entry.end) ||
      entry.start < 0 ||
      entry.end <= entry.start
    ) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "invalid_timing",
        context,
      });
    }
    if (entry.end * 1000 > ELEVENLABS_ALIGNMENT_MAX_TIMING_MS) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "invalid_timing",
        context,
      });
    }
    const startMs = Math.round(entry.start * 1000);
    const endMs = Math.round(entry.end * 1000);
    if (endMs <= startMs || startMs < previousEndMs) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "invalid_timing",
        context,
      });
    }
    const kind: TimingKind =
      entry.type === "spacing" ? "spacing" : mode === "word" ? "word" : "character";
    if (
      entry.type !== undefined &&
      entry.type !== kind &&
      !(mode === "character" && entry.type === "word")
    ) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "malformed",
        reason: "malformed_response",
        context,
      });
    }
    timings.push({ text: entry.text, start_ms: startMs, end_ms: endMs, kind });
    previousEndMs = endMs;
    totalDurationMs = endMs;
  }

  if (totalDurationMs > ELEVENLABS_ALIGNMENT_MAX_TIMING_MS) {
    return unavailable({
      status: "unavailable",
      alignment: "unavailable",
      outcome: "malformed",
      reason: "invalid_timing",
      context,
    });
  }
  const received = timings.map((timing) => timing.text).join("");
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
    transcript,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (isRecord(error) && error.name === "AbortError")
  );
}

export type ElevenLabsAlignmentAdapterOptions = Readonly<{
  /** Explicit opt-in; the default is false and performs no transport call. */
  readonly enabled?: boolean;
  /** Opaque secret supplied by the composition; never returned or logged. */
  readonly api_key?: string;
  readonly transport?: ElevenLabsAlignmentTransport;
  readonly endpoint?: string;
  readonly timeout_ms?: number;
}>;

export class ElevenLabsAlignmentAdapter {
  private readonly enabled: boolean;
  #apiKey: string | undefined;
  private readonly transport: ElevenLabsAlignmentTransport | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsAlignmentAdapterOptions = {}) {
    this.enabled = options.enabled === true;
    this.#apiKey = options.api_key;
    this.transport = options.transport;
    this.endpoint = options.endpoint ?? ELEVENLABS_ALIGNMENT_ENDPOINT;
    this.timeoutMs = options.timeout_ms ?? ELEVENLABS_ALIGNMENT_DEFAULT_TIMEOUT_MS;
  }

  async align(input: ElevenLabsAlignmentInput): Promise<ElevenLabsAlignmentOutcome> {
    if (!this.enabled) {
      return {
        status: "unavailable",
        alignment: "unavailable",
        outcome: "disabled",
        reason: "disabled",
      };
    }
    if (
      this.transport === undefined ||
      typeof this.#apiKey !== "string" ||
      this.#apiKey.length === 0
    ) {
      return permanent("configuration");
    }
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > ELEVENLABS_ALIGNMENT_MAX_TIMEOUT_MS
    ) {
      return permanent("configuration");
    }

    const validated = validateInput(input);
    if (!("input" in validated)) return validated;
    if (validated.input.transcript.transcript.trim().length === 0) {
      return unavailable({
        status: "unavailable",
        alignment: "unavailable",
        outcome: "no_speech",
        reason: "no_speech",
        context: validated.context,
      });
    }
    const body = encodeElevenLabsAlignmentMultipart({
      audio: validated.input.audio,
      transcript: validated.input.transcript.transcript,
    });
    if (body === null || body.byteLength > ELEVENLABS_ALIGNMENT_MAX_REQUEST_BYTES) {
      return permanent("invalid_request", validated.context);
    }

    const externalSignal = validated.input.signal;
    if (externalSignal?.aborted) {
      return {
        status: "unavailable",
        alignment: "unavailable",
        outcome: "cancelled",
        reason: "cancelled",
        context: validated.context,
      };
    }
    const controller = new AbortController();
    let abortReason: "timeout" | "cancelled" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      abortReason = "cancelled";
      controller.abort();
    };
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      abortReason = "timeout";
      controller.abort();
    }, this.timeoutMs);

    const request: ElevenLabsAlignmentTransportRequest = {
      method: "POST",
      url: this.endpoint,
      headers: {
        accept: "application/json",
        "content-type": `multipart/form-data; boundary=${ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY}`,
        "xi-api-key": this.#apiKey,
      },
      body,
      signal: controller.signal,
    };
    let transportPromise: Promise<ElevenLabsAlignmentTransportResponse>;
    try {
      transportPromise = Promise.resolve(this.transport(request));
    } catch {
      transportPromise = Promise.reject(new Error("transport_failure"));
    }
    void transportPromise.catch(() => undefined);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const check = () => {
        if (abortReason !== undefined) reject(new AlignmentAbort(abortReason));
      };
      controller.signal.addEventListener("abort", check, { once: true });
      check();
    });
    try {
      const response = await Promise.race([transportPromise, abortPromise]);
      if (response.status === 429) {
        return retryable(
          "rate_limited",
          validated.context,
          response.status,
          parseRetryAfter(headerValue(response.headers, "retry-after")),
        );
      }
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        return retryable("provider_unavailable", validated.context, response.status);
      }
      if (response.status < 200 || response.status >= 300) {
        return permanent("provider_rejected", validated.context, response.status);
      }
      const declaredLength = headerValue(response.headers, "content-length");
      if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
        return unavailable({
          status: "unavailable",
          alignment: "unavailable",
          outcome: "malformed",
          reason: "malformed_response",
          context: validated.context,
        });
      }
      if (
        declaredLength !== null &&
        Number(declaredLength) > ELEVENLABS_ALIGNMENT_MAX_RESPONSE_BYTES
      ) {
        return unavailable({
          status: "unavailable",
          alignment: "unavailable",
          outcome: "malformed",
          reason: "oversized_response",
          context: validated.context,
        });
      }
      if (
        !/^application\/json(?:\s*;|$)/iu.test(headerValue(response.headers, "content-type") ?? "")
      ) {
        return unavailable({
          status: "unavailable",
          alignment: "unavailable",
          outcome: "malformed",
          reason: "malformed_response",
          context: validated.context,
        });
      }
      const responseBytes = toResponseBytes(response.body);
      if (responseBytes.byteLength > ELEVENLABS_ALIGNMENT_MAX_RESPONSE_BYTES) {
        return unavailable({
          status: "unavailable",
          alignment: "unavailable",
          outcome: "malformed",
          reason: "oversized_response",
          context: validated.context,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
      } catch {
        return unavailable({
          status: "unavailable",
          alignment: "unavailable",
          outcome: "malformed",
          reason: "malformed_response",
          context: validated.context,
        });
      }
      return parseProviderTimings(parsed, validated.input.transcript.transcript, validated.context);
    } catch (error) {
      if (error instanceof AlignmentAbort) {
        return error.reason === "timeout"
          ? {
              status: "unavailable",
              alignment: "unavailable",
              outcome: "timeout",
              reason: "timeout",
              context: validated.context,
            }
          : {
              status: "unavailable",
              alignment: "unavailable",
              outcome: "cancelled",
              reason: "cancelled",
              context: validated.context,
            };
      }
      if (abortReason === "timeout" || isAbortError(error)) {
        return {
          status: "unavailable",
          alignment: "unavailable",
          outcome: "timeout",
          reason: "timeout",
          context: validated.context,
        };
      }
      if (abortReason === "cancelled") {
        return {
          status: "unavailable",
          alignment: "unavailable",
          outcome: "cancelled",
          reason: "cancelled",
          context: validated.context,
        };
      }
      return retryable("transport", validated.context);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}

export function makeElevenLabsAlignmentAdapter(
  options: ElevenLabsAlignmentAdapterOptions = {},
): ElevenLabsAlignmentAdapter {
  return new ElevenLabsAlignmentAdapter(options);
}
