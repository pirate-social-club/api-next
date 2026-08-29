import { describe, expect, test } from "bun:test";
import {
  gradeAcceptedTextV2,
  gradeEnglishTranscriptV2,
  gradeExactChoiceV2,
  gradeTranscriptV2,
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

  test("returns deterministic expected positions and substitutions", () => {
    expect(gradeEnglishTranscriptV2("Hold on to the night", "hold to bright night")).toEqual({
      correct: false,
      heardTranscript: "hold to bright night",
      matched: [
        { token: "hold", position: 0 },
        { token: "night", position: 3 },
      ],
      missing: [],
      extra: [],
      substituted: [
        { expected: { token: "on", position: 1 }, heard: "to" },
        { expected: { token: "to", position: 2 }, heard: "bright" },
      ],
      policyRevision: "script_aware_token_diff_v1",
    });
  });

  test("ports English contraction, article, diacritic, and plural handling", () => {
    expect(gradeEnglishTranscriptV2("The cafés won't stay", "cafe will not stays").correct).toBe(
      true,
    );
  });

  test("does not accept a substitution as a correct transcript", () => {
    const grade = gradeTranscriptV2("hold on", "hold up", "en");
    expect(grade.correct).toBe(false);
    expect(grade.substituted).toHaveLength(1);
  });

  test("does not claim pronunciation quality from matching transcript text", () => {
    const grade = gradeEnglishTranscriptV2("Hold on", "HOLD ON!");
    expect(grade.correct).toBe(true);
    expect(Object.keys(grade)).not.toContain("pronunciation_score");
    expect(Object.keys(grade)).not.toContain("accent_score");
  });
});
