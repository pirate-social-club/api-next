import { describe, expect, test } from "bun:test";
import {
  gradeAcceptedTextV2,
  gradeEnglishTranscriptV2,
  gradeEnglishTranscriptV3,
  gradeExactChoiceV2,
  gradeTranscriptV2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V1,
  STUDY_TRANSCRIPT_GRADER_POLICY_V2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V3,
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

describe("Study v3 grader revision", () => {
  test("refuses the audited meaning-changing negation acceptance", () => {
    expect(gradeEnglishTranscriptV3("I can love you", "I cannot love you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(gradeEnglishTranscriptV3("I can love you", "I can't love you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(gradeEnglishTranscriptV3("I do love you", "I do not love you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
  });

  test("refuses numeric substitutions that vanish from the phoneme stream", () => {
    expect(gradeEnglishTranscriptV3("I have 2 hearts", "I have 9 hearts")).toMatchObject({
      correct: false,
      matchKind: "none",
      substituted: [{ expected: { token: "2", position: 2 }, heard: "9" }],
    });
    expect(gradeEnglishTranscriptV3("I have 2 hearts", "I have hearts")).toMatchObject({
      correct: false,
      matchKind: "none",
      missing: [{ token: "2", position: 2 }],
    });
  });

  test("refuses the vacuous article-only comparison against an empty transcript", () => {
    expect(gradeEnglishTranscriptV3("the", "")).toMatchObject({
      correct: false,
      matchKind: "none",
      missing: [{ token: "the", position: 0 }],
    });
    expect(gradeEnglishTranscriptV3("the", "the")).toMatchObject({
      correct: true,
      matchKind: "exact",
    });
    expect(gradeEnglishTranscriptV3("", "")).toMatchObject({ correct: false, matchKind: "none" });
  });

  test("keeps the calibrated accepted variations under v3", () => {
    expect(gradeEnglishTranscriptV3("hold me close", "hold me closed")).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV3("Shoo-be-doo", "shooby doo")).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV3("love", "loved")).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV3("The cafés won't stay", "cafe will not stays").correct).toBe(
      true,
    );
  });

  test("retains the transcript diff on phonetic acceptance", () => {
    const grade = gradeEnglishTranscriptV3("hold me close", "hold me closed");
    expect(grade.matchKind).toBe("phonetic");
    expect(grade.substituted).toEqual([
      { expected: { token: "close", position: 2 }, heard: "closed" },
    ]);
    expect(grade.matched).toEqual([
      { token: "hold", position: 0 },
      { token: "me", position: 1 },
    ]);
  });

  test("keeps v2 behavior immutable for historical rows", () => {
    expect(
      gradeTranscriptV2(
        "I can love you",
        "I cannot love you",
        "en",
        STUDY_TRANSCRIPT_GRADER_POLICY_V2,
      ),
    ).toMatchObject({ correct: true, matchKind: "phonetic" });
    expect(gradeTranscriptV2("the", "", "en", STUDY_TRANSCRIPT_GRADER_POLICY_V2)).toMatchObject({
      correct: true,
      matchKind: "exact",
    });
    expect(
      gradeTranscriptV2("hold me close", "hold me closed", "en", STUDY_TRANSCRIPT_GRADER_POLICY_V1),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });

  test("never applies English phonetics to a non-English source profile under v3", () => {
    expect(
      gradeTranscriptV2("hold me close", "hold me closed", "es", STUDY_TRANSCRIPT_GRADER_POLICY_V3),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });
});
