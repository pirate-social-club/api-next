import {
  Clock,
  type LearnerAudioDeletionFailed,
  type LearnerAudioDeletionStore,
  makeLearnerAudioDeletionService,
} from "@pirate/application/use-cases/learner-audio-deletion";
import { AuthError, Conflict, InternalError, ProviderUnavailable } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";

export type LearnerAudioHandlers = Readonly<{
  DeleteMyLearnerAudio: EndpointHandler;
}>;

const accountId = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const wireFailure = (failure: LearnerAudioDeletionFailed) => {
  switch (failure.reason) {
    case "in-flight":
      return new Conflict({ message: "Audio capture is still in progress" });
    case "storage-unavailable":
      return new ProviderUnavailable({ message: "Learner audio storage is unavailable" });
    case "store-unavailable":
      return new InternalError({ message: "Learner audio deletion failed" });
  }
};

export const makeLearnerAudioHandlers = (services: {
  readonly clock: Clock["Service"];
  readonly store: LearnerAudioDeletionStore;
}): LearnerAudioHandlers => {
  const service = makeLearnerAudioDeletionService(services.store);
  return {
    DeleteMyLearnerAudio: (request) =>
      Effect.runPromise(
        service
          .deleteMine(accountId(request.principal))
          .pipe(Effect.provideService(Clock, services.clock), Effect.mapError(wireFailure)),
      ),
  };
};
