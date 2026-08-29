import { describe, expect, test } from "bun:test";
import {
  gradeAcceptedTextV2,
  gradeEnglishTranscriptV2,
  gradeExactChoiceV2,
} from "./study-v2-grading.ts";

describe("Study v2 graders", () => {
  test("grades accepted text with explicit Unicode, punctuation, apostrophe, case, and space policy", () => {
    expect(gradeAcceptedTextV2("  DON’T   STOP! ", ["don't stop"])).toBe(true);
    expect(gradeAcceptedTextV2("do stop", ["don't stop"])).toBe(false);
  });

  test("grades opaque choice keys exactly", () => {
    expect(gradeExactChoiceV2("choice-a", "choice-a")).toBe(true);
    expect(gradeExactChoiceV2("Choice-A", "choice-a")).toBe(false);
  });

  test("returns deterministic matched, missing, and extra transcript spans", () => {
    expect(gradeEnglishTranscriptV2("Hold on to the night", "hold to bright night")).toEqual({
      correct: false,
      transcript: "hold to bright night",
      matched: [
        { text: "hold", start: 0, end: 4 },
        { text: "to", start: 5, end: 7 },
        { text: "night", start: 15, end: 20 },
      ],
      missing: [
        { text: "on", start: 5, end: 7 },
        { text: "the", start: 11, end: 14 },
      ],
      extra: [{ text: "bright", start: 8, end: 14 }],
      policyRevision: "source_token_diff_en_v1",
    });
  });

  test("does not claim pronunciation quality from matching transcript text", () => {
    const grade = gradeEnglishTranscriptV2("Hold on", "HOLD ON!");
    expect(grade.correct).toBe(true);
    expect(Object.keys(grade)).not.toContain("pronunciation_score");
    expect(Object.keys(grade)).not.toContain("accent_score");
  });
});
