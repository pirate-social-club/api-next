import {
  type DanceAttemptServices,
  makeDanceAttemptService,
} from "@pirate/application/use-cases/dance/attempt-services";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type DanceAttemptHandlers = Readonly<{
  readonly CreateDanceSession: EndpointHandler;
  readonly RecordDanceSessionConsent: EndpointHandler;
  readonly ReserveDanceSessionUpload: EndpointHandler;
  readonly FinalizeDanceSessionUpload: EndpointHandler;
  readonly SubmitDanceSessionForGrading: EndpointHandler;
  readonly GetDanceSession: EndpointHandler;
}>;

function actorAccountId(principal: Principal | null): string {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/**
 * Installs private attempt commands only. Submission commits the durable
 * grading outbox and returns; no processor, Queue, or Workflow is reachable.
 */
export function makeDanceAttemptHandlers(services: DanceAttemptServices): DanceAttemptHandlers {
  const dance = makeDanceAttemptService(services);
  return {
    CreateDanceSession: async (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly postId: string;
        readonly choreographyId: string;
        readonly revision: string;
      };
      const result = await run(
        dance.create({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          songPostId: path.postId,
          choreographyId: path.choreographyId,
          choreographyRevision: path.revision,
          body: request.body,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    RecordDanceSessionConsent: (request) => {
      const path = request.params as { readonly communityId: string; readonly sessionId: string };
      return run(
        dance.consent({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
          body: request.body,
        }),
      );
    },
    ReserveDanceSessionUpload: async (request) => {
      const path = request.params as { readonly communityId: string; readonly sessionId: string };
      const result = await run(
        dance.reserve({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
          body: request.body,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    FinalizeDanceSessionUpload: (request) => {
      const path = request.params as { readonly communityId: string; readonly sessionId: string };
      return run(
        dance.finalize({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
          body: request.body,
        }),
      );
    },
    SubmitDanceSessionForGrading: async (request) => {
      const path = request.params as { readonly communityId: string; readonly sessionId: string };
      const result = await run(
        dance.submit({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
          body: request.body,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 202);
    },
    GetDanceSession: (request) => {
      const path = request.params as { readonly communityId: string; readonly sessionId: string };
      return run(
        dance.get({
          actorAccountId: actorAccountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
        }),
      );
    },
  };
}
