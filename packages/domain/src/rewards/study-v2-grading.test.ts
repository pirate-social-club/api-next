import { describe, expect, test } from "bun:test";
import {
  gradeAcceptedTextV2,
  gradeEnglishTranscriptV2,
  gradeEnglishTranscriptV3,
  gradeEnglishTranscriptV4,
  gradeExactChoiceV2,
  gradeTranscriptV2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V1,
  STUDY_TRANSCRIPT_GRADER_POLICY_V2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V3,
  STUDY_TRANSCRIPT_GRADER_POLICY_V4,
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

describe("Study v4 grader revision", () => {
  const negativeEquivalences = [
    ["It isn't the same", "It is not the same"],
    ["It is not the same", "It isn't the same"],
    ["It isn’t the same", "It is not the same"],
    ["Don't let it out", "Do not let it out"],
    ["Do not let it out", "Don't let it out"],
    ["She doesn't know", "She does not know"],
    ["I didn't know", "I did not know"],
    ["We couldn't stay", "We could not stay"],
    ["You aren't mine", "You are not mine"],
    ["He wasnt there", "He was not there"],
    ["Dont stop", "Do not stop"],
    ["I can't swim", "I cannot swim"],
    ["I cant swim", "I can not swim"],
    ["I can't swim", "I can not swim"],
    ["I won't back down", "I will not back down"],
    ["I wont back down", "I will not back down"],
    ["Who's sorry now", "Who is sorry now"],
  ] as const;

  for (const [reference, transcript] of negativeEquivalences) {
    test(`matches ${JSON.stringify(transcript)} exactly under v4`, () => {
      expect(gradeEnglishTranscriptV4(reference, transcript)).toMatchObject({
        correct: true,
        matchKind: "exact",
      });
    });
  }

  test("rejects whole-word insertions and deletions the v3 phonetic budget absorbed", () => {
    const line = "Who's the man that Valentino takes his hat off to?";
    expect(
      gradeEnglishTranscriptV4(line, "Who's the man that let Valentino take his hat off to?"),
    ).toMatchObject({ correct: false, matchKind: "none" });
    expect(
      gradeEnglishTranscriptV4(line, "Who's the man that just Valentino takes his hat off to?"),
    ).toMatchObject({ correct: false, matchKind: "none" });
    expect(
      gradeEnglishTranscriptV4(line, "Who's the man Valentino takes his hat off to?"),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });

  const boundaryEquivalences = [
    ["spark plug ran the other way", "Sparkplug ran the other way"],
    ["every body ran the other way", "Everybody ran the other way"],
    ["some thing moved", "Something moved"],
    ["any one came", "Anyone came"],
    ["fire truck moved", "Firetruck moved"],
    ["to night we sing", "Tonight we sing"],
    ["out side we sing", "Outside we sing"],
    ["spark-plug moved", "Sparkplug moved"],
    ["s park plug moved", "Sparkplug moved"],
    ["spark plug spark plug moved", "Sparkplug sparkplug moved"],
    ["news paper arrived", "Newspaper arrived"],
    ["glasses case fell", "Glassescase fell"],
    ["bus stop moved", "Busstop moved"],
    ["spark plugs moved", "Sparkplugs moved"],
    ["news papers arrived", "Newspapers arrived"],
  ] as const;

  for (const [reference, transcript] of boundaryEquivalences) {
    for (const [expected, heard] of [
      [reference, transcript],
      [transcript, reference],
    ]) {
      test(`aligns spelling-equivalent word boundaries: ${JSON.stringify(expected)} → ${JSON.stringify(heard)}`, () => {
        expect(gradeEnglishTranscriptV4(expected as string, heard as string)).toMatchObject({
          correct: true,
          matchKind: "exact",
          missing: [],
          extra: [],
          substituted: [],
        });
      });
    }
  }

  test("retains original reference positions when a compound is joined", () => {
    expect(
      gradeEnglishTranscriptV4("spark plug ran the other way", "Sparkplug ran the other way")
        .matched,
    ).toEqual([
      { token: "spark", position: 0 },
      { token: "plug", position: 1 },
      { token: "ran", position: 2 },
      { token: "other", position: 3 },
      { token: "way", position: 4 },
    ]);
  });

  test("keeps stripped internal endings distinct from genuine word-boundary matches", () => {
    expect(gradeEnglishTranscriptV4("news paper arrived", "Newpaper arrived").matchKind).not.toBe(
      "exact",
    );
    expect(gradeEnglishTranscriptV4("glasses case fell", "Glasscase fell").matchKind).not.toBe(
      "exact",
    );
  });

  test("joins do not hide actual additions, omissions, or reordered words", () => {
    const reference = "spark plug ran the other way";
    for (const heard of [
      "Sparkplug just ran the other way",
      "Sparkplug the other way",
      "plug spark ran the other way",
      "spark ran the other way",
    ]) {
      expect(gradeEnglishTranscriptV4(reference, heard)).toMatchObject({
        correct: false,
        matchKind: "none",
      });
    }
  });

  test("a compound can still use phonetic tolerance elsewhere without hiding a whole word", () => {
    expect(
      gradeEnglishTranscriptV4("spark plug hold me close", "Sparkplug hold me closed"),
    ).toMatchObject({ correct: true, matchKind: "phonetic" });
    expect(
      gradeEnglishTranscriptV4("spark plug hold me close", "Sparkplug just hold me closed"),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });

  test("never joins across negations or numbers in either direction", () => {
    for (const [reference, heard] of [
      ["not able", "notable"],
      ["no body", "nobody"],
      ["one 2", "one2"],
      ["12 34", "1234"],
    ]) {
      expect(gradeEnglishTranscriptV4(reference as string, heard as string).correct).toBe(false);
      expect(gradeEnglishTranscriptV4(heard as string, reference as string).correct).toBe(false);
    }
  });

  test("keeps v1-v3 and language-agnostic boundary behavior unchanged", () => {
    const reference = "spark plug ran the other way";
    const heard = "Sparkplug ran the other way";
    expect(
      gradeTranscriptV2(reference, heard, "en", STUDY_TRANSCRIPT_GRADER_POLICY_V1).correct,
    ).toBe(false);
    expect(gradeEnglishTranscriptV2(reference, heard)).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV3(reference, heard)).toMatchObject({
      correct: true,
      matchKind: "phonetic",
      missing: [{ token: "spark", position: 0 }],
    });
    for (const language of [null, "es"]) {
      expect(
        gradeTranscriptV2(reference, heard, language, STUDY_TRANSCRIPT_GRADER_POLICY_V4).correct,
      ).toBe(false);
    }
  });

  test("keeps real negation changes rejected in both directions", () => {
    expect(gradeEnglishTranscriptV4("I can love you", "I cannot love you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(gradeEnglishTranscriptV4("I cannot love you", "I can love you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(gradeEnglishTranscriptV4("I do love you", "I do not love you")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(
      gradeEnglishTranscriptV4(
        "I will always hold you close through the night",
        "I will never hold you close through the night",
      ),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });

  test("keeps the calibrated near-match fixtures under v4", () => {
    expect(gradeEnglishTranscriptV4("hold me close", "hold me closed")).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV4("Shoo-be-doo", "shooby doo")).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV4("love", "loved")).toMatchObject({
      correct: true,
      matchKind: "phonetic",
    });
    expect(gradeEnglishTranscriptV4("The cafés won't stay", "cafe will not stays").correct).toBe(
      true,
    );
    expect(
      gradeEnglishTranscriptV4(
        "Say mum's the word, don't let it out",
        "Say mom's the word. Don't let it out",
      ),
    ).toMatchObject({ correct: true, matchKind: "phonetic" });
  });

  test("retains the possessive apostrophe-s false expansion as phonetic acceptance", () => {
    expect(
      gradeEnglishTranscriptV4("Valentino's hat is gone", "Valentinos hat is gone"),
    ).toMatchObject({ correct: true, matchKind: "phonetic" });
  });

  test("keeps language-agnostic behavior for a null or non-English profile", () => {
    expect(
      gradeTranscriptV2(
        "It isn't the same",
        "It is not the same",
        null,
        STUDY_TRANSCRIPT_GRADER_POLICY_V4,
      ),
    ).toMatchObject({ correct: false, matchKind: "none" });
    expect(
      gradeTranscriptV2("hold me close", "hold me closed", "es", STUDY_TRANSCRIPT_GRADER_POLICY_V4),
    ).toMatchObject({ correct: false, matchKind: "none" });
  });

  test("pins the v3 delta: v3 still rejects the negative equivalence and still accepts the insertion", () => {
    expect(gradeEnglishTranscriptV3("It isn't me", "It is not me")).toMatchObject({
      correct: false,
      matchKind: "none",
    });
    expect(
      gradeEnglishTranscriptV3(
        "Who's the man that Valentino takes his hat off to?",
        "Who's the man that let Valentino take his hat off to?",
      ),
    ).toMatchObject({ correct: true, matchKind: "phonetic" });
  });
});
