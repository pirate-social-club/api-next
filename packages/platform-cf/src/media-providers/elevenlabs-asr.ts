/** Disabled-by-default ElevenLabs speech-to-text adapter with injected I/O. */

import {
  decodeMediaAsrInput,
  decodeMediaAsrResult,
  isMediaAsrResultBoundToInput,
  type MediaAsrAdapter,
  type MediaAsrInput,
  type MediaAsrResult,
  type MediaProviderFailure,
  type MediaProviderFailureTag,
} from "@pirate/application/media-provider-contracts";
import { Effect, Predicate } from "effect";
import {
  ElevenLabsAsrBodyError,
  encodeElevenLabsAsrMultipart,
} from "./elevenlabs-asr-multipart.ts";
import {
  failureForElevenLabsStatus,
  parseElevenLabsAsrResponse,
  retryAfterMilliseconds,
} from "./elevenlabs-asr-response.ts";
import {
  ELEVENLABS_ASR_ENDPOINT,
  ELEVENLABS_ASR_HARD_MAX_API_KEY_BYTES,
  ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES,
  ELEVENLABS_ASR_HARD_MAX_MODEL_BYTES,
  ELEVENLABS_ASR_HARD_MAX_RESPONSE_BYTES,
  ELEVENLABS_ASR_HARD_MAX_TIMEOUT_MS,
  type ElevenLabsAsrAudioSource,
  type ElevenLabsAsrOptions,
  type ElevenLabsAsrTransportResponse,
  type EnabledElevenLabsAsrOptions,
} from "./elevenlabs-asr-types.ts";

export { encodeElevenLabsAsrMultipart } from "./elevenlabs-asr-multipart.ts";
export * from "./elevenlabs-asr-types.ts";

type Configuration =
  | Readonly<{ readonly enabled: false }>
  | (EnabledElevenLabsAsrOptions & Readonly<{ readonly enabled: true }>);

class ElevenLabsAsrFailure extends Error {
  readonly failure: MediaProviderFailure;

  constructor(failure: MediaProviderFailure) {
    super(failure._tag);
    this.name = "ElevenLabsAsrFailure";
    this.failure = failure;
  }
}

class ElevenLabsAsrAbort extends Error {
  readonly reason: "timeout" | "cancelled";

  constructor(reason: ElevenLabsAsrAbort["reason"]) {
    super(reason);
    this.name = "ElevenLabsAsrAbort";
    this.reason = reason;
  }
}

function failure(
  attempt_id: string,
  _tag: MediaProviderFailureTag,
  retry_after_ms?: number,
): MediaProviderFailure {
  const retryability =
    _tag === "timeout" || _tag === "rate_limited" || _tag === "provider_unavailable"
      ? "retryable"
      : _tag === "cancelled"
        ? "cancelled"
        : "permanent";
  return {
    attempt_id,
    _tag,
    retryability,
    ...(_tag === "rate_limited" ? { retry_after_ms: retry_after_ms ?? 1_000 } : {}),
  } as MediaProviderFailure;
}

function safeAttemptId(value: unknown): string {
  if (
    Predicate.isObject(value) &&
    Predicate.isObject(value.attempt) &&
    Predicate.isString(value.attempt.attempt_id) &&
    value.attempt.attempt_id.length > 0 &&
    value.attempt.attempt_id.length <= 256 &&
    value.attempt.attempt_id.trim() === value.attempt.attempt_id &&
    new TextEncoder().encode(value.attempt.attempt_id).byteLength <= 256 &&
    [...value.attempt.attempt_id].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return value.attempt.attempt_id;
  }
  return "invalid-attempt";
}

function boundedVisibleText(value: unknown, maximumBytes: number): value is string {
  if (!Predicate.isString(value) || value.length === 0 || value.trim() !== value) return false;
  return (
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x21 && codePoint <= 0x7e;
    })
  );
}

function validLimits(options: EnabledElevenLabsAsrOptions): boolean {
  const limits = options.limits;
  return (
    Predicate.isObject(limits) &&
    Number.isSafeInteger(limits.max_audio_bytes) &&
    limits.max_audio_bytes > 0 &&
    limits.max_audio_bytes <= ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES &&
    Number.isSafeInteger(limits.max_response_bytes) &&
    limits.max_response_bytes > 0 &&
    limits.max_response_bytes <= ELEVENLABS_ASR_HARD_MAX_RESPONSE_BYTES &&
    Number.isSafeInteger(limits.timeout_ms) &&
    limits.timeout_ms > 0 &&
    limits.timeout_ms <= ELEVENLABS_ASR_HARD_MAX_TIMEOUT_MS
  );
}

