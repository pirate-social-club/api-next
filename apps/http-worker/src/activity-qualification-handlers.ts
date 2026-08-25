import {
  type ActivityQualificationFailure,
  type ActivityQualificationStore,
  Clock,
  IdGen,
  makeActivityQualificationService,
  StudyItemSource,
} from "@pirate/application";
import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type ActivityQualificationHandlerServices = Readonly<{
  readonly clock: Clock["Service"];
  readonly ids: IdGen["Service"];
  readonly store: ActivityQualificationStore;
  readonly studyItemSource: StudyItemSource["Service"];
}>;

export type ActivityQualificationHandlers = Readonly<{
  readonly StartStudySession: EndpointHandler;
  readonly GetStudySession: EndpointHandler;
  readonly SubmitStudyAnswer: EndpointHandler;
  readonly SetAccountStreakTimezone: EndpointHandler;
  readonly SetActivityPresentationPersona: EndpointHandler;
  readonly GetSongActivityLeaderboard: EndpointHandler;
  readonly GetCommunityActivityLeaderboard: EndpointHandler;
}>;

const accountId = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const optionalAccountId = (principal: Principal | null): string | null =>
  principal?.kind === "user" || principal?.kind === "admin" ? principal.subject : null;

const wireFailure = (failure: ActivityQualificationFailure) => {
  if (failure._tag === "ActivityQualificationStorageFailed") {
    return new InternalError({ message: "Activity qualification operation failed" });
  }
  switch (failure.reason) {
    case "not-found":
    case "persona-ineligible":
    case "song-unavailable":
    case "source-unavailable":
      return new NotFound({ message: "Activity qualification target is unavailable" });
    case "attempt-conflict":
    case "idempotency-conflict":
    case "timezone-change-too-soon":
      return new Conflict({ message: "Activity qualification command conflicts" });
    case "invalid-input":
      return new BadRequest({ message: "Activity qualification command is invalid" });
  }
};

export function makeActivityQualificationHandlers(
  services: ActivityQualificationHandlerServices,
): ActivityQualificationHandlers {
  const qualification = makeActivityQualificationService(services.store);
  const run = <A, E>(effect: Effect.Effect<A, E, Clock | IdGen | StudyItemSource>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock, services.clock),
        Effect.provideService(IdGen, services.ids),
        Effect.provideService(StudyItemSource, services.studyItemSource),
        Effect.mapError((error) => wireFailure(error as ActivityQualificationFailure)),
      ),
    );

  return {
    StartStudySession: async (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly timezone?: string;
      };
      const session = await run(
        qualification.startStudySession({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          personaId: body.persona_id,
          postId: path.postId,
          requestedTimezone: body.timezone ?? null,
        }),
      );
      return withEndpointResult(session, 201);
    },
    GetStudySession: (request) => {
      const path = request.params as { readonly communityId: string; readonly sessionId: string };
      return run(
        qualification.getStudySession({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
        }),
      );
    },
    SubmitStudyAnswer: (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly sessionId: string;
        readonly sessionItemId: string;
      };
      const body = request.body as {
        readonly answer: Parameters<typeof qualification.submitStudyAnswer>[0]["answer"];
        readonly attempt_number: number;
        readonly idempotency_key: string;
      };
      return run(
        qualification.submitStudyAnswer({
          accountId: accountId(request.principal),
          answer: body.answer,
          attemptNumber: body.attempt_number,
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          sessionId: path.sessionId,
          sessionItemId: path.sessionItemId,
        }),
      );
    },
    SetAccountStreakTimezone: (request) => {
      const body = request.body as {
        readonly idempotency_key: string;
        readonly timezone: string;
      };
      return run(
        qualification.setStreakTimezone({
          accountId: accountId(request.principal),
          idempotencyKey: body.idempotency_key,
          timezone: body.timezone,
        }),
      );
    },
    SetActivityPresentationPersona: (request) => {
      const path = request.params as { readonly communityId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
      };
      return run(
        qualification.setPresentationPersona({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          personaId: body.persona_id,
        }),
      );
    },
    GetSongActivityLeaderboard: (request) => {
      const path = request.params as { readonly communityId: string; readonly postId: string };
      const query = request.query as { readonly limit?: string };
      return run(
        qualification.getSongLeaderboard({
          accountId: optionalAccountId(request.principal),
          communityId: path.communityId,
          postId: path.postId,
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }),
      );
    },
    GetCommunityActivityLeaderboard: (request) => {
      const path = request.params as { readonly communityId: string };
      const query = request.query as { readonly limit?: string };
      return run(
        qualification.getCommunityLeaderboard({
          accountId: optionalAccountId(request.principal),
          communityId: path.communityId,
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }),
      );
    },
  };
}
