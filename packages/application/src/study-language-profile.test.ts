import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  disabledStudyLanguageProfileTransport,
  makeStudyLanguageProfileAnalyzer,
  validateStudyLanguageProfile,
} from "./study-language-profile.ts";

const request = {
  communityId: "community-1",
  postId: "post-1",
  lyricsRevision: 1,
  sourceHash: "a".repeat(64),
  primaryLanguageHint: "ko",
  secondaryLanguageHint: "en",
  units: [
    { studyUnitId: "unit-1", sourceText: "오늘 밤 we go" },
    { studyUnitId: "unit-2", sourceText: "oh oh" },
  ],
} as const;

describe("Study language profile", () => {
  test("accepts one target-independent fact for every shared Study unit", async () => {
    const result = await Effect.runPromise(
      validateStudyLanguageProfile(request, {
        providerId: "fake",
        providerModel: "fake-v1",
        promptRevision: "study-language-profile-v1",
        validatorRevision: "study_language_profile_validator_v1",
        units: [
          {
            studyUnitId: "unit-1",
            detectedLanguages: ["ko", "en"],
            dominantLanguage: "ko",
            mixed: true,
            vocableOnly: false,
            confidence: 0.9,
          },
          {
            studyUnitId: "unit-2",
            detectedLanguages: [],
            dominantLanguage: null,
            mixed: false,
            vocableOnly: true,
            confidence: null,
          },
        ],
      }),
    );
    expect(result.units).toHaveLength(2);
  });

  test("is disabled by default without affecting deterministic spoken practice", async () => {
    const result = await Effect.runPromise(
      makeStudyLanguageProfileAnalyzer(disabledStudyLanguageProfileTransport)
        .analyze(request)
        .pipe(Effect.flip),
    );
    expect(result.reason).toBe("disabled");
  });
});
