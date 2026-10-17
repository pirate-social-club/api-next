import {
  type ActivityCompletionStore,
  makeActivityCompletionService,
} from "@pirate/application/use-cases/rewards/activity-completion";
import type { ActivityQualificationFailure } from "@pirate/application/use-cases/rewards/activity-qualification";
import { Clock } from "@pirate/application/use-cases/rewards/activity-qualification";
import { AuthError, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";

const accountId = (principal: Principal | null): string => {
  if (principal?.kind !== "user" && principal?.kind !== "admin") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

export const makeActivityCompletionHandlers = (
  services: Readonly<{
    store: ActivityCompletionStore;
    clock: Clock["Service"];
  }>,
): Readonly<
  Record<
    | "GetStudyCompletionState"
    | "GetKaraokeCompletionState"
    | "GetSongActivityProgress"
    | "GetCommunityActivityProgress"
    | "GetActivityPresentationPersona",
    EndpointHandler
  >
> => {
  const service = makeActivityCompletionService(services.store);
  const run = <A>(effect: Effect.Effect<A, ActivityQualificationFailure, Clock>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock, services.clock),
        Effect.mapError((error) =>
          error._tag === "ActivityQualificationRejected"
            ? new NotFound({ message: "Activity state is unavailable", cause: error })
            : new InternalError({ message: "Activity state read failed", cause: error }),
        ),
      ),
    );
  return {
    GetStudyCompletionState: (request) => {
      const path = request.params as { communityId: string; sessionId: string };
      return run(
        service.getCompletion({
          ...path,
          accountId: accountId(request.principal),
          activity: "study",
          attemptId: null,
        }),
      );
    },
    GetKaraokeCompletionState: (request) => {
      const path = request.params as { communityId: string; sessionId: string; attemptId: string };
      return run(
        service.getCompletion({
          ...path,
          accountId: accountId(request.principal),
          activity: "karaoke",
        }),
      );
    },
    GetSongActivityProgress: (request) => {
      const path = request.params as { communityId: string; postId: string };
      return run(service.getProgress({ ...path, accountId: accountId(request.principal) }));
    },
    GetCommunityActivityProgress: (request) => {
      const path = request.params as { communityId: string };
      return run(
        service.getProgress({ ...path, accountId: accountId(request.principal), postId: null }),
      );
    },
    GetActivityPresentationPersona: (request) => {
      const path = request.params as { communityId: string };
      return run(service.getPresentation({ ...path, accountId: accountId(request.principal) }));
    },
  };
};
