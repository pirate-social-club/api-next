import {
  type HnsOwnerRecoveryPollServices,
  type HnsOwnerRecoveryStartServices,
  pollHnsOwnerRecovery,
  startHnsOwnerRecovery,
} from "@pirate/application/use-cases/hns-owner-recovery";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  OwnerRecoveryInProgress,
  ProviderMisconfigured,
  ProviderUnavailable,
} from "@pirate/contracts";
import { Effect } from "effect";
import {
  type DecodedRequest,
  type EndpointHandler,
  type Principal,
  withEndpointResult,
} from "./transport.ts";

export interface HnsOwnerRecoveryHandlerServices {
  readonly start: HnsOwnerRecoveryStartServices;
  readonly poll: HnsOwnerRecoveryPollServices;
}

export type HnsOwnerRecoveryHandlers = Readonly<{
  readonly StartHnsOwnerRecovery: EndpointHandler;
  readonly PollHnsOwnerRecovery: EndpointHandler;
}>;

function actorId(principal: Principal | null): string {
  if (principal === null || principal.kind !== "user") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

function communityId(request: DecodedRequest): string {
  return (request.params as Readonly<{ communityId: string }>).communityId;
}

function inProgress(retryAfterSeconds: unknown, message: string): Error {
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    retryAfterSeconds > 3_600
  ) {
    return new InternalError({ message: "HNS owner recovery failed" });
  }
  return new OwnerRecoveryInProgress({
    message,
    details: { retry_after_seconds: retryAfterSeconds },
  });
}

function wireFailure(error: unknown): Error {
  const tagged = error as {
    readonly _tag?: string;
    readonly reason?: string;
    readonly retry_after_seconds?: number;
  };
  switch (tagged._tag) {
    case "HnsOwnerRecoveryStartRejected":
      if (tagged.reason === "invalid") {
        return new BadRequest({ message: "HNS owner recovery start is invalid" });
      }
      if (tagged.reason === "not_found" || tagged.reason === "ineligible") {
        return new NotFound({ message: "HNS owner recovery route not found" });
      }
      if (tagged.reason === "in_flight") {
        return inProgress(
          tagged.retry_after_seconds,
          "HNS owner recovery start is already in progress",
        );
      }
      return new Conflict({ message: "HNS owner recovery start conflicts with durable state" });
    case "HnsOwnerRecoveryPollRejected":
      if (tagged.reason === "invalid") {
        return new BadRequest({ message: "HNS owner recovery poll is invalid" });
      }
      if (tagged.reason === "not_found") {
        return new NotFound({ message: "HNS owner recovery session not found" });
      }
      if (tagged.reason === "in_flight") {
        return inProgress(
          tagged.retry_after_seconds,
          "HNS owner recovery poll is already in progress",
        );
      }
      return new Conflict({ message: "HNS owner recovery poll conflicts with durable state" });
    case "HnsOwnerRecoveryProviderFailed":
      return tagged.reason === "unavailable"
        ? new ProviderUnavailable({ message: "HNS owner recovery provider is unavailable" })
        : new ProviderMisconfigured({ message: "HNS owner recovery provider is misconfigured" });
    case "HnsOwnerRecoveryStartStorageFailed":
    case "HnsOwnerRecoveryPollStorageFailed":
      return new InternalError({ message: "HNS owner recovery failed" });
    default:
      return new InternalError({ message: "HNS owner recovery failed" });
  }
}

function pollStatus(status: string): 200 | 202 | 422 | 503 {
  if (status === "pending") return 202;
  if (status === "unavailable") return 503;
  if (status === "rejected" || status === "expired") return 422;
  return 200;
}

/**
 * Builds the owner-facing HTTP seam without registering it. Runtime
 * composition remains blocked until the durable store and private provider
 * transport exist and HNS enablement is explicitly authorized.
 */
export function makeHnsOwnerRecoveryHandlers(
  services: HnsOwnerRecoveryHandlerServices,
): HnsOwnerRecoveryHandlers {
  return {
    StartHnsOwnerRecovery: (request) => {
      const body = request.body as Readonly<{
        expected_generation: number;
        idempotency_key: string;
      }>;
      return Effect.runPromise(
        startHnsOwnerRecovery(
          {
            actor_id: actorId(request.principal),
            community_id: communityId(request),
            expected_generation: body.expected_generation,
            idempotency_key: body.idempotency_key,
          },
          services.start,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, result.replayed ? 200 : 201)),
          Effect.mapError(wireFailure),
        ),
      );
    },
    PollHnsOwnerRecovery: (request) => {
      const body = request.body as Readonly<{
        route_recovery_id: string;
        session_id: string;
        expected_generation: number;
        idempotency_key: string;
        channel: "poll_result";
      }>;
      return Effect.runPromise(
        pollHnsOwnerRecovery(
          {
            actor_id: actorId(request.principal),
            community_id: communityId(request),
            route_recovery_id: body.route_recovery_id,
            session_id: body.session_id,
            expected_generation: body.expected_generation,
            idempotency_key: body.idempotency_key,
            channel: body.channel,
          },
          services.poll,
        ).pipe(
          Effect.map((result) => withEndpointResult(result, pollStatus(result.status))),
          Effect.mapError(wireFailure),
        ),
      );
    },
  };
}
