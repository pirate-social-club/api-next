import { describe, expect, test } from "bun:test";
import { assessStudySpokenRerecord } from "./study-spoken-rerecord.ts";
import { gradeTranscriptV2, STUDY_TRANSCRIPT_GRADER_POLICY_V4 } from "./study-v2-grading.ts";

const assess = (
  reference: string,
  heard: string,
  options: {
    expectedLanguage?: string | null;
    detectedLanguage?: string | null;
    confidence?: number | null;
    gradingLanguage?: string | null;
  } = {},
) =>
  assessStudySpokenRerecord({
    grade: gradeTranscriptV2(
      reference,
      heard,
      options.gradingLanguage ?? null,
      STUDY_TRANSCRIPT_GRADER_POLICY_V4,
    ),
    expectedLanguage: options.expectedLanguage ?? null,
    detectedLanguage: options.detectedLanguage ?? "en",
    detectedLanguageConfidence: options.confidence ?? 0.99,
  });

describe("Study spoken rerecord policy v1", () => {
  test("recognizes one inserted word plus one inflection on the null-language path", () => {
    const result = assess(
      "Who's the man that performer takes his hat off to?",
      "Who's the man that let performer take his hat off to?",
    );
    expect(result.candidateReason).toBe("single_insertion");
    expect(result.strongRemainder).toMatchObject({
      revision: "study_spoken_strong_remainder_v1",
      matchedTokens: 9,
      referenceTokens: 10,
      strong: true,
    });
  });

  test("does not treat expanded contractions as insertion suspicion", () => {
    expect(
      assess(
        "Who's the man that performer takes his hat off to?",
        "Who is the man that performer takes his hat off to?",
      ).candidateReason,
    ).toBeNull();
  });

  test("requires authoritative language and confident provider detection for mismatch", () => {
    const reference = "Keep the rhythm moving tonight";
    const heard = "Change the rhythm moving tonight";
    expect(assess(reference, heard, { detectedLanguage: "fr" }).candidateReason).toBeNull();
    expect(
      assess(reference, heard, {
        expectedLanguage: "en",
        detectedLanguage: "fr",
        confidence: 0.79,
      }).candidateReason,
    ).toBeNull();
    expect(
      assess(reference, heard, {
        expectedLanguage: "en-US",
        detectedLanguage: "fr-FR",
      }).candidateReason,
    ).toBe("language_mismatch");
  });

  test("uses a strict below-one-third voice overlap", () => {
    expect(assess("one two three four five six", "one other words tonight").candidateReason).toBe(
      "low_voice_overlap",
    );
    expect(assess("one two three", "one another third").voiceOverlap.belowOneThird).toBe(false);
  });

  test("excludes protected and multiword changes from insertion suspicion", () => {
    const reference = "We always sing the song until dawn";
    for (const heard of [
      "We always never sing the song until dawn",
      "We always 2 sing the song until dawn",
      "We always two sing the song until dawn",
      "We always isn't sing the song until dawn",
      "We always let just sing the song until dawn",
    ]) {
      expect(assess(reference, heard).candidateReason).toBeNull();
    }
    expect(assess(reference, "We never let sing the song until dawn").candidateReason).toBeNull();
  });

  test("never rerecords an accepted match", () => {
    expect(
      assess("We can go", "We can go", {
        expectedLanguage: "en",
        detectedLanguage: "fr",
      }).candidateReason,
    ).toBeNull();
  });
});
