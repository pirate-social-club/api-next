import type {
  MediaIdentificationAttemptContext,
  MediaIdentificationOutcome,
  MediaIdentificationOutcomeKind,
  MediaIdentificationProviderService,
  MediaIdentificationRequest,
} from "@pirate/application/media-identification-provider";
import { MediaIdentificationRequestInvalid } from "@pirate/application/media-identification-provider";
import { Cause, Effect } from "effect";
import type {
  AcrCloudAdapterOptions,
  AcrCloudConfigSnapshot,
  AcrCloudRequestSnapshot,
  AcrCloudTransportResponse,
  AcrCloudTransportResult,
} from "./acrcloud-protocol.ts";
import {
  ACRCLOUD_DATA_TYPE,
  ACRCLOUD_IDENTIFY_PATH,
  ACRCLOUD_PROVIDER_ID,
  ACRCLOUD_SIGNATURE_VERSION,
  type AcrCloudMultipart,
  AcrCloudMultipartBoundaryCollision,
  AcrCloudResponseReadAborted,
  AcrCloudTransportFailure,
  buildAcrCloudSignature,
  clockSeconds,
  encodeAcrCloudMultipart,
  endpointForAcrCloud,
  snapshotAcrCloudOptions,
  snapshotAcrCloudRequest,
} from "./acrcloud-protocol.ts";
import { acrCloudResponseOutcome } from "./acrcloud-response.ts";

export * from "./acrcloud-protocol.ts";
export { acrCloudResponseOutcome, readBoundedAcrCloudBody } from "./acrcloud-response.ts";

type AcrCloudOutcomeKind = MediaIdentificationOutcomeKind;

function retryable(
  reason: "transport" | "provider" | "timeout" | "cancelled" | "throttled",
): AcrCloudOutcomeKind {
  return { outcome: "retryable_failure", reason };
}

function permanent(
  reason: "provider_rejected" | "sample_too_large" | "unsupported_sample" | "unauthorized",
): AcrCloudOutcomeKind {
  return { outcome: "permanent_provider_rejection", reason };
}

function transportFailureReason(error: unknown): AcrCloudOutcomeKind {
  if (error instanceof AcrCloudTransportFailure) {
    if (error.reason === "aborted") return retryable("cancelled");
    if (error.reason === "timeout") return retryable("timeout");
  }
  return retryable("transport");
}

function toEffect(
  result: AcrCloudTransportResult,
): Effect.Effect<AcrCloudTransportResponse, AcrCloudTransportFailure> {
  if (Effect.isEffect(result)) return result;
  return Effect.tryPromise({
    try: () => result,
    catch: () => new AcrCloudTransportFailure({ reason: "network" }),
  });
}

function attemptContext(
  input: AcrCloudRequestSnapshot,
  adapterRevision: string,
): MediaIdentificationAttemptContext {
  return Object.freeze({
    version: "media-identification-attempt-context-v1" as const,
    operationId: input.operationId,
    audioRevision: input.audioRevision,
    analysisRevision: input.analysisRevision,
    canonicalAudioSha256: input.canonicalAudioSha256,
    requestId: input.requestId,
    adapterRevision,
  });
}

function freezeOutcome(outcome: AcrCloudOutcomeKind): AcrCloudOutcomeKind {
  if (outcome.outcome !== "retained_reference_match") return outcome;
  return Object.freeze({
    outcome: outcome.outcome,
    evidence: Object.freeze({
      ...outcome.evidence,
      artists: Object.freeze([...outcome.evidence.artists]),
    }),
  });
}

function bindOutcome(
  context: MediaIdentificationAttemptContext,
  outcome: AcrCloudOutcomeKind,
): MediaIdentificationOutcome {
  return Object.freeze({ context, ...freezeOutcome(outcome) });
}

function configurationFailure(options: AcrCloudAdapterOptions):
  | Readonly<{ readonly ok: true; readonly value: AcrCloudConfigSnapshot }>
  | Readonly<{
      readonly ok: false;
      readonly reason:
        | "invalid_adapter_revision"
        | "invalid_limits"
        | "invalid_provider_endpoint"
        | "invalid_credentials"
        | "invalid_transport"
        | "invalid_clock";
    }> {
  try {
    return snapshotAcrCloudOptions(options);
  } catch {
    return { ok: false, reason: "invalid_transport" };
  }
}

/**
 * Isolated ACRCloud adapter. Credentials, validated policy, endpoint, clock,
 * transport function, and request metadata are snapshotted before the Effect
 * program starts. No sample/provider body/secret is projected into outcomes.
 */
