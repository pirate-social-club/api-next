export const STUDY_REVIEW_SCHEDULE_V1 = "study_review_schedule_v1" as const;

export type StudyReviewGradeV1 = "again" | "hard" | "good" | "easy";
export type StudyReviewStateV1 = "new" | "learning" | "relearning" | "review";
export type StudyReviewScheduleInputV1 = Readonly<{
  difficulty: number;
  lapses: number;
  repetitions: number;
  reviewedAt: number;
  stability: number;
}>;

const round = (value: number): number => Math.round(value * 1_000) / 1_000;
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const scheduleStudyReviewV1 = (
  input: StudyReviewScheduleInputV1,
  grade: StudyReviewGradeV1,
) => {
  const prior = input.repetitions > 0;
  const difficultyDelta = { again: 1.2, hard: 0.35, good: -0.25, easy: -0.8 }[grade];
  const stability =
    grade === "again"
      ? clamp(input.stability / 2, 0.25, 365)
      : grade === "hard"
        ? clamp(prior ? input.stability * 1.2 : 1, 1, 365)
        : grade === "good"
          ? clamp(prior ? input.stability * 2.5 : 2, 0.25, 365)
          : clamp(prior ? input.stability * 3.5 : 4, 0.25, 365);
  const intervalMs =
    grade === "again"
      ? 10 * 60_000
      : grade === "hard"
        ? Math.max(12 * 3_600_000, stability * 86_400_000)
        : stability * 86_400_000;
  return {
    difficulty: round(clamp(input.difficulty + difficultyDelta, 1, 10)),
    dueAt: input.reviewedAt + intervalMs,
    lapses: input.lapses + (grade === "again" ? 1 : 0),
    repetitions: input.repetitions + 1,
    stability: round(stability),
    state: (grade === "again"
      ? prior
        ? "relearning"
        : "learning"
      : "review") as StudyReviewStateV1,
  };
};
