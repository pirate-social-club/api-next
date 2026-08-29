import type {
  StudyAnswerResultV2,
  StudyAnswerSubmissionV2,
  StudyExerciseTypeV2,
  StudySessionItemV2,
} from "@pirate/contracts";
import { Data, Effect } from "effect";

export class StudyV2Rejected extends Data.TaggedError("StudyV2Rejected")<{
  readonly reason:
    | "insufficient-exercises"
    | "submission-kind-mismatch"
    | "transcript-evidence-expired"
    | "transcript-evidence-mismatch"
    | "transcript-evidence-not-found";
}> {}

export class StudyV2InfrastructureFailed extends Data.TaggedError("StudyV2InfrastructureFailed")<{
  readonly operation: "transcript-evidence-load";
}> {}

export type TranscriptEvidenceV2 = Readonly<{
  accountId: string;
  evidenceId: string;
  expiresAt: number;
  sessionItemId: string;
  transcript: string;
}>;

export interface TranscriptEvidenceStoreV2 {
  readonly load: (
    evidenceId: string,
  ) => Effect.Effect<TranscriptEvidenceV2 | null, StudyV2InfrastructureFailed>;
}

export type StudyAttemptReservationV2 =
  | Readonly<{ kind: "ready"; attemptId: string; transcript: string | null }>
  | Readonly<{ kind: "replayed"; result: StudyAnswerResultV2 }>;

export interface StudyAttemptReservationStoreV2 {
  readonly reserve: (input: {
    readonly accountId: string;
    readonly attemptNumber: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly sessionItemId: string;
  }) => Effect.Effect<StudyAttemptReservationV2, StudyV2InfrastructureFailed>;
}

const submissionKindFor = (exerciseType: StudyExerciseTypeV2): StudyAnswerSubmissionV2["kind"] => {
  switch (exerciseType) {
    case "say_it_back":
      return "transcript_response";
    case "translation_choice":
      return "single_select";
    case "typed_cloze":
      return "text_response";
  }
};

export const validateStudySubmissionKindV2 = (
  exerciseType: StudyExerciseTypeV2,
  submission: StudyAnswerSubmissionV2,
): Effect.Effect<void, StudyV2Rejected> =>
  submission.kind === submissionKindFor(exerciseType)
    ? Effect.void
    : Effect.fail(new StudyV2Rejected({ reason: "submission-kind-mismatch" }));

export const resolveTranscriptEvidenceV2 = Effect.fn("resolveTranscriptEvidenceV2")(function* (
  input: {
    readonly accountId: string;
    readonly evidenceId: string;
    readonly now: number;
    readonly sessionItemId: string;
  },
  store: TranscriptEvidenceStoreV2,
) {
  const evidence = yield* store.load(input.evidenceId);
  if (evidence === null) {
    return yield* new StudyV2Rejected({ reason: "transcript-evidence-not-found" });
  }
  if (evidence.accountId !== input.accountId || evidence.sessionItemId !== input.sessionItemId) {
    return yield* new StudyV2Rejected({ reason: "transcript-evidence-mismatch" });
  }
  if (evidence.expiresAt <= input.now) {
    return yield* new StudyV2Rejected({ reason: "transcript-evidence-expired" });
  }
  return evidence;
});

export const prepareStudyAttemptV2 = Effect.fn("prepareStudyAttemptV2")(function* (input: {
  readonly accountId: string;
  readonly attemptNumber: number;
  readonly exerciseType: StudyExerciseTypeV2;
  readonly idempotencyKey: string;
  readonly now: number;
  readonly requestHash: string;
  readonly sessionItemId: string;
  readonly submission: StudyAnswerSubmissionV2;
  readonly evidenceStore: TranscriptEvidenceStoreV2;
  readonly reservationStore: StudyAttemptReservationStoreV2;
}) {
  yield* validateStudySubmissionKindV2(input.exerciseType, input.submission);
  const transcript =
    input.submission.kind === "transcript_response"
      ? (yield* resolveTranscriptEvidenceV2(
          {
            accountId: input.accountId,
            evidenceId: input.submission.transcript_evidence_id,
            now: input.now,
            sessionItemId: input.sessionItemId,
          },
          input.evidenceStore,
        )).transcript
      : null;
  const reservation = yield* input.reservationStore.reserve({
    accountId: input.accountId,
    attemptNumber: input.attemptNumber,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    sessionItemId: input.sessionItemId,
  });
  return reservation.kind === "replayed" ? reservation : { ...reservation, transcript };
});

export const selectProductionStudyItemsV2 = (
  items: readonly StudySessionItemV2[],
): Effect.Effect<readonly StudySessionItemV2[], StudyV2Rejected> => {
  const reviewKeys = new Set(items.map(({ exercise_review_key }) => exercise_review_key));
  return items.length >= 4 && items.length <= 64 && reviewKeys.size === items.length
    ? Effect.succeed(items)
    : Effect.fail(new StudyV2Rejected({ reason: "insufficient-exercises" }));
};

export type StudyProgressV2 = Readonly<{
  answeredExerciseCount: number;
  firstPassCorrect: number;
  qualifyingExerciseCount: number;
  qualified: boolean;
  requiredCorrect: number;
  scoreBps: number;
}>;

export const deriveStudyProgressV2 = (
  firstPassOutcomes: readonly ("correct" | "incorrect")[],
  exerciseCount: number,
): StudyProgressV2 => {
  const firstPassCorrect = firstPassOutcomes.filter((outcome) => outcome === "correct").length;
  const requiredCorrect = Math.max(1, Math.ceil((7 * exerciseCount) / 10));
  return {
    answeredExerciseCount: firstPassOutcomes.length,
    firstPassCorrect,
    qualifyingExerciseCount: exerciseCount,
    qualified: firstPassOutcomes.length === exerciseCount && firstPassCorrect >= requiredCorrect,
    requiredCorrect,
    scoreBps: Math.floor((10_000 * firstPassCorrect) / exerciseCount),
  };
};
