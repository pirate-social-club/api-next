/** Disabled-by-default Transloadit adapter for the v1 media transform port. */

import {
  type MediaTransformAcceptedAttempt,
  type MediaTransformAttempt,
  type MediaTransformAudioSampleOutcome,
  type MediaTransformCancelOutcome,
  type MediaTransformProbeOutcome,
  MediaTransformRequestInvalid,
  type MediaTransformService,
  mediaTransformSampleWindow,
} from "@pirate/application/media/transform";
import { Effect } from "effect";
import {
  type EnabledTransloaditOptions,
  encodeTransloaditMultipart,
  retryAfterMilliseconds,
  signTransloaditParams,
  snapshotCancelInput,
  snapshotProbeInput,
  snapshotSampleInput,
  snapshotTransloaditOptions,
  stableTransloaditNonce,
  TRANSLOADIT_ASSEMBLIES_PATH,
  TRANSLOADIT_ORIGIN,
  TRANSLOADIT_SIGNATURE_TTL_MS,
  type TransloaditCancelSnapshot,
  type TransloaditConfig,
  type TransloaditMediaTransformOptions,
  type TransloaditOperationSnapshot,
  TransloaditRequestAbort,
  type TransloaditTransportRequest,
  type TransloaditTransportResponse,
  type TransloaditTransportResult,
  transloaditAttemptContext,
  transloaditJobUrl,
  validClockMilliseconds,
} from "./media-transform-protocol.ts";
import {
  parseTransloaditAssembly,
  probeFromAssembly,
  readBoundedTransloaditJson,
  resultStepFor,
  sampleFromAssembly,
  type TransloaditAssembly,
  TransloaditBodyAborted,
  TransloaditBodyTooLarge,
} from "./media-transform-response.ts";

export * from "./media-transform-protocol.ts";
export {
  parseTransloaditAssembly,
  readBoundedTransloaditJson,
  TransloaditBodyAborted,
  TransloaditBodyTooLarge,
} from "./media-transform-response.ts";

type OperationOutcome = MediaTransformProbeOutcome | MediaTransformAudioSampleOutcome;
type OperationFailure = Exclude<
  OperationOutcome,
  { status: "completed" | "processing" | "submitted" | "unavailable" }
>;
type WithoutOperationMetadata<A> = A extends unknown ? Omit<A, "attempt" | "context"> : never;

type RequestExecution<A> =
  | Readonly<{ readonly ok: true; readonly value: A }>
  | Readonly<{
      readonly ok: false;
      readonly reason: "cancelled" | "runtime_exceeded" | "timeout" | "transport";
    }>;

function toPromise(result: TransloaditTransportResult): Promise<TransloaditTransportResponse> {
  if (Effect.isEffect(result)) return Effect.runPromise(result);
  return Promise.resolve(result);
}

function disposeResponse(response: TransloaditTransportResponse): void {
  try {
    void Promise.resolve(response.body.cancel("unused_response")).catch(() => undefined);
  } catch {
    // A malformed or late response cannot alter the selected outcome.
  }
}

async function executeWithDeadline<A>(
  config: TransloaditConfig,
  runtimeDeadlineMs: number | undefined,
  externalSignal: AbortSignal | undefined,
  interruptionSignal: AbortSignal,
  execute: (signal: AbortSignal) => Promise<A>,
): Promise<RequestExecution<A>> {
  if (externalSignal?.aborted || interruptionSignal.aborted) {
    return { ok: false, reason: "cancelled" };
  }
  const now = config.nowMilliseconds();
  if (!validClockMilliseconds(now)) return { ok: false, reason: "transport" };
  const runtimeRemainingMs =
    runtimeDeadlineMs === undefined ? Number.POSITIVE_INFINITY : runtimeDeadlineMs - now;
  if (runtimeRemainingMs <= 0) return { ok: false, reason: "runtime_exceeded" };
  const controller = new AbortController();
  let abortReason: "cancelled" | "runtime_exceeded" | "timeout" | undefined;
  const externalAbort = () => {
    abortReason = "cancelled";
    controller.abort();
  };
  const interruptionAbort = () => {
    abortReason = "cancelled";
    controller.abort();
  };
  externalSignal?.addEventListener("abort", externalAbort, { once: true });
  interruptionSignal.addEventListener("abort", interruptionAbort, { once: true });
  const requestDeadlineMs = Math.min(config.limits.requestTimeoutMs, runtimeRemainingMs);
  const timer = setTimeout(() => {
    abortReason =
      runtimeRemainingMs <= config.limits.requestTimeoutMs ? "runtime_exceeded" : "timeout";
    controller.abort();
  }, requestDeadlineMs);
  const operation = Promise.resolve().then(() => execute(controller.signal));
  void operation.catch(() => undefined);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () =>
      reject(new TransloaditRequestAbort({ reason: abortReason ?? "cancelled" }));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return { ok: true, value: await Promise.race([operation, aborted]) };
  } catch (error) {
    if (error instanceof TransloaditRequestAbort) {
      return { ok: false, reason: error.reason };
    }
    if (error instanceof TransloaditBodyAborted) {
      return { ok: false, reason: abortReason ?? "cancelled" };
    }
    return { ok: false, reason: "transport" };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", externalAbort);
    interruptionSignal.removeEventListener("abort", interruptionAbort);
    controller.abort();
  }
}