function combinedAdapterRevision(configuration: EnabledElevenLabsAsrOptions): string | null {
  const encoder = new TextEncoder();
  const adapterBytes = encoder.encode(configuration.adapter_revision).byteLength;
  const modelBytes = encoder.encode(configuration.model).byteLength;
  const modelRevisionBytes = encoder.encode(configuration.model_revision).byteLength;
  const combined = `elevenlabs-asr-v1:a${adapterBytes}:${configuration.adapter_revision}:n${modelBytes}:${configuration.model}:m${modelRevisionBytes}:${configuration.model_revision}`;
  return boundedVisibleText(combined, 128) ? combined : null;
}

function snapshotConfiguration(options: ElevenLabsAsrOptions | undefined): Configuration {
  if (options?.enabled !== true) return Object.freeze({ enabled: false });
  return Object.freeze({
    ...options,
    limits: Object.freeze({ ...options.limits }),
  });
}

function configurationIsValid(
  configuration: Configuration,
): configuration is EnabledElevenLabsAsrOptions & { readonly enabled: true } {
  return (
    configuration.enabled &&
    boundedVisibleText(configuration.api_key, ELEVENLABS_ASR_HARD_MAX_API_KEY_BYTES) &&
    boundedVisibleText(configuration.model, ELEVENLABS_ASR_HARD_MAX_MODEL_BYTES) &&
    boundedVisibleText(configuration.model_revision, 128) &&
    boundedVisibleText(configuration.adapter_revision, 128) &&
    combinedAdapterRevision(configuration) !== null &&
    Predicate.isBoolean(configuration.enable_logging) &&
    Predicate.isFunction(configuration.resolve_audio) &&
    Predicate.isFunction(configuration.transport) &&
    (configuration.random_bytes === undefined ||
      Predicate.isFunction(configuration.random_bytes)) &&
    validLimits(configuration)
  );
}

function snapshotInput(value: unknown): MediaAsrInput | null {
  try {
    const input = decodeMediaAsrInput(value);
    return Object.freeze({
      ...input,
      audio: Object.freeze({ ...input.audio }),
      attempt: Object.freeze({ ...input.attempt }),
    });
  } catch {
    return null;
  }
}

async function awaitMaybeEffect<T>(
  value: T | PromiseLike<T> | Effect.Effect<T, unknown>,
  signal: AbortSignal,
): Promise<T> {
  return Effect.isEffect(value) ? Effect.runPromise(value, { signal }) : await value;
}

function validAudioSource(source: ElevenLabsAsrAudioSource, maximum: number): boolean {
  return (
    Predicate.isObject(source) &&
    Predicate.isFunction(source.open) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0 &&
    source.byteLength <= maximum &&
    Predicate.isString(source.mime_type) &&
    /^audio\/[a-z0-9][a-z0-9.+-]*$/u.test(source.mime_type)
  );
}

