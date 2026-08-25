import { describe, expect, test } from "bun:test";
import {
  evaluateKaraokeQualification,
  evaluateStudyQualification,
  gradeStudyAnswer,
  recomputeActivityStreak,
  requiredStudyCorrect,
} from "./activity-qualification.ts";

describe("server-authoritative activity qualification reducers", () => {
  test("grades typed Study answers without accepting a score", () => {
    expect(
      gradeStudyAnswer(
        { kind: "text_response", text: "  SAIL   Away " },
        {
          kind: "text_response",
          comparison: "unicode_casefold_whitespace_v1",
          acceptedAnswers: ["sail away"],
        },
      ),
    ).toBe(true);
    expect(
      gradeStudyAnswer(
        { kind: "single_select", choiceKey: "choice-b" },
        { kind: "single_select", correctChoiceKey: "choice-a" },
      ),
    ).toBe(false);
    expect(() =>
      gradeStudyAnswer(
        { kind: "single_select", choiceKey: "choice-a" },
        {
          kind: "text_response",
          comparison: "unicode_casefold_whitespace_v1",
          acceptedAnswers: ["choice-a"],
        },
      ),
    ).toThrow("answer-kind");
  });

  test("uses the exact max(1, ceil(70% × n)) Study threshold and score", () => {
    expect(() => requiredStudyCorrect(0)).toThrow("empty-study-session");
    expect([1, 2, 3, 10, 11].map(requiredStudyCorrect)).toEqual([1, 2, 3, 7, 8]);
    expect(
      evaluateStudyQualification([
        { presentationCount: 1, firstPassOutcome: "correct" },
        { presentationCount: 1, firstPassOutcome: "incorrect" },
        { presentationCount: 1, firstPassOutcome: "correct" },
      ]),
    ).toEqual({
      qualifyingExerciseCount: 3,
      firstPassCorrect: 2,
      requiredCorrect: 3,
      scoreBps: 6_666,
      qualifies: false,
    });
    expect(() =>
      evaluateStudyQualification([{ presentationCount: 1, firstPassOutcome: null }]),
    ).toThrow("unanswered-study-item");
  });

  test("requires all three Karaoke policy floors", () => {
    expect(
      evaluateKaraokeQualification({
        completionReason: "completed",
        scoredLineCount: 17,
        lineCount: 20,
        finalScoreBps: 7_000,
      }),
    ).toEqual({
      scoredLineCount: 17,
      lineCount: 20,
      coverageBps: 8_500,
      finalScoreBps: 7_000,
      qualifies: true,
    });
    expect(
      evaluateKaraokeQualification({
        completionReason: "completed",
        scoredLineCount: 16,
        lineCount: 20,
        finalScoreBps: 10_000,
      }).qualifies,
    ).toBe(false);
    expect(
      evaluateKaraokeQualification({
        completionReason: "provider_unavailable",
        scoredLineCount: 20,
        lineCount: 20,
        finalScoreBps: 10_000,
      }).qualifies,
    ).toBe(false);
  });
});

describe("day-ledger streak recomputation", () => {
  test("deduplicates and recomputes out-of-order days instead of incrementing", () => {
    expect(
      recomputeActivityStreak(["2026-08-25", "2026-08-22", "2026-08-24", "2026-08-22"], "UTC"),
    ).toEqual({
      current: 2,
      best: 2,
      startedDay: "2026-08-24",
      lastDay: "2026-08-25",
      totalDays: 3,
      activeUntilAt: "2026-08-27T00:00:00.000Z",
    });
    expect(recomputeActivityStreak([], "UTC")).toBeNull();
  });

  test("computes active-until from local calendar midnights across DST", () => {
    expect(recomputeActivityStreak(["2026-03-07"], "America/New_York")?.activeUntilAt).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    expect(recomputeActivityStreak(["2026-10-31"], "America/New_York")?.activeUntilAt).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });
});
