import type {
  StudyAnswerSubmissionV2,
  StudyExerciseTypeV2,
  StudySessionItemV2,
} from "@pirate/contracts";
import { Data, Effect } from "effect";

export class StudyV2Rejected extends Data.TaggedError("StudyV2Rejected")<{
  readonly reason: "insufficient-exercises" | "submission-kind-mismatch";
}> {}

const submissionKindFor = (
  exerciseType: StudyExerciseTypeV2,
): StudyAnswerSubmissionV2["kind"] | null => {
  switch (exerciseType) {
    case "say_it_back":
      return null;
    case "translation_choice":
      return "single_select";
  }
};

export const validateStudySubmissionKindV2 = (
  exerciseType: StudyExerciseTypeV2,
  submission: StudyAnswerSubmissionV2,
): Effect.Effect<void, StudyV2Rejected> =>
  submission.kind === submissionKindFor(exerciseType)
    ? Effect.void
    : Effect.fail(new StudyV2Rejected({ reason: "submission-kind-mismatch" }));

export const selectProductionStudyItemsV2 = (
  items: readonly StudySessionItemV2[],
): Effect.Effect<readonly StudySessionItemV2[], StudyV2Rejected> => {
  const reviewKeys = new Set(items.map(({ exercise_review_key }) => exercise_review_key));
  return items.length >= 4 && items.length <= 10 && reviewKeys.size === items.length
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
