import { describe, expect, test } from "bun:test";
import {
  gradeAcceptedTextV2,
  gradeEnglishTranscriptV2,
  gradeExactChoiceV2,
  gradeTranscriptV2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V1,
  STUDY_TRANSCRIPT_GRADER_POLICY_V2,
  studyTranscriptReviewGrade,
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
      matchKind: "none",
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
      policyRevision: "script_aware_token_phonetic_v2",
    });
  });

  test("ports English contraction, article, diacritic, and plural handling", () => {
    expect(gradeEnglishTranscriptV2("The cafés won't stay", "cafe will not stays").correct).toBe(
      true,
    );
  });

  test("does not accept a substitution as a correct transcript", () => {
    const grade = gradeTranscriptV2(
      "i love you",
      "i hate you",
      "en",
      STUDY_TRANSCRIPT_GRADER_POLICY_V2,
    );
    expect(grade.correct).toBe(false);
    expect(grade.substituted).toHaveLength(1);
  });

  test("keeps strict v1 immutable while v2 accepts a calibrated English near-match", () => {
    const strict = gradeTranscriptV2(
      "hold me close",
      "hold me closed",
      "en",
      STUDY_TRANSCRIPT_GRADER_POLICY_V1,
    );
    const phonetic = gradeTranscriptV2(
      "hold me close",
      "hold me closed",
      "en",
      STUDY_TRANSCRIPT_GRADER_POLICY_V2,
    );
    expect(strict).toMatchObject({ correct: false, matchKind: "none" });
    expect(phonetic).toMatchObject({ correct: true, matchKind: "phonetic" });
    expect(phonetic).toMatchObject({ matched: [], missing: [], extra: [], substituted: [] });
  });

  const acceptedNearMatches = [
    ["Shoo-be-doo", "shooby doo"],
    ["But you are all I love, what I said", "But you are all I love, what I say"],
    ["love", "loved"],
    ["He has my frown just fallin' down", "He has my frown just fallen down"],
    ["Say mum's the word, don't let it out", "Say mom's the word. Don't let it out"],
    ["There's no slippin' when he once takes hold", "There's no slipping when he once takes hold"],
  ] as const;

  for (const [reference, transcript] of acceptedNearMatches) {
    test(`ports calibrated phonetic acceptance for ${JSON.stringify(transcript)}`, () => {
      expect(gradeEnglishTranscriptV2(reference, transcript)).toMatchObject({
        correct: true,
        matchKind: "phonetic",
      });
    });
  }

  test("rejects semantic swaps and unrelated transcripts beyond the calibrated budget", () => {
    expect(gradeEnglishTranscriptV2("i love you", "i hate you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(
      gradeEnglishTranscriptV2(
        "I will always hold you close through the night",
        "I will never hold you close through the night",
      ),
    ).toMatchObject({ correct: false, matchKind: "none" });
    expect(gradeEnglishTranscriptV2("Shoo-be-doo", "the quick brown fox jumps over")).toMatchObject(
      { correct: false, matchKind: "none" },
    );
  });

  test("never applies English phonetics to a non-English source profile", () => {
    expect(
      gradeTranscriptV2("hold me close", "hold me closed", "es", STUDY_TRANSCRIPT_GRADER_POLICY_V2),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });

  test("maps match kind and attempt number to the inherited per-answer review rating", () => {
    expect(studyTranscriptReviewGrade("exact", 1)).toBe("good");
    expect(studyTranscriptReviewGrade("exact", 2)).toBe("hard");
    expect(studyTranscriptReviewGrade("phonetic", 1)).toBe("hard");
    expect(studyTranscriptReviewGrade("phonetic", 3)).toBe("hard");
    expect(studyTranscriptReviewGrade("none", 1)).toBe("again");
  });

  test("does not claim pronunciation quality from matching transcript text", () => {
    const grade = gradeEnglishTranscriptV2("Hold on", "HOLD ON!");
    expect(grade.correct).toBe(true);
    expect(Object.keys(grade)).not.toContain("pronunciation_score");
    expect(Object.keys(grade)).not.toContain("accent_score");
  });
});
