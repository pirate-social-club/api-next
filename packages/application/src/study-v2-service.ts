import type {
  StudyAnswerResultV2,
  StudyAnswerSubmissionV2,
  StudyAvailabilityV2,
  StudyLearnerBandV2,
  StudySessionV2,
} from "@pirate/contracts";
import { Data, Effect } from "effect";
import { Clock, IdGen } from "./ports.ts";
import { canonicalBodyHash } from "./use-cases/content/common.ts";

export class StudyV2StoreFailed extends Data.TaggedError("StudyV2StoreFailed")<{
  readonly reason: "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class StudyV2CommandRejected extends Data.TaggedError("StudyV2CommandRejected")<{
  readonly reason:
    | "attempt-conflict"
    | "idempotency-conflict"
    | "insufficient-exercises"
    | "invalid-input"
    | "not-found"
    | "submission-kind-mismatch"
    | "transcript-evidence-expired"
    | "transcript-evidence-mismatch"
    | "transcript-evidence-not-found";
}> {}

export type StudyV2Failure = StudyV2StoreFailed | StudyV2CommandRejected;

export interface StudyV2Store {
  readonly getAvailability: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly postId: string;
  }) => Effect.Effect<StudyAvailabilityV2, StudyV2Failure>;
  readonly startSession: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly createdAt: string;
    readonly helperLanguage: string | null;
    readonly idempotencyKey: string;
    readonly learnerBand: StudyLearnerBandV2;
    readonly personaId: string;
    readonly postId: string;
    readonly requestHash: string;
    readonly sessionId: string;
    readonly timezone: string;
  }) => Effect.Effect<StudySessionV2, StudyV2Failure>;
  readonly getSession: (input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly sessionId: string;
  }) => Effect.Effect<StudySessionV2 | null, StudyV2Failure>;
  readonly submitAnswer: (input: {
    readonly accountId: string;
    readonly acceptedAt: string;
    readonly answer: StudyAnswerSubmissionV2;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly communityId: string;
    readonly idempotencyKey: string;
    readonly qualificationId: string;
    readonly requestHash: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
  }) => Effect.Effect<StudyAnswerResultV2, StudyV2Failure>;
}

const rejected = (reason: StudyV2CommandRejected["reason"]) =>
  new StudyV2CommandRejected({ reason });

const hash = (value: unknown) =>
  canonicalBodyHash(value).pipe(Effect.mapError(() => rejected("invalid-input")));

const instant = (milliseconds: number): string => new Date(milliseconds).toISOString();

export const makeStudyV2Service = (store: StudyV2Store) => ({
  getAvailability: store.getAvailability,
  getSession: (input: Parameters<StudyV2Store["getSession"]>[0]) =>
    store
      .getSession(input)
      .pipe(
        Effect.flatMap((session) =>
          session === null ? Effect.fail(rejected("not-found")) : Effect.succeed(session),
        ),
      ),
  startSession: (
    input: Omit<
      Parameters<StudyV2Store["startSession"]>[0],
      "createdAt" | "requestHash" | "sessionId"
    >,
  ) =>
    Effect.gen(function* () {
      const requestHash = yield* hash(input);
      const ids = yield* IdGen;
      const clock = yield* Clock;
      return yield* store.startSession({
        ...input,
        requestHash,
        sessionId: `study_v2_${yield* ids.next}`,
        createdAt: instant(yield* clock.now),
      });
    }),
  submitAnswer: (
    input: Omit<
      Parameters<StudyV2Store["submitAnswer"]>[0],
      "acceptedAt" | "attemptId" | "qualificationId" | "requestHash"
    >,
  ) =>
    Effect.gen(function* () {
      const requestHash = yield* hash(input);
      const ids = yield* IdGen;
      const clock = yield* Clock;
      return yield* store.submitAnswer({
        ...input,
        requestHash,
        attemptId: `study_attempt_v2_${yield* ids.next}`,
        qualificationId: `qualification_${yield* ids.next}`,
        acceptedAt: instant(yield* clock.now),
      });
    }),
});