async function cancelResponse(
  response: ElevenLabsAsrTransportResponse,
  reason: unknown,
): Promise<void> {
  try {
    await response.body.cancel(reason);
  } catch {
    // Provider cleanup failures never change the already-selected closed outcome.
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resultForParsed(
  input: MediaAsrInput,
  configuration: EnabledElevenLabsAsrOptions,
  parsed: Awaited<ReturnType<typeof parseElevenLabsAsrResponse>>,
): Promise<MediaAsrResult> {
  if (parsed.kind === "failure") {
    throw new ElevenLabsAsrFailure(failure(input.attempt.attempt_id, parsed.failure));
  }
  const adapterRevision = combinedAdapterRevision(configuration);
  if (adapterRevision === null) {
    throw new ElevenLabsAsrFailure(failure(input.attempt.attempt_id, "permanent_rejection"));
  }
  const [operationIdentity, audioArtifactIdentity, provenanceIdentity] = await Promise.all([
    sha256(input.audio.operation_id),
    sha256(input.audio.audio_artifact_ref),
    sha256(
      JSON.stringify([
        "elevenlabs-asr-provenance-v1",
        configuration.model,
        configuration.model_revision,
        configuration.adapter_revision,
        adapterRevision,
      ]),
    ),
  ]);
  const lineageReference = `${operationIdentity}/${input.audio.canonical_audio_sha256}/${input.audio.audio_revision}/${input.audio.analysis_revision}/${audioArtifactIdentity}/${provenanceIdentity}`;
  const candidate =
    parsed.kind === "no_speech"
      ? await (async () => {
          const evidenceIdentity = await sha256(
            JSON.stringify([
              "elevenlabs-asr-no-speech-v1",
              input.audio.operation_id,
              input.audio.audio_revision,
              input.audio.analysis_revision,
              input.audio.canonical_audio_sha256,
              input.audio.audio_artifact_ref,
              configuration.model,
              configuration.model_revision,
              configuration.adapter_revision,
              adapterRevision,
              parsed.evidence.language_code,
              parsed.evidence.language_probability,
              parsed.evidence.text,
              parsed.evidence.events.map(({ type, text, start_ms, end_ms }) => [
                type,
                text,
                start_ms,
                end_ms,
              ]),
            ]),
          );
          return {
            version: "media-asr-result-v1" as const,
            status: "no_speech" as const,
            audio: input.audio,
            attempt: input.attempt,
            transcript: null,
            detected_languages: [],
            evidence_ref: `elevenlabs-asr://no-speech/${lineageReference}/${evidenceIdentity}`,
            adapter_revision: adapterRevision,
          };
        })()
      : await (async () => {
          const transcript_sha256 = await sha256(parsed.transcript);
          // This reference identifies the transcript artifact only. Detected-language
          // evidence is a separate field in MediaAsrResult and is persisted beside it.
          const artifact_identity_sha256 = await sha256(
            JSON.stringify([
              "media-transcript-artifact-v1",
              input.audio.operation_id,
              input.audio.audio_revision,
              input.audio.analysis_revision,
              input.audio.canonical_audio_sha256,
              input.audio.audio_artifact_ref,
              configuration.model,
              configuration.model_revision,
              configuration.adapter_revision,
              adapterRevision,
              transcript_sha256,
              parsed.transcript,
              parsed.segments.map(({ start_ms, end_ms, text }) => [start_ms, end_ms, text]),
            ]),
          );
          return {
            version: "media-asr-result-v1" as const,
            status: "transcript" as const,
            audio: input.audio,
            attempt: input.attempt,
            transcript: {
              version: "media-transcript-artifact-v1" as const,
              operation_id: input.audio.operation_id,
              audio_revision: input.audio.audio_revision,
              analysis_revision: input.audio.analysis_revision,
              canonical_audio_sha256: input.audio.canonical_audio_sha256,
              audio_artifact_ref: input.audio.audio_artifact_ref,
              transcript_artifact_ref: `elevenlabs-asr://transcript/${lineageReference}/${artifact_identity_sha256}`,
              transcript_sha256,
              transcript: parsed.transcript,
              segments: parsed.segments,
            },
            detected_languages: parsed.detected_languages,
            adapter_revision: adapterRevision,
          };
        })();
  try {
    const result = decodeMediaAsrResult(candidate);
    if (!isMediaAsrResultBoundToInput(input, result)) {
      throw new ElevenLabsAsrFailure(failure(input.attempt.attempt_id, "out_of_policy"));
    }
    return result;
  } catch (error) {
    if (error instanceof ElevenLabsAsrFailure) throw error;
    throw new ElevenLabsAsrFailure(failure(input.attempt.attempt_id, "out_of_policy"));
  }
}

async function invoke(
  configuration: Configuration,
  input: MediaAsrInput,
  externalSignal: AbortSignal,
  interruptionSignal: AbortSignal,
): Promise<MediaAsrResult> {
  const attemptId = input.attempt.attempt_id;
  if (!configurationIsValid(configuration)) {
    throw new ElevenLabsAsrFailure(failure(attemptId, "permanent_rejection"));
  }
  if (externalSignal.aborted || interruptionSignal.aborted) {
    throw new ElevenLabsAsrFailure(failure(attemptId, "cancelled"));
  }

  const controller = new AbortController();
  let abortReason: "timeout" | "cancelled" | undefined;
  const cancel = () => {
    abortReason = "cancelled";
    controller.abort();
  };
  externalSignal.addEventListener("abort", cancel, { once: true });
  interruptionSignal.addEventListener("abort", cancel, { once: true });
  const timeoutMs = Math.min(configuration.limits.timeout_ms, input.attempt.timeout_ms);
  const timer = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, timeoutMs);
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const observe = () => {
      if (abortReason !== undefined) reject(new ElevenLabsAsrAbort(abortReason));
    };
    controller.signal.addEventListener("abort", observe, { once: true });
    observe();
  });
  void abortPromise.catch(() => undefined);

  let operationFinished = false;
  try {
    const sourcePromise = Promise.resolve().then(() =>
      awaitMaybeEffect(
        configuration.resolve_audio(input.audio.audio_artifact_ref, controller.signal),
        controller.signal,
      ),
    );
    void sourcePromise.catch(() => undefined);
    const source = await Promise.race([sourcePromise, abortPromise]);
    if (!validAudioSource(source, configuration.limits.max_audio_bytes)) {
      throw new ElevenLabsAsrFailure(failure(attemptId, "permanent_rejection"));
    }
    const body = encodeElevenLabsAsrMultipart({
      audio: source,
      model: configuration.model,
      ...(configuration.random_bytes === undefined
        ? {}
        : { random_bytes: configuration.random_bytes }),
    });
    if (body === null) {
      throw new ElevenLabsAsrFailure(failure(attemptId, "permanent_rejection"));
    }
    const request = {
      method: "POST" as const,
      url: `${ELEVENLABS_ASR_ENDPOINT}?enable_logging=${configuration.enable_logging ? "true" : "false"}`,
      headers: {
        accept: "application/json",
        "content-type": body.contentType,
        "content-length": String(body.byteLength),
        "xi-api-key": configuration.api_key,
      },
      body,
      signal: controller.signal,
      redirect: "error" as const,
    };
    const transportPromise = Promise.resolve()
      .then(() => awaitMaybeEffect(configuration.transport(request), controller.signal))
      .catch((error: unknown) => {
        if (error instanceof ElevenLabsAsrBodyError) throw error;
        throw new ElevenLabsAsrFailure(failure(attemptId, "provider_unavailable"));
      });
    void transportPromise.catch(() => undefined);
    const guardedResponse = transportPromise.then(async (response) => {
      if (abortReason !== undefined || operationFinished) {
        await cancelResponse(response, "late_transport_response");
        throw new ElevenLabsAsrAbort(abortReason ?? "cancelled");
      }
      return response;
    });
    void guardedResponse.catch(() => undefined);
    const response = await Promise.race([guardedResponse, abortPromise]);
    if (abortReason !== undefined) {
      await cancelResponse(response, "late_transport_response");
      throw new ElevenLabsAsrAbort(abortReason);
    }
    const parsed = await Promise.race([
      parseElevenLabsAsrResponse(response, configuration.limits, controller.signal),
      abortPromise,
    ]);
    if (parsed.kind === "failure") {
      const tag = parsed.failure;
      const retryAfter =
        tag === "rate_limited" ? retryAfterMilliseconds(response.headers) : undefined;
      throw new ElevenLabsAsrFailure(failure(attemptId, tag, retryAfter));
    }
    return await Promise.race([resultForParsed(input, configuration, parsed), abortPromise]);
  } catch (error) {
    let selected: MediaProviderFailure;
    if (error instanceof ElevenLabsAsrFailure) selected = error.failure;
    else if (error instanceof ElevenLabsAsrAbort) selected = failure(attemptId, error.reason);
    else if (error instanceof ElevenLabsAsrBodyError) {
      selected = failure(attemptId, "permanent_rejection");
    } else {
      selected = failure(attemptId, abortReason ?? "provider_unavailable");
    }
    throw new ElevenLabsAsrFailure(selected);
  } finally {
    operationFinished = true;
    clearTimeout(timer);
    externalSignal.removeEventListener("abort", cancel);
    interruptionSignal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

/** Construct the provider-neutral ASR adapter; no transport call occurs while disabled. */
export function makeElevenLabsAsrAdapter(options: ElevenLabsAsrOptions = {}): MediaAsrAdapter {
  const configuration = snapshotConfiguration(options);
  return {
    recognize: (input, callOptions) => {
      const snapshot = snapshotInput(input);
      if (snapshot === null) {
        return Effect.fail(failure(safeAttemptId(input), "permanent_rejection"));
      }
      return Effect.tryPromise({
        try: (interruptionSignal) =>
          invoke(configuration, snapshot, callOptions.signal, interruptionSignal),
        catch: (error): MediaProviderFailure =>
          error instanceof ElevenLabsAsrFailure
            ? error.failure
            : failure(snapshot.attempt.attempt_id, "provider_unavailable"),
      });
    },
  };
}

export const makeElevenLabsAsr = makeElevenLabsAsrAdapter;

/** Narrow status helper exported for provider fixture tests. */
export { failureForElevenLabsStatus };
