import {
  makePlatformPirateHandleService,
  type PlatformPirateHandleStore,
  PlatformPirateRenameRateLimited,
  PlatformPirateRenameRejected,
} from "@pirate/application/use-cases/handles/platform-pirate-rename";
import {
  AuthError,
  CleanupPirateRenameUnavailable,
  InternalError,
  PirateHandleUnavailable,
  PlatformPirateHandleUnavailable,
  PlatformPirateInvalidLabel,
  PlatformPirateRenameIdempotencyConflict,
  RateLimited,
  StalePlatformPirateHandle,
} from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";

const accountId = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const wireFailure = (failure: unknown) => {
  if (failure instanceof PlatformPirateRenameRejected) {
    const args = { message: "Platform Pirate handle request rejected" };
    switch (failure.reason) {
      case "invalid_label":
        return new PlatformPirateInvalidLabel(args);
      case "platform_handle_unavailable":
        return new PlatformPirateHandleUnavailable(args);
      case "handle_unavailable":
        return new PirateHandleUnavailable(args);
      case "stale_platform_handle":
        return new StalePlatformPirateHandle(args);
      case "cleanup_rename_unavailable":
        return new CleanupPirateRenameUnavailable(args);
      case "idempotency_conflict":
        return new PlatformPirateRenameIdempotencyConflict(args);
    }
  }
  if (failure instanceof PlatformPirateRenameRateLimited) {
    return new RateLimited({
      message: "Platform Pirate handle request rate limited",
      retry_after_seconds: failure.retryAfterSeconds,
      details: { retry_after_seconds: failure.retryAfterSeconds },
    });
  }
  return new InternalError({ message: "Platform Pirate handle operation failed" });
};

export function makePlatformPirateHandleHandlers(
  store: PlatformPirateHandleStore,
): Readonly<Record<string, EndpointHandler>> {
  const service = makePlatformPirateHandleService(store);
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.mapError(wireFailure)));
  return {
    CheckPlatformPirateLabelAvailability: (request) => {
      const body = request.body as {
        readonly persona_id: string;
        readonly platform_handle_id: string;
        readonly desired_label: string;
      };
      return run(
        service.checkAvailability({
          accountId: accountId(request.principal),
          personaId: body.persona_id,
          platformHandleId: body.platform_handle_id,
          desiredLabel: body.desired_label,
        }),
      );
    },
    RenamePlatformPirateHandle: (request) => {
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly platform_handle_id: string;
        readonly expected_state_hash: string;
        readonly desired_label: string;
      };
      return run(
        service.rename({
          accountId: accountId(request.principal),
          personaId: body.persona_id,
          platformHandleId: body.platform_handle_id,
          expectedStateHash: body.expected_state_hash,
          desiredLabel: body.desired_label,
          idempotencyKey: body.idempotency_key,
        }),
      );
    },
  };
}