export function makeAcrCloudAdapter(
  options: AcrCloudAdapterOptions,
): MediaIdentificationProviderService {
  const configuration = configurationFailure(options);
  return {
    identify: (
      input: MediaIdentificationRequest,
    ): Effect.Effect<MediaIdentificationOutcome, MediaIdentificationRequestInvalid> => {
      if (!configuration.ok) {
        return Effect.fail(new MediaIdentificationRequestInvalid({ reason: configuration.reason }));
      }
      const config = configuration.value;
      const requestResult = snapshotAcrCloudRequest(input, config.limits);
      if (!requestResult.ok) {
        return Effect.fail(new MediaIdentificationRequestInvalid({ reason: requestResult.reason }));
      }
      const request = requestResult.value;
      let timestamp: string;
      try {
        timestamp = String(clockSeconds(config.nowSeconds));
      } catch {
        return Effect.fail(new MediaIdentificationRequestInvalid({ reason: "invalid_clock" }));
      }
      const context = attemptContext(request, config.adapterRevision);
      const externalSignal = request.signal;
      if (externalSignal?.aborted) {
        return Effect.succeed(bindOutcome(context, retryable("cancelled")));
      }

      const controller = new AbortController();
      const abortFromExternal = () => controller.abort();
      externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
      const requestEffect = Effect.gen(function* () {
        const stringToSign = [
          "POST",
          ACRCLOUD_IDENTIFY_PATH,
          config.credentials.accessKey,
          ACRCLOUD_DATA_TYPE,
          ACRCLOUD_SIGNATURE_VERSION,
          timestamp,
        ].join("\n");
        const signature = yield* Effect.tryPromise({
          try: () => buildAcrCloudSignature(config.credentials.accessSecret, stringToSign),
          catch: () => new AcrCloudTransportFailure({ reason: "network" }),
        });
        let multipart: AcrCloudMultipart;
        try {
          multipart = encodeAcrCloudMultipart({
            accessKey: config.credentials.accessKey,
            timestamp,
            signature,
            filename: request.sample.filename,
            contentType: request.sample.contentType,
            sampleBytes: request.sample.bytes,
          });
        } catch (error) {
          if (error instanceof AcrCloudMultipartBoundaryCollision) {
            return yield* Effect.fail(
              new MediaIdentificationRequestInvalid({ reason: "multipart_boundary_collision" }),
            );
          }
          return yield* Effect.fail(
            new MediaIdentificationRequestInvalid({ reason: "invalid_sample" }),
          );
        }
        if (multipart.body.byteLength > config.limits.maxRequestBytes) {
          return permanent("sample_too_large");
        }
        const response = yield* toEffect(
          config.request({
            requestId: request.requestId,
            method: "POST",
            url: endpointForAcrCloud(config.host),
            headers: {
              "content-type": multipart.contentType,
            },
            body: multipart.body,
            signal: controller.signal,
            redirect: "error",
          }),
        );
        return yield* Effect.tryPromise({
          try: () =>
            acrCloudResponseOutcome(response, config.limits.maxResponseBytes, controller.signal),
          catch: (error) =>
            error instanceof AcrCloudResponseReadAborted
              ? new AcrCloudTransportFailure({ reason: "aborted" })
              : new AcrCloudTransportFailure({ reason: "network" }),
        });
      }).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            controller.abort();
            externalSignal?.removeEventListener("abort", abortFromExternal);
          }),
        ),
        Effect.timeout(config.limits.timeoutMs),
      );
      const cancellationEffect = externalSignal
        ? Effect.callback<never, AcrCloudTransportFailure>((resume) => {
            const cancel = () =>
              resume(Effect.fail(new AcrCloudTransportFailure({ reason: "aborted" })));
            externalSignal.addEventListener("abort", cancel, { once: true });
            if (externalSignal.aborted) cancel();
            return Effect.sync(() => externalSignal.removeEventListener("abort", cancel));
          })
        : Effect.never;
      return Effect.raceFirst(requestEffect, cancellationEffect).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            if (error instanceof MediaIdentificationRequestInvalid) return Effect.fail(error);
            return Effect.succeed(
              bindOutcome(
                context,
                Cause.isTimeoutError(error) ? retryable("timeout") : transportFailureReason(error),
              ),
            );
          },
          onSuccess: (outcome) => Effect.succeed(bindOutcome(context, outcome)),
        }),
        Effect.catchDefect(() => Effect.succeed(bindOutcome(context, retryable("transport")))),
      );
    },
  };
}

export {
  ACRCLOUD_DATA_TYPE,
  ACRCLOUD_IDENTIFY_PATH,
  ACRCLOUD_PROVIDER_ID,
  ACRCLOUD_SIGNATURE_VERSION,
};
