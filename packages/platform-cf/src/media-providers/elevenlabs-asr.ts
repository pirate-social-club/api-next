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
  type ElevenLabsAsrAttemptEvidence,
  type ElevenLabsAsrAudioSource,
  type ElevenLabsAsrEvidenceReceipt,
  type ElevenLabsAsrOptions,
  type ElevenLabsAsrPreparedEvidence,
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

class ElevenLabsAsrEvidencePersistenceError extends Error {
  constructor() {
    super("evidence_persistence_failed");
    this.name = "ElevenLabsAsrEvidencePersistenceError";
  }
}

const EVIDENCE_RECOVERY_TIMEOUT_MS = 1_000 as const;

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

function failureForEvidenceOutcome(
  attempt_id: string,
  outcome: ElevenLabsAsrAttemptEvidence["outcome"],
): MediaProviderFailure {
  return failure(
    attempt_id,
    outcome === "transcript" || outcome === "no_speech" ? "provider_unavailable" : outcome,
  );
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
    Predicate.isBoolean(configuration.enable_logging) &&
    Predicate.isFunction(configuration.resolve_audio) &&
    Predicate.isFunction(configuration.transport) &&
    Predicate.isObject(configuration.evidence_sink) &&
    Predicate.isFunction(configuration.evidence_sink.prepare) &&
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

function cancelResponse(response: ElevenLabsAsrTransportResponse, reason: unknown): void {
  try {
    void Promise.resolve(response.body.cancel(reason)).catch(() => undefined);
  } catch {
    // A late provider response cannot change the already-selected outcome.
  }
}

function makeEvidence(
  configuration: EnabledElevenLabsAsrOptions,
  attempt_id: string,
  outcome: ElevenLabsAsrAttemptEvidence["outcome"],
  provider_status?: number,
): ElevenLabsAsrAttemptEvidence {
  return Object.freeze({
    version: "elevenlabs-asr-attempt-evidence-v1",
    provider: "elevenlabs",
    endpoint: ELEVENLABS_ASR_ENDPOINT,
    attempt_id,
    requested_model: configuration.model,
    model_revision: configuration.model_revision,
    adapter_revision: configuration.adapter_revision,
    retention: configuration.enable_logging ? "provider_logging" : "zero_retention",
    outcome,
    ...(provider_status === undefined ? {} : { provider_status }),
  });
}

function sameEvidence(
  left: ElevenLabsAsrAttemptEvidence,
  right: ElevenLabsAsrAttemptEvidence,
): boolean {
  return (
    left.version === right.version &&
    left.provider === right.provider &&
    left.endpoint === right.endpoint &&
    left.attempt_id === right.attempt_id &&
    left.requested_model === right.requested_model &&
    left.model_revision === right.model_revision &&
    left.adapter_revision === right.adapter_revision &&
    left.retention === right.retention &&
    left.outcome === right.outcome &&
    left.provider_status === right.provider_status
  );
}

function validPreparedEvidence(
  value: unknown,
  expected: ElevenLabsAsrAttemptEvidence,
): value is ElevenLabsAsrPreparedEvidence {
  return (
    Predicate.isObject(value) &&
    value.version === "elevenlabs-asr-prepared-evidence-v1" &&
    Predicate.isObject(value.evidence) &&
    sameEvidence(value.evidence as ElevenLabsAsrAttemptEvidence, expected) &&
    Predicate.isFunction(value.settle) &&
    Predicate.isFunction(value.discard)
  );
}

function evidenceFromReceipt(
  value: unknown,
  allowed: ReadonlyArray<ElevenLabsAsrAttemptEvidence>,
): ElevenLabsAsrAttemptEvidence {
  if (
    !Predicate.isObject(value) ||
    value.version !== "elevenlabs-asr-evidence-receipt-v1" ||
    !Predicate.isObject(value.evidence)
  ) {
    throw new ElevenLabsAsrEvidencePersistenceError();
  }
  const evidence = value.evidence as ElevenLabsAsrAttemptEvidence;
  const matched = allowed.find((candidate) => sameEvidence(evidence, candidate));
  if (matched === undefined) throw new ElevenLabsAsrEvidencePersistenceError();
  return matched;
}

async function prepareEvidence(
  configuration: EnabledElevenLabsAsrOptions,
  evidence: ElevenLabsAsrAttemptEvidence,
  signal: AbortSignal,
): Promise<ElevenLabsAsrPreparedEvidence> {
  const preparation = configuration.evidence_sink.prepare(evidence);
  if (!Effect.isEffect(preparation)) throw new ElevenLabsAsrEvidencePersistenceError();
  const prepared = await Effect.runPromise(preparation, { signal });
  if (!validPreparedEvidence(prepared, evidence)) {
    throw new ElevenLabsAsrEvidencePersistenceError();
  }
  return prepared;
}

async function settleEvidence(
  prepared: ElevenLabsAsrPreparedEvidence,
  desired: ElevenLabsAsrAttemptEvidence,
  allowed: ReadonlyArray<ElevenLabsAsrAttemptEvidence>,
  signal: AbortSignal,
): Promise<ElevenLabsAsrAttemptEvidence> {
  const settlement = prepared.settle(desired);
  if (!Effect.isEffect(settlement)) throw new ElevenLabsAsrEvidencePersistenceError();
  const receipt: ElevenLabsAsrEvidenceReceipt = await Effect.runPromise(settlement, { signal });
  return evidenceFromReceipt(receipt, allowed);
}

async function withRecoveryTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVIDENCE_RECOVERY_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function discardPrepared(prepared: ElevenLabsAsrPreparedEvidence): Promise<void> {
  try {
    await withRecoveryTimeout(async (signal) => {
      const discard = prepared.discard();
      if (!Effect.isEffect(discard)) throw new ElevenLabsAsrEvidencePersistenceError();
      await Effect.runPromise(discard, { signal });
    });
  } catch {
    // Settlement interruption is required to have quiesced before cleanup begins.
  }
}

async function finalizeEvidence(
  configuration: EnabledElevenLabsAsrOptions,
  attempt_id: string,
  candidateOutcome: ElevenLabsAsrAttemptEvidence["outcome"],
  signal: AbortSignal,
  replacementOutcome: () => ElevenLabsAsrAttemptEvidence["outcome"],
  provider_status?: number,
): Promise<ElevenLabsAsrAttemptEvidence | undefined> {
  const candidate = makeEvidence(configuration, attempt_id, candidateOutcome, provider_status);
  let prepared: ElevenLabsAsrPreparedEvidence | undefined;
  try {
    prepared = await prepareEvidence(configuration, candidate, signal);
    return await settleEvidence(prepared, candidate, [candidate], signal);
  } catch {
    const replacement = makeEvidence(
      configuration,
      attempt_id,
      replacementOutcome(),
      provider_status,
    );
    try {
      return await withRecoveryTimeout(async (recoverySignal) => {
        const recoveryPrepared =
          prepared ?? (await prepareEvidence(configuration, replacement, recoverySignal));
        prepared = recoveryPrepared;
        return settleEvidence(
          recoveryPrepared,
          replacement,
          sameEvidence(candidate, replacement) ? [candidate] : [candidate, replacement],
          recoverySignal,
        );
      });
    } catch {
      if (prepared !== undefined) await discardPrepared(prepared);
      return undefined;
    }
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
  const candidate =
    parsed.kind === "no_speech"
      ? {
          version: "media-asr-result-v1" as const,
          status: "no_speech" as const,
          audio: input.audio,
          attempt: input.attempt,
          transcript: null,
          detected_languages: [],
          evidence_ref: `elevenlabs-asr://no-speech/${input.audio.canonical_audio_sha256}/${input.audio.analysis_revision}`,
          adapter_revision: configuration.adapter_revision,
        }
      : await (async () => {
          const transcript_sha256 = await sha256(parsed.transcript);
          const operation_identity_sha256 = await sha256(input.audio.operation_id);
          const artifact_identity_sha256 = await sha256(
            JSON.stringify([
              "media-transcript-artifact-v1",
              input.audio.operation_id,
              input.audio.audio_revision,
              input.audio.analysis_revision,
              input.audio.canonical_audio_sha256,
              input.audio.audio_artifact_ref,
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
              transcript_artifact_ref: `elevenlabs-asr://transcript/${operation_identity_sha256}/${input.audio.canonical_audio_sha256}/${input.audio.audio_revision}/${input.audio.analysis_revision}/${artifact_identity_sha256}`,
              transcript_sha256,
              transcript: parsed.transcript,
              segments: parsed.segments,
            },
            detected_languages: parsed.detected_languages,
            adapter_revision: configuration.adapter_revision,
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
  let authoritativeOutcomeCommitted = false;
  const cancel = () => {
    if (authoritativeOutcomeCommitted) return;
    abortReason = "cancelled";
    controller.abort();
  };
  externalSignal.addEventListener("abort", cancel, { once: true });
  interruptionSignal.addEventListener("abort", cancel, { once: true });
  const timeoutMs = Math.min(configuration.limits.timeout_ms, input.attempt.timeout_ms);
  const timer = setTimeout(() => {
    if (authoritativeOutcomeCommitted) return;
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

  let providerStatus: number | undefined;
  let operationFinished = false;
  let evidenceFinalizationFinished = false;
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
    const guardedResponse = transportPromise.then((response) => {
      if (abortReason !== undefined || operationFinished) {
        cancelResponse(response, "late_transport_response");
        return new Promise<never>(() => undefined);
      }
      return response;
    });
    void guardedResponse.catch(() => undefined);
    const response = await Promise.race([guardedResponse, abortPromise]);
    providerStatus = response.status;
    if (abortReason !== undefined) {
      cancelResponse(response, "late_transport_response");
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
    const result = await Promise.race([
      resultForParsed(input, configuration, parsed),
      abortPromise,
    ]);
    const authoritativeEvidence = await finalizeEvidence(
      configuration,
      attemptId,
      result.status,
      controller.signal,
      () => abortReason ?? "provider_unavailable",
      providerStatus,
    );
    evidenceFinalizationFinished = true;
    if (authoritativeEvidence === undefined) {
      throw new ElevenLabsAsrFailure(failure(attemptId, "provider_unavailable"));
    }
    authoritativeOutcomeCommitted = true;
    if (authoritativeEvidence.outcome === result.status) return result;
    throw new ElevenLabsAsrFailure(
      failureForEvidenceOutcome(attemptId, authoritativeEvidence.outcome),
    );
  } catch (error) {
    let selected: MediaProviderFailure;
    if (error instanceof ElevenLabsAsrFailure) selected = error.failure;
    else if (error instanceof ElevenLabsAsrAbort) selected = failure(attemptId, error.reason);
    else if (error instanceof ElevenLabsAsrBodyError) {
      selected = failure(attemptId, "permanent_rejection");
    } else if (error instanceof ElevenLabsAsrEvidencePersistenceError) {
      selected = failure(attemptId, "provider_unavailable");
    } else {
      selected = failure(attemptId, abortReason ?? "provider_unavailable");
    }
    if (!authoritativeOutcomeCommitted && !evidenceFinalizationFinished) {
      const authoritativeEvidence = await finalizeEvidence(
        configuration,
        attemptId,
        selected._tag,
        controller.signal,
        () => abortReason ?? "provider_unavailable",
        providerStatus,
      );
      evidenceFinalizationFinished = true;
      if (authoritativeEvidence === undefined) {
        selected = failure(attemptId, "provider_unavailable");
      } else {
        authoritativeOutcomeCommitted = true;
        if (authoritativeEvidence.outcome !== selected._tag) {
          selected = failureForEvidenceOutcome(attemptId, authoritativeEvidence.outcome);
        }
      }
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
