import { Data, Effect } from "effect";

export type StudyLanguageProfileUnitInput = Readonly<{
  studyUnitId: string;
  sourceText: string;
}>;

export type StudyLanguageProfileRequest = Readonly<{
  communityId: string;
  postId: string;
  lyricsRevision: number;
  sourceHash: string;
  primaryLanguageHint: string | null;
  secondaryLanguageHint: string | null;
  units: readonly StudyLanguageProfileUnitInput[];
}>;

export type StudyLanguageProfileUnitFact = Readonly<{
  studyUnitId: string;
  detectedLanguages: readonly string[];
  dominantLanguage: string | null;
  mixed: boolean;
  vocableOnly: boolean;
  confidence: number | null;
}>;

export type StudyLanguageProfileAnalysis = Readonly<{
  providerId: string;
  providerModel: string;
  promptRevision: string;
  validatorRevision: "study_language_profile_validator_v1";
  units: readonly StudyLanguageProfileUnitFact[];
}>;

export class StudyLanguageProfileUnavailable extends Data.TaggedError(
  "StudyLanguageProfileUnavailable",
)<{ readonly reason: "disabled" | "provider" | "invalid-result" }> {}

export interface StudyLanguageProfileTransport {
  readonly analyze: (
    request: StudyLanguageProfileRequest,
  ) => Effect.Effect<StudyLanguageProfileAnalysis, StudyLanguageProfileUnavailable>;
}

const bcp47 =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$/u;

export const validateStudyLanguageProfile = (
  request: StudyLanguageProfileRequest,
  analysis: StudyLanguageProfileAnalysis,
): Effect.Effect<StudyLanguageProfileAnalysis, StudyLanguageProfileUnavailable> => {
  const expected = new Set(request.units.map(({ studyUnitId }) => studyUnitId));
  const actual = new Set(analysis.units.map(({ studyUnitId }) => studyUnitId));
  const valid =
    analysis.units.length === expected.size &&
    actual.size === expected.size &&
    [...expected].every((id) => actual.has(id)) &&
    analysis.units.every(
      (unit) =>
        unit.detectedLanguages.every((language) => bcp47.test(language)) &&
        (unit.dominantLanguage === null || bcp47.test(unit.dominantLanguage)) &&
        (unit.confidence === null ||
          (Number.isFinite(unit.confidence) && unit.confidence >= 0 && unit.confidence <= 1)) &&
        (unit.mixed ? unit.detectedLanguages.length > 1 : unit.detectedLanguages.length <= 1),
    );
  return valid
    ? Effect.succeed(analysis)
    : Effect.fail(new StudyLanguageProfileUnavailable({ reason: "invalid-result" }));
};

export const makeStudyLanguageProfileAnalyzer = (transport: StudyLanguageProfileTransport) => ({
  analyze: (request: StudyLanguageProfileRequest) =>
    transport
      .analyze(request)
      .pipe(Effect.flatMap((analysis) => validateStudyLanguageProfile(request, analysis))),
});

export const disabledStudyLanguageProfileTransport: StudyLanguageProfileTransport = {
  analyze: () => Effect.fail(new StudyLanguageProfileUnavailable({ reason: "disabled" })),
};