function runtimeFenceFitsConfiguration(
  config: TransloaditConfig,
  operation: TransloaditOperationSnapshot,
  nowMs: number,
): boolean {
  const { submittedAtMs, runtimeDeadlineMs } = operation.runtimeFence;
  return (
    // The caller and adapter share one server clock. Positive future skew is
    // deliberately not accepted because it would extend provider wall time.
    submittedAtMs <= nowMs &&
    runtimeDeadlineMs - submittedAtMs <= config.limits.maxAssemblyRuntimeMs
  );
}

function attemptFor(
  operation: TransloaditOperationSnapshot,
  providerJobId: string | undefined = operation.resumeJobId,
): MediaTransformAttempt {
  return Object.freeze({
    version: "media-transform-attempt-v1",
    runtimeFence: operation.runtimeFence,
    ...(providerJobId === undefined ? {} : { providerJobId }),
  });
}

function acceptedAttemptFor(
  operation: TransloaditOperationSnapshot,
  providerJobId: string,
): MediaTransformAcceptedAttempt {
  return Object.freeze({
    version: "media-transform-attempt-v1",
    runtimeFence: operation.runtimeFence,
    providerJobId,
  });
}

function templateFor(config: TransloaditConfig, operation: TransloaditOperationSnapshot): string {
  if (operation.kind === "probe") return config.templates.probe;
  return operation.variant === "primary"
    ? config.templates.samplePrimary
    : config.templates.sampleAlternate;
}

function outputObjectKey(
  operation: Extract<TransloaditOperationSnapshot, { kind: "sample" }>,
): string {
  const binding = operation.binding;
  return [
    "media-transform",
    binding.operationId,
    `audio-r${binding.audioRevision}`,
    `analysis-r${binding.analysisRevision}`,
    binding.requestId,
    `${operation.variant}.wav`,
  ].join("/");
}

async function createRequest(
  config: TransloaditConfig,
  operation: TransloaditOperationSnapshot,
  signal: AbortSignal,
): Promise<TransloaditTransportResponse> {
  const now = config.nowMilliseconds();
  if (!validClockMilliseconds(now)) throw new RangeError("invalid_clock");
  const nonce = await stableTransloaditNonce(operation);
  const fields: Record<string, string | number> = {
    operation_id: operation.binding.operationId,
    audio_revision: operation.binding.audioRevision,
    analysis_revision: operation.binding.analysisRevision,
    canonical_audio_sha256: operation.binding.canonicalAudioSha256,
    request_id: operation.binding.requestId,
    source_object_key: operation.sourceObjectKey,
    transform_kind: operation.kind,
  };
  if (operation.kind === "sample") {
    const window = mediaTransformSampleWindow(operation.sourceDurationMs, operation.variant);
    fields.sample_variant = operation.variant;
    fields.sample_offset_seconds = window.offsetMs / 1_000;
    fields.sample_duration_seconds = window.durationMs / 1_000;
    fields.output_object_key = outputObjectKey(operation);
  }
  const params = JSON.stringify({
    auth: {
      key: config.credentials.authKey,
      expires: new Date(now + TRANSLOADIT_SIGNATURE_TTL_MS).toISOString(),
      nonce,
      max_number_of_files: 1,
    },
    template_id: templateFor(config, operation),
    fields,
  });
  const signature = await signTransloaditParams(config.credentials.authSecret, params);
  const multipart = encodeTransloaditMultipart(params, signature, nonce);
  if (multipart.body.byteLength > config.limits.maxRequestBytes) {
    throw new RangeError("request_too_large");
  }
  return toPromise(
    config.request({
      requestId: operation.binding.requestId,
      method: "POST",
      url: `${TRANSLOADIT_ORIGIN}${TRANSLOADIT_ASSEMBLIES_PATH}`,
      headers: {
        accept: "application/json",
        "content-type": multipart.contentType,
        "content-length": String(multipart.body.byteLength),
      },
      body: multipart.body,
      signal,
      redirect: "error",
    }),
  );
}

