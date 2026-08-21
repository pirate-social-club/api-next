import {
  completeNamespaceOwnership,
  type NamespaceOwnershipCompletionServices,
} from "@pirate/application/use-cases/namespace-ownership-completion";
import {
  type NamespaceOwnershipStartServices,
  startNamespaceOwnership,
} from "@pirate/application/use-cases/namespace-ownership-start";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderMisconfigured,
  ProviderUnavailable,
  RetryableConflict,
} from "@pirate/contracts";
import { Effect } from "effect";
import {
  type DecodedRequest,
  type EndpointHandler,
  type Principal,
  withEndpointResult,
} from "./transport.ts";

export interface NamespaceOwnershipHandlerServices {
  readonly start: NamespaceOwnershipStartServices;
  readonly completion: NamespaceOwnershipCompletionServices;
}

export type NamespaceOwnershipHandlers = Readonly<{
  readonly StartNamespaceOwnership: EndpointHandler;
  readonly PollNamespaceOwnership: EndpointHandler;
}>;

function actorId(principal: Principal | null): string {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

function creationIntentId(request: DecodedRequest): string {
  return (request.params as Readonly<{ intentId: string }>).intentId;
}

function retryDetails(retryAfterSeconds: unknown): Record<string, unknown> | undefined {
  return typeof retryAfterSeconds === "number" &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0
    ? { retry_after_seconds: Math.min(retryAfterSeconds, 3_600) }
    : undefined;
}

function wireFailure(error: unknown): Error {
  const tagged = error as {
    readonly _tag?: string;
    readonly reason?: string;
    readonly retry_after_seconds?: number;
  };
  switch (tagged._tag) {
    case "NamespaceOwnershipStartRejected":
      if (tagged.reason === "intent_unavailable") {
        return new NotFound({ message: "Namespace ownership intent not found" });
      }
      if (tagged.reason === "unsupported") {
        return new ProviderMisconfigured({
          message: "Namespace ownership provider is not configured",
        });
      }
      if (tagged.reason === "in_flight") {
        const details = retryDetails(tagged.retry_after_seconds);
        return new RetryableConflict({
          message: "Namespace ownership start is already in progress",
          ...(details === undefined ? {} : { details }),
        });
      }
      if (tagged.reason === "conflict" || tagged.reason === "terminal") {
        return new Conflict({ message: "Namespace ownership start conflicts with durable state" });
      }
      return new BadRequest({ message: "Namespace ownership start is invalid" });
    case "NamespaceOwnershipCompletionRejected":
      if (tagged.reason === "not_found") {
        return new NotFound({ message: "Namespace ownership session not found" });
      }
      if (tagged.reason === "completion_in_progress") {
        const details = retryDetails(tagged.retry_after_seconds);
        return new RetryableConflict({
          message: "Namespace ownership completion is already in progress",
          ...(details === undefined ? {} : { details }),
        });
      }
      if (tagged.reason === "invalid") {
        return new BadRequest({ message: "Namespace ownership completion is invalid" });
      }
      return new Conflict({
        message: "Namespace ownership completion conflicts with durable state",
      });
    case "NamespaceOwnershipProviderUnknown":
    case "NamespaceOwnershipProviderMisconfigured":
    case "NamespaceOwnershipProviderInvalidResponse":
      return new ProviderMisconfigured({
        message: "Namespace ownership provider is misconfigured",
      });
    case "NamespaceOwnershipProviderUnavailable":
      return new ProviderUnavailable({ message: "Namespace ownership provider is unavailable" });
    case "NamespaceOwnershipProviderRejected":
    case "NamespaceOwnershipProviderUnboundRejected":
    case "NamespaceOwnershipProviderObservationRejected":
      return new BadRequest({ message: "Namespace ownership evidence was rejected" });
    case "NamespaceOwnershipStartStorageFailed":
    case "NamespaceOwnershipCompletionStorageFailed":
      return new InternalError({ message: "Namespace ownership operation failed" });
    default:
      return new InternalError({ message: "Namespace ownership operation failed" });
  }
}

function pollStatus(status: string): 200 | 202 | 422 | 503 {
  if (status === "pending") return 202;
  if (status === "unavailable") return 503;
  if (status === "rejected" || status === "expired") return 422;
  return 200;
}

export function makeNamespaceOwnershipHandlers(
  services: NamespaceOwnershipHandlerServices,
): NamespaceOwnershipHandlers {
  return {
    StartNamespaceOwnership: (request) => {
      const body = request.body as Readonly<{
        ceremony_intent_id: string;
        expected_revision: number;
        idempotency_key: string;
      }>;
      return Effect.runPromise(
        startNamespaceOwnership(
          {
            actor_id: actorId(request.principal),
            creation_intent_id: creationIntentId(request),
            ceremony_intent_id: body.ceremony_intent_id,
            expected_revision: body.expected_revision,
            idempotency_key: body.idempotency_key,
          },
          services.start,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, result.replayed ? 200 : 201)),
          Effect.mapError(wireFailure),
        ),
      );
    },
    PollNamespaceOwnership: (request) => {
      const body = request.body as Readonly<{
        ceremony_intent_id: string;
        session_id: string;
        expected_revision: number;
        idempotency_key: string;
        channel: "poll_result";
      }>;
      return Effect.runPromise(
        completeNamespaceOwnership(
          {
            actor_id: actorId(request.principal),
            creation_intent_id: creationIntentId(request),
            ceremony_intent_id: body.ceremony_intent_id,
            session_id: body.session_id,
            expected_revision: body.expected_revision,
            idempotency_key: body.idempotency_key,
            channel: body.channel,
          },
          services.completion,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, pollStatus(result.status))),
          Effect.mapError(wireFailure),
        ),
      );
    },
  };
}
