import { describe, expect, test } from "bun:test";
import { scheduleStudyReviewV1 } from "./review-schedule.ts";

const first = { difficulty: 5, lapses: 0, repetitions: 0, reviewedAt: 0, stability: 1 };

describe("Study review schedule v1", () => {
  test("ports the frozen first-review intervals", () => {
    expect(scheduleStudyReviewV1(first, "again")).toMatchObject({
      difficulty: 6.2,
      dueAt: 600_000,
      lapses: 1,
      repetitions: 1,
      stability: 0.5,
      state: "learning",
    });
    expect(scheduleStudyReviewV1(first, "hard")).toMatchObject({ stability: 1, state: "review" });
    expect(scheduleStudyReviewV1(first, "good")).toMatchObject({ stability: 2, difficulty: 4.75 });
    expect(scheduleStudyReviewV1(first, "easy")).toMatchObject({ stability: 4, difficulty: 4.2 });
  });

  test("clamps and rounds repeated reviews", () => {
    expect(
      scheduleStudyReviewV1(
        { difficulty: 9.9, lapses: 2, repetitions: 4, reviewedAt: 1, stability: 300 },
        "hard",
      ),
    ).toMatchObject({ difficulty: 10, stability: 360, lapses: 2, repetitions: 5 });
  });
});