function pollRequest(
  config: TransloaditConfig,
  operation: TransloaditOperationSnapshot,
  signal: AbortSignal,
): Promise<TransloaditTransportResponse> {
  const providerJobId = operation.resumeJobId;
  if (providerJobId === undefined) throw new TypeError("missing_job_id");
  return toPromise(
    config.request({
      requestId: operation.binding.requestId,
      method: "GET",
      url: transloaditJobUrl(providerJobId),
      headers: { accept: "application/json" },
      signal,
      redirect: "error",
    }),
  );
}

function withContext(
  operation: TransloaditOperationSnapshot,
  config: TransloaditConfig,
  outcome: WithoutOperationMetadata<OperationFailure>,
  providerJobId: string | undefined = operation.resumeJobId,
): OperationOutcome {
  return Object.freeze({
    ...outcome,
    attempt: attemptFor(operation, providerJobId),
    context: transloaditAttemptContext(operation.binding, config.adapterRevision),
  });
}

function statusOutcome(
  operation: TransloaditOperationSnapshot,
  config: TransloaditConfig,
  response: TransloaditTransportResponse,
): OperationOutcome | null {
  if (response.status === 429) {
    disposeResponse(response);
    const retryAfterMs = retryAfterMilliseconds(response.headers);
    return withContext(operation, config, {
      status: "retryable_failure",
      reason: "throttled",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (response.status === 401 || response.status === 403) {
    disposeResponse(response);
    return withContext(operation, config, {
      status: "rejected",
      reason: "unauthorized",
    });
  }
  if (response.status === 404) {
    disposeResponse(response);
    return withContext(operation, config, {
      status: "rejected",
      reason: "job_not_found",
    });
  }
  if (response.status >= 500) {
    disposeResponse(response);
    return withContext(operation, config, {
      status: "retryable_failure",
      reason: "provider",
    });
  }
  if (response.status < 200 || response.status >= 300) {
    disposeResponse(response);
    return withContext(operation, config, {
      status: "rejected",
      reason: "provider_rejected",
    });
  }
  return null;
}

function failedAssemblyOutcome(
  operation: TransloaditOperationSnapshot,
  config: TransloaditConfig,
  assembly: Extract<TransloaditAssembly, { state: "failed" }>,
): OperationOutcome {
  if (assembly.providerCode === "ASSEMBLY_STATUS_FETCHING_RATE_LIMIT_REACHED") {
    return withContext(
      operation,
      config,
      {
        status: "retryable_failure",
        reason: "throttled",
      },
      assembly.providerJobId,
    );
  }
  if (
    assembly.providerCode === "INVALID_SIGNATURE" ||
    assembly.providerCode === "AUTHENTICATION_ERROR"
  ) {
    return withContext(
      operation,
      config,
      {
        status: "rejected",
        reason: "unauthorized",
      },
      assembly.providerJobId,
    );
  }
  if (
    assembly.providerCode === "ASSEMBLY_NOT_FOUND" ||
    assembly.providerCode === "NO_SUCH_ASSEMBLY"
  ) {
    return withContext(
      operation,
      config,
      {
        status: "rejected",
        reason: "job_not_found",
      },
      assembly.providerJobId,
    );
  }
  return withContext(
    operation,
    config,
    {
      status: "rejected",
      reason: "provider_rejected",
    },
    assembly.providerJobId,
  );
}

async function consumeOperationResponse(
  config: TransloaditConfig,
  operation: TransloaditOperationSnapshot,
  response: TransloaditTransportResponse,
  signal: AbortSignal,
): Promise<OperationOutcome> {
  const early = statusOutcome(operation, config, response);
  if (early !== null) return early;
  let value: unknown;
  try {
    value = await readBoundedTransloaditJson(response, config.limits.maxResponseBytes, signal);
  } catch (error) {
    if (error instanceof TransloaditBodyAborted) throw error;
    const reason =
      error instanceof TransloaditBodyTooLarge
        ? "response_too_large"
        : error instanceof SyntaxError
          ? "malformed_json"
          : error instanceof TypeError && error.message === "wrong_content_type"
            ? "wrong_content_type"
            : "unsupported_shape";
    return withContext(operation, config, {
      status: "malformed_response",
      reason,
    });
  }
  const parsed = parseTransloaditAssembly(value, operation.resumeJobId, resultStepFor(operation));
  if (!parsed.ok) {
    return withContext(operation, config, {
      status: "malformed_response",
      reason: parsed.reason,
    });
  }
  const assembly = parsed.value;
  if (assembly.state === "processing") {
    return Object.freeze({
      status: operation.resumeJobId === undefined ? "submitted" : "processing",
      attempt: acceptedAttemptFor(operation, assembly.providerJobId),
      context: transloaditAttemptContext(operation.binding, config.adapterRevision),
    });
  }
  if (assembly.state === "failed") return failedAssemblyOutcome(operation, config, assembly);
  if (
    assembly.executionDurationMs > config.limits.maxAssemblyRuntimeMs ||
    assembly.executionDurationMs >
      operation.runtimeFence.runtimeDeadlineMs - operation.runtimeFence.submittedAtMs
  ) {
    return withContext(
      operation,
      config,
      {
        status: "rejected",
        reason: "runtime_exceeded",
      },
      assembly.providerJobId,
    );
  }
  const context = transloaditAttemptContext(operation.binding, config.adapterRevision);
  const completed =
    operation.kind === "probe"
      ? probeFromAssembly(assembly, context, acceptedAttemptFor(operation, assembly.providerJobId))
      : sampleFromAssembly(
          assembly,
          operation,
          context,
          acceptedAttemptFor(operation, assembly.providerJobId),
          outputObjectKey(operation),
          config.limits.maxSampleBytes,
        );
  if (completed.status === "completed") return completed;
  return withContext(
    operation,
    config,
    {
      ...completed,
    },
    assembly.providerJobId,
  );
}

async function executeOperation(
  config: TransloaditConfig,
  operation: TransloaditOperationSnapshot,
  interruptionSignal: AbortSignal,
  nowMs: number,
): Promise<OperationOutcome> {
  if (nowMs >= operation.runtimeFence.runtimeDeadlineMs) {
    return withContext(operation, config, {
      status: "rejected",
      reason: "runtime_exceeded",
    });
  }
  const execution = await executeWithDeadline(
    config,
    operation.runtimeFence.runtimeDeadlineMs,
    operation.signal,
    interruptionSignal,
    async (signal) => {
      const response =
        operation.resumeJobId === undefined
          ? await createRequest(config, operation, signal)
          : await pollRequest(config, operation, signal);
      return consumeOperationResponse(config, operation, response, signal);
    },
  );
  if (execution.ok) return execution.value;
  if (execution.reason === "runtime_exceeded") {
    return withContext(operation, config, {
      status: "rejected",
      reason: "runtime_exceeded",
    });
  }
  return withContext(operation, config, {
    status: "retryable_failure",
    reason: execution.reason,
  });
}

function cancelRequest(
  config: TransloaditConfig,
  input: TransloaditCancelSnapshot,
  signal: AbortSignal,
): Promise<TransloaditTransportResponse> {
  const request: TransloaditTransportRequest = {
    requestId: input.requestId,
    method: "DELETE",
    url: transloaditJobUrl(input.providerJobId),
    headers: { accept: "application/json" },
    signal,
    redirect: "error",
  };
  return toPromise(config.request(request));
}

async function executeCancel(
  config: TransloaditConfig,
  input: TransloaditCancelSnapshot,
  interruptionSignal: AbortSignal,
): Promise<MediaTransformCancelOutcome> {
  const execution = await executeWithDeadline(
    config,
    undefined,
    input.signal,
    interruptionSignal,
    async (signal) => {
      const response = await cancelRequest(config, input, signal);
      const retryAfterMs = retryAfterMilliseconds(response.headers);
      disposeResponse(response);
      if (response.status >= 200 && response.status < 300) {
        return { status: "cancellation_accepted", providerJobId: input.providerJobId } as const;
      }
      if (response.status === 404) {
        return {
          status: "rejected",
          reason: "job_not_found",
          providerJobId: input.providerJobId,
        } as const;
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: "rejected",
          reason: "unauthorized",
          providerJobId: input.providerJobId,
        } as const;
      }
      if (response.status === 429 || response.status >= 500) {
        return {
          status: "retryable_failure",
          reason: response.status === 429 ? "throttled" : "provider",
          providerJobId: input.providerJobId,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        } as const;
      }
      return {
        status: "rejected",
        reason: "provider_rejected",
        providerJobId: input.providerJobId,
      } as const;
    },
  );
  if (execution.ok) return execution.value;
  return {
    status: "retryable_failure",
    reason: execution.reason === "runtime_exceeded" ? "timeout" : execution.reason,
    providerJobId: input.providerJobId,
  };
}

function invalidConfigurationService(
  reason: ConstructorParameters<typeof MediaTransformRequestInvalid>[0]["reason"],
): MediaTransformService {
  const failure = () => Effect.fail(new MediaTransformRequestInvalid({ reason }));
  return {
    probe: failure,
    extractAudioSample: failure,
    extractCanonicalAudioSegment: failure,
    alignVideoSoundtrackToSong: failure,
    cancelAssembly: failure,
  };
}

function operationEffect(
  config: TransloaditConfig,
  operation: TransloaditOperationSnapshot,
): Effect.Effect<OperationOutcome, MediaTransformRequestInvalid> {
  return Effect.suspend(() => {
    const nowMs = config.nowMilliseconds();
    if (!validClockMilliseconds(nowMs)) {
      return Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_clock" }));
    }
    if (!runtimeFenceFitsConfiguration(config, operation, nowMs)) {
      return Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_runtime_fence" }));
    }
    return Effect.promise((interruptionSignal) =>
      executeOperation(config, operation, interruptionSignal, nowMs),
    );
  });
}

/**
 * No network fallback exists. Without explicit enablement and an injected
 * transport, every method is inert and returns `disabled`.
 */
export function makeTransloaditMediaTransform(
  options: TransloaditMediaTransformOptions = {},
): MediaTransformService {
  if (options.enabled !== true) {
    return {
      probe: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
      extractAudioSample: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
      extractCanonicalAudioSegment: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
      alignVideoSoundtrackToSong: (input) =>
        Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
      cancelAssembly: () => Effect.succeed({ status: "unavailable", reason: "disabled" } as const),
    };
  }
  const configuration = snapshotTransloaditOptions(options as EnabledTransloaditOptions);
  if (!configuration.ok) return invalidConfigurationService(configuration.reason);
  const config = configuration.value;
  return {
    probe: (input) => {
      const snapshot = snapshotProbeInput(input);
      if (!snapshot.ok) {
        return Effect.fail(new MediaTransformRequestInvalid({ reason: snapshot.reason }));
      }
      return operationEffect(config, snapshot.value) as Effect.Effect<
        MediaTransformProbeOutcome,
        MediaTransformRequestInvalid
      >;
    },
    extractAudioSample: (input) => {
      const snapshot = snapshotSampleInput(input);
      if (!snapshot.ok) {
        return Effect.fail(new MediaTransformRequestInvalid({ reason: snapshot.reason }));
      }
      return operationEffect(config, snapshot.value) as Effect.Effect<
        MediaTransformAudioSampleOutcome,
        MediaTransformRequestInvalid
      >;
    },
    extractCanonicalAudioSegment: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
    alignVideoSoundtrackToSong: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
    cancelAssembly: (input) => {
      const snapshot = snapshotCancelInput(input);
      if (!snapshot.ok) {
        return Effect.fail(new MediaTransformRequestInvalid({ reason: snapshot.reason }));
      }
      return Effect.promise((interruptionSignal) =>
        executeCancel(config, snapshot.value, interruptionSignal),
      );
    },
  };
}

/** Default test/runtime handoff: injected fake seam, provider disabled. */
export const disabledTransloaditMediaTransform = makeTransloaditMediaTransform();
