import {
  handleVerificationCallback,
  stripVerificationCallbackCredentialHeaders,
  type VerificationCallbackServices,
} from "@pirate/application/use-cases/verification-callback";
import {
  completeVerification,
  type VerificationCompletionServices,
} from "@pirate/application/use-cases/verification-completion";
import {
  type StartVerificationServices,
  startVerification,
} from "@pirate/application/use-cases/verification-start";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderMisconfigured,
  ProviderUnavailable,
  VerificationStartInProgress,
  VerificationStartNewIntentRequired,
} from "@pirate/contracts";
import { Effect } from "effect";
import {
  type DecodedRequest,
  type EndpointHandler,
  type Principal,
  withEndpointResult,
} from "./transport.ts";

export interface VerificationHandlerServices {
  readonly start: StartVerificationServices;
  readonly completion: VerificationCompletionServices;
  readonly callback?: VerificationCallbackServices;
  /** Deployment-specific credential headers stripped in addition to platform defaults. */
  readonly callback_credential_headers?: readonly string[];
}

export type VerificationHandlers = Readonly<{
  readonly StartVerificationSession: EndpointHandler;
  readonly CompleteVerificationSession: EndpointHandler;
  readonly CompleteVerificationCallback: EndpointHandler;
}>;

function actorId(principal: Principal | null): string {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

function wireFailure(error: unknown): Error {
  const tagged = error as {
    readonly _tag?: string;
    readonly reason?: string;
    readonly retry_after_seconds?: number;
  };
  switch (tagged._tag) {
    case "VerificationProviderUnknown":
      return new NotFound({ message: "Verification provider not found" });
    case "VerificationProviderUnavailable":
      return new ProviderUnavailable({ message: "Verification provider is unavailable" });
    case "VerificationProviderMisconfigured":
    case "VerificationProviderInvalidResponse":
      return new ProviderMisconfigured({ message: "Verification provider is misconfigured" });
    case "VerificationProviderRejected":
    case "VerificationProviderUnboundRejected":
      return new BadRequest({ message: "Verification submission was rejected" });
    case "VerificationStartRejected":
      if (tagged.reason === "intent_unavailable") {
        return new NotFound({ message: "Verification intent not found" });
      }
      if (tagged.reason === "indeterminate") {
        return new ProviderUnavailable({ message: "Verification provider is unavailable" });
      }
      if (tagged.reason === "conflict") {
        return new Conflict({ message: "Verification session conflicts with this intent" });
      }
      if (tagged.reason === "in_flight") {
        const retryAfter =
          typeof tagged.retry_after_seconds === "number" &&
          Number.isSafeInteger(tagged.retry_after_seconds) &&
          tagged.retry_after_seconds > 0
            ? Math.min(tagged.retry_after_seconds, 86_400)
            : 1;
        return new VerificationStartInProgress({
          message: "Verification session start is already in progress",
          retry_after_seconds: retryAfter,
        });
      }
      if (tagged.reason === "terminal") {
        return new VerificationStartNewIntentRequired({
          message: "Verification session requires a new intent",
          details: { reason: "new_intent_required" },
        });
      }
      return new BadRequest({ message: "Verification request is unsupported" });
    case "VerificationCompletionRejected":
      if (tagged.reason === "unavailable") {
        return new NotFound({ message: "Verification session not found" });
      }
      if (tagged.reason === "attempt_in_flight") {
        return new ProviderUnavailable({
          message: "Verification provider is already processing this attempt",
        });
      }
      if (
        tagged.reason === "expired" ||
        tagged.reason === "terminal" ||
        tagged.reason === "binding_conflict" ||
        tagged.reason === "attempt_consumed" ||
        tagged.reason === "attempt_budget_exhausted"
      ) {
        return new Conflict({ message: "Verification session cannot be completed" });
      }
      return new BadRequest({ message: "Verification completion is invalid" });
    case "VerificationCallbackRejected":
      return tagged.reason === "invalid"
        ? new BadRequest({ message: "Verification callback is invalid" })
        : new NotFound({ message: "Verification callback target not found" });
    case "VerificationStartStorageFailed":
    case "VerificationCompletionStorageFailed":
    case "VerificationCompletionHashFailed":
      return new InternalError({ message: "Verification operation failed" });
    default:
      return new InternalError({ message: "Verification operation failed" });
  }
}

function completionResponse(result: {
  readonly proof_session_id: string;
  readonly status: "completed";
  readonly replayed: boolean;
}) {
  return {
    proof_session_id: result.proof_session_id,
    status: result.status,
    replayed: result.replayed,
  };
}

function startHandler(request: DecodedRequest, services: VerificationHandlerServices) {
  const body = request.body as Readonly<{ intent_id: string; provider_id: string }>;
  return Effect.runPromise(
    startVerification(
      {
        actor_id: actorId(request.principal),
        intent_id: body.intent_id,
        provider_id: body.provider_id,
      },
      services.start,
    ).pipe(
      Effect.map((result) => withEndpointResult(result, result.replayed ? 200 : 201)),
      Effect.mapError(wireFailure),
    ),
  );
}

function completeHandler(request: DecodedRequest, services: VerificationHandlerServices) {
  const path = request.params as Readonly<{ proofSessionId: string }>;
  const body = request.body as Readonly<{ idempotency_key: string; payload: unknown }>;
  return Effect.runPromise(
    completeVerification(
      {
        actor_id: actorId(request.principal),
        proof_session_id: path.proofSessionId,
        idempotency_key: body.idempotency_key,
        submission: { channel: "client_result", payload: body.payload },
      },
      services.completion,
    ).pipe(Effect.map(completionResponse), Effect.mapError(wireFailure)),
  );
}

function callbackHandler(request: DecodedRequest, services: VerificationHandlerServices) {
  const path = request.params as Readonly<{ providerId: string }>;
  const callback = services.callback ?? services.completion;
  return Effect.runPromise(
    handleVerificationCallback(
      {
        provider_id: path.providerId,
        raw_body: request.body,
        headers: stripVerificationCallbackCredentialHeaders(
          request.headers as Readonly<Record<string, string>>,
          services.callback_credential_headers,
        ),
      },
      callback,
    ).pipe(Effect.map(completionResponse), Effect.mapError(wireFailure)),
  );
}

export function makeVerificationHandlers(
  services: VerificationHandlerServices,
): VerificationHandlers {
  return {
    StartVerificationSession: (request) => startHandler(request, services),
    CompleteVerificationSession: (request) => completeHandler(request, services),
    CompleteVerificationCallback: (request) => callbackHandler(request, services),
  };
}
