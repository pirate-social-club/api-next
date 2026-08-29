import {
  Clock,
  IdGen,
  makeStudyV2Service,
  type StudyAudioArchive,
  type StudyBatchTranscriber,
  type StudyV2Failure,
  type StudyV2Store,
} from "@pirate/application/use-cases/rewards/study-v2";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RetryableConflict,
  type StudyAnswerSubmissionV2,
} from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type StudyV2Handlers = Readonly<{
  GetStudyAvailabilityV2: EndpointHandler;
  StartStudySessionV2: EndpointHandler;
  GetStudySessionV2: EndpointHandler;
  SubmitStudyAnswerV2: EndpointHandler;
}>;

const accountId = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const wireFailure = (failure: StudyV2Failure) => {
  if (failure._tag === "StudyV2StoreFailed") {
    return new InternalError({ message: "Study operation failed" });
  }
  switch (failure.reason) {
    case "not-found":
    case "transcript-evidence-not-found":
      return new NotFound({ message: "Study target is unavailable" });
    case "attempt-conflict":
    case "idempotency-conflict":
      return new Conflict({ message: "Study command conflicts" });
    case "command-in-flight":
      return new RetryableConflict({ message: "Study command is already processing" });
    case "provider-unavailable":
      return new ProviderUnavailable({ message: "Study transcription is unavailable" });
    case "insufficient-exercises":
      return new Conflict({ message: "Study content is not ready" });
    case "invalid-input":
    case "submission-kind-mismatch":
    case "transcript-evidence-expired":
    case "transcript-evidence-mismatch":
      return new BadRequest({ message: "Study command is invalid" });
  }
};

export const makeStudyV2Handlers = (services: {
  readonly clock: Clock["Service"];
  readonly ids: IdGen["Service"];
  readonly store: StudyV2Store;
  readonly spoken?: Readonly<{
    readonly archive: StudyAudioArchive;
    readonly transcriber: StudyBatchTranscriber;
  }>;
}): StudyV2Handlers => {
  const study = makeStudyV2Service(services.store, services.spoken);
  const run = <A, E>(effect: Effect.Effect<A, E, Clock | IdGen>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock, services.clock),
        Effect.provideService(IdGen, services.ids),
        Effect.mapError((error) => wireFailure(error as StudyV2Failure)),
      ),
    );
  return {
    GetStudyAvailabilityV2: (request) => {
      const path = request.params as { communityId: string; postId: string };
      return run(
        study.getAvailability({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          postId: path.postId,
        }),
      );
    },
    StartStudySessionV2: async (request) => {
      const path = request.params as { communityId: string; postId: string };
      const body = request.body as {
        idempotency_key: string;
        learner_band: "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null;
        persona_id: string;
        target_language: string | null;
        timezone: string;
      };
      const session = await run(
        study.startSession({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          targetLanguage: body.target_language,
          idempotencyKey: body.idempotency_key,
          learnerBand: body.learner_band,
          personaId: body.persona_id,
          postId: path.postId,
          timezone: body.timezone,
        }),
      );
      return withEndpointResult(session, 201);
    },
    GetStudySessionV2: (request) => {
      const path = request.params as { communityId: string; sessionId: string };
      return run(
        study.getSession({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          sessionId: path.sessionId,
        }),
      );
    },
    SubmitStudyAnswerV2: (request) => {
      const path = request.params as {
        communityId: string;
        sessionId: string;
        sessionItemId: string;
      };
      const headers = request.headers as {
        readonly "content-type": string;
        readonly "idempotency-key": string;
        readonly "x-audio-duration-ms"?: string;
        readonly "x-study-attempt-number": string;
      };
      const attemptNumber = Number(headers["x-study-attempt-number"]);
      if (request.body instanceof Uint8Array) {
        const duration = headers["x-audio-duration-ms"];
        if (duration === undefined) {
          return Promise.reject(new BadRequest({ message: "Study audio duration is required" }));
        }
        return run(
          study.submitSpokenAnswer({
            accountId: accountId(request.principal),
            attemptNumber,
            audio: request.body,
            audioContentType: headers["content-type"],
            audioDurationMs: Number(duration),
            communityId: path.communityId,
            idempotencyKey: headers["idempotency-key"],
            sessionId: path.sessionId,
            sessionItemId: path.sessionItemId,
          }),
        );
      }
      return run(
        study.submitAnswer({
          accountId: accountId(request.principal),
          answer: request.body as StudyAnswerSubmissionV2,
          attemptNumber,
          communityId: path.communityId,
          idempotencyKey: headers["idempotency-key"],
          sessionId: path.sessionId,
          sessionItemId: path.sessionItemId,
        }),
      );
    },
  };
};
