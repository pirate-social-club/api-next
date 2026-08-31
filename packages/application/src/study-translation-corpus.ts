import { LanguageTagV1, StudyLearnerBandV2 } from "@pirate/contracts";
import { Option, Schema } from "effect";
import {
  STUDY_TRANSLATION_PROMPT_V2,
  STUDY_TRANSLATION_VALIDATOR_V2,
  StudyTranslationGenerationProposal,
} from "./study-translation-generator.ts";

export const STUDY_TRANSLATION_CORPUS_V1 = "study_translation_corpus_v1" as const;
export const STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1 =
  "study_translation_corpus_candidate_document_v1" as const;
export const STUDY_TRANSLATION_CORPUS_EVALUATOR_V1 =
  "study_translation_corpus_evaluator_v1" as const;
export const STUDY_TRANSLATION_CORPUS_V2 = "study_translation_corpus_v2" as const;
export const STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V2 =
  "study_translation_corpus_candidate_document_v2" as const;
export const STUDY_TRANSLATION_CORPUS_EVALUATOR_V2 =
  "study_translation_corpus_evaluator_v2" as const;
export const STUDY_TRANSLATION_ZH_HANS_B1_APPLICABILITY_V1 =
  "study_translation_zh_hans_b1_applicability_v1" as const;
export const STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1 =
  "study_translation_library_measurement_v1" as const;

export const STUDY_TRANSLATION_CORPUS_CATEGORIES = [
  "ordinary",
  "short_line",
  "repeated_chorus",
  "contraction",
  "idiom",
  "slang",
  "metaphor",
  "profanity",
  "proper_name",
  "punctuation",
  "mixed_language",
  "vocable_only",
  "already_target_language",
  "ambiguity",
  "gender_or_formality",
  "instruction_like_lyric",
] as const;

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const CorpusCategory = Schema.Literals(STUDY_TRANSLATION_CORPUS_CATEGORIES);
export type StudyTranslationCorpusCategory = Schema.Schema.Type<typeof CorpusCategory>;
const CandidateDisposition = Schema.Literals(["ready", "not_applicable", "skipped"]);
const NullableReviewMetric = Schema.NullOr(Schema.Boolean);

const corpusItemReviewFields = {
  song_id: Identifier,
  post_id: Identifier,
  lyrics_revision: Schema.Int.check(Schema.isGreaterThan(0)),
  study_unit_id: Identifier,
  source_hash: Sha256,
  generation_run_id: Identifier,
  candidate_hash: Sha256,
  categories: Schema.Array(CorpusCategory).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  expected_disposition: CandidateDisposition,
  candidate_disposition: CandidateDisposition,
  schema_correct: Schema.Boolean,
  source_binding_correct: Schema.Boolean,
  answer_key_secrecy_correct: Schema.Boolean,
  stale_write_correct: Schema.Boolean,
  semantic_correct: NullableReviewMetric,
  no_second_correct_choice: NullableReviewMetric,
  naturalness: NullableReviewMetric,
  register_preserved: NullableReviewMetric,
  explanation_accurate: NullableReviewMetric,
  learner_band_fit: NullableReviewMetric,
  distractors_plausible_and_wrong: NullableReviewMetric,
  critical_defects: Schema.Array(
    Schema.Literals(["moderation", "privacy", "rights", "instruction_injection"]),
  ).check(Schema.isMaxLength(4)),
} as const;

const StudyTranslationCorpusItemV1 = Schema.Struct({
  ...corpusItemReviewFields,
  human_reviewed: Schema.Boolean,
});

const CategoryApplicability = Schema.Literals(["required", "opportunistic", "not_applicable"]);
export type StudyTranslationCategoryApplicability = Schema.Schema.Type<
  typeof CategoryApplicability
>;

const StudyTranslationCategoryPolicyV2 = Schema.Struct({
  category: CorpusCategory,
  applicability: CategoryApplicability,
  minimum_sample_count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  reason: Identifier,
});

export const StudyTranslationApplicabilityPolicyV2 = Schema.Struct({
  policy_revision: Schema.Literal(STUDY_TRANSLATION_ZH_HANS_B1_APPLICABILITY_V1),
  evaluator_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_EVALUATOR_V2),
  target_language: Schema.Literal("zh-Hans"),
  learner_band: Schema.Literal("B1"),
  minimum_corpus_sample_count: Schema.Literal(200),
  minimum_corpus_song_count: Schema.Literal(25),
  library_measurement: Schema.Struct({
    measurement_revision: Schema.Literal(STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1),
    library_sha256: Sha256,
    song_directory_count: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    lyrics_file_count: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    target_script_predicate: Schema.Literal("unicode_script_han_v1"),
    target_script_song_count: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  }),
  categories: Schema.Array(StudyTranslationCategoryPolicyV2).check(
    Schema.isMinLength(STUDY_TRANSLATION_CORPUS_CATEGORIES.length),
    Schema.isMaxLength(STUDY_TRANSLATION_CORPUS_CATEGORIES.length),
    Schema.makeFilter((categories) =>
      new Set(categories.map(({ category }) => category)).size ===
        STUDY_TRANSLATION_CORPUS_CATEGORIES.length &&
      STUDY_TRANSLATION_CORPUS_CATEGORIES.every((category) =>
        categories.some((entry) => entry.category === category),
      )
        ? undefined
        : "Applicability policy must classify every corpus category exactly once",
    ),
  ),
});
export type StudyTranslationApplicabilityPolicyV2 = Schema.Schema.Type<
  typeof StudyTranslationApplicabilityPolicyV2
>;

const StudyTranslationCorpusItemV2 = Schema.Struct({
  ...corpusItemReviewFields,
  reviewed: Schema.Boolean,
});

export const StudyTranslationCorpusV1 = Schema.Struct({
  schema_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_V1),
  corpus_revision: Identifier,
  target_language: LanguageTagV1,
  learner_band: StudyLearnerBandV2,
  prompt_revision: Schema.Literal(STUDY_TRANSLATION_PROMPT_V2),
  validator_revision: Schema.Literal(STUDY_TRANSLATION_VALIDATOR_V2),
  reviewer_role: Identifier,
  reviewed_at: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  items: Schema.Array(StudyTranslationCorpusItemV1).check(Schema.isMaxLength(10_000)),
});

export type StudyTranslationCorpusV1 = Schema.Schema.Type<typeof StudyTranslationCorpusV1>;

export const StudyTranslationCorpusCandidateDocumentV1 = Schema.Struct({
  schema_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1),
  planner_revision: Identifier,
  corpus: StudyTranslationCorpusV1,
  generated_songs: Schema.Array(
    Schema.Struct({
      song_id: Identifier,
      post_id: Identifier,
      proposal: StudyTranslationGenerationProposal,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export type StudyTranslationCorpusCandidateDocumentV1 = Schema.Schema.Type<
  typeof StudyTranslationCorpusCandidateDocumentV1
>;

export const StudyTranslationCorpusV2 = Schema.Struct({
  schema_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_V2),
  evaluator_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_EVALUATOR_V2),
  corpus_revision: Identifier,
  target_language: LanguageTagV1,
  learner_band: StudyLearnerBandV2,
  prompt_revision: Schema.Literal(STUDY_TRANSLATION_PROMPT_V2),
  validator_revision: Schema.Literal(STUDY_TRANSLATION_VALIDATOR_V2),
  reviewer_role: Identifier,
  review_method: Schema.Literals(["dual_ai_review_v1", "bilingual_human_review_v1"]),
  reviewed_at: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  applicability_policy: StudyTranslationApplicabilityPolicyV2,
  items: Schema.Array(StudyTranslationCorpusItemV2).check(Schema.isMaxLength(10_000)),
});
export type StudyTranslationCorpusV2 = Schema.Schema.Type<typeof StudyTranslationCorpusV2>;

export const StudyTranslationCorpusCandidateDocumentV2 = Schema.Struct({
  schema_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V2),
  planner_revision: Identifier,
  corpus: StudyTranslationCorpusV2,
  generated_songs: Schema.Array(
    Schema.Struct({
      song_id: Identifier,
      post_id: Identifier,
      proposal: StudyTranslationGenerationProposal,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type StudyTranslationCorpusCandidateDocumentV2 = Schema.Schema.Type<
  typeof StudyTranslationCorpusCandidateDocumentV2
>;

export type StudyTranslationCorpusEvaluation = Readonly<{
  evaluatorRevision: typeof STUDY_TRANSLATION_CORPUS_EVALUATOR_V1;
  schemaRevision: typeof STUDY_TRANSLATION_CORPUS_V1 | null;
  corpusRevision: string | null;
  targetLanguage: string | null;
  learnerBand: string | null;
  releaseState: "evaluation" | "eligible_for_human_activation";
  eligibleForHumanActivation: boolean;
  sampleCount: number;
  songCount: number;
  acceptedGoldCount: number;
  rubricPassRate: number;
  distractorPassRate: number;
  missingCategories: readonly string[];
  failures: readonly string[];
}>;

const invalidEvaluation = (): StudyTranslationCorpusEvaluation => ({
  evaluatorRevision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V1,
  schemaRevision: null,
  corpusRevision: null,
  targetLanguage: null,
  learnerBand: null,
  releaseState: "evaluation",
  eligibleForHumanActivation: false,
  sampleCount: 0,
  songCount: 0,
  acceptedGoldCount: 0,
  rubricPassRate: 0,
  distractorPassRate: 0,
  missingCategories: [...STUDY_TRANSLATION_CORPUS_CATEGORIES],
  failures: ["invalid_corpus_format"],
});

const ratio = (passing: number, total: number): number => (total === 0 ? 0 : passing / total);

/** Evaluates evidence only. Activating a quality-policy row remains a separate human action. */
export const evaluateStudyTranslationCorpus = (
  input: unknown,
): StudyTranslationCorpusEvaluation => {
  const directCorpus = Schema.decodeUnknownOption(StudyTranslationCorpusV1, {
    onExcessProperty: "error",
  })(input);
  const candidateDocument = Option.isNone(directCorpus)
    ? Schema.decodeUnknownOption(StudyTranslationCorpusCandidateDocumentV1, {
        onExcessProperty: "error",
      })(input)
    : Option.none<StudyTranslationCorpusCandidateDocumentV1>();
  if (Option.isNone(directCorpus) && Option.isNone(candidateDocument)) {
    return invalidEvaluation();
  }

  const corpus = Option.isSome(directCorpus)
    ? directCorpus.value
    : Option.getOrThrow(candidateDocument).corpus;
  const failures: string[] = [];
  const songCount = new Set(corpus.items.map(({ song_id }) => song_id)).size;
  const coveredCategories = new Set(corpus.items.flatMap(({ categories }) => categories));
  const missingCategories = STUDY_TRANSLATION_CORPUS_CATEGORIES.filter(
    (category) => !coveredCategories.has(category),
  );
  const accepted = corpus.items.filter(
    ({ expected_disposition }) => expected_disposition === "ready",
  );
  const allReviewed = corpus.items.every(({ human_reviewed }) => human_reviewed);
  const deterministicCorrect = corpus.items.every(
    (item) =>
      item.schema_correct &&
      item.source_binding_correct &&
      item.answer_key_secrecy_correct &&
      item.stale_write_correct &&
      item.expected_disposition === item.candidate_disposition,
  );
  const semanticallyUnambiguous = accepted.every(
    (item) => item.semantic_correct === true && item.no_second_correct_choice === true,
  );
  const rubricPassing = accepted.filter(
    (item) =>
      item.naturalness === true &&
      item.register_preserved === true &&
      item.explanation_accurate === true &&
      item.learner_band_fit === true,
  ).length;
  const distractorPassing = accepted.filter(
    ({ distractors_plausible_and_wrong }) => distractors_plausible_and_wrong === true,
  ).length;
  const rubricPassRate = ratio(rubricPassing, accepted.length);
  const distractorPassRate = ratio(distractorPassing, accepted.length);
  const hasCriticalDefect = corpus.items.some(
    ({ critical_defects }) => critical_defects.length > 0,
  );

  if (corpus.items.length < 100) failures.push("sample_count_below_100");
  if (songCount < 20) failures.push("song_count_below_20");
  if (missingCategories.length > 0) failures.push("required_category_missing");
  if (!allReviewed) failures.push("human_review_incomplete");
  if (!deterministicCorrect) failures.push("deterministic_correctness_below_100_percent");
  if (!semanticallyUnambiguous) failures.push("semantic_correctness_below_100_percent");
  if (rubricPassRate < 0.95) failures.push("bilingual_rubric_below_95_percent");
  if (distractorPassRate < 0.95) failures.push("distractor_quality_below_95_percent");
  if (hasCriticalDefect) failures.push("critical_defect_present");

  const eligibleForHumanActivation = failures.length === 0;
  return {
    evaluatorRevision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V1,
    schemaRevision: corpus.schema_revision,
    corpusRevision: corpus.corpus_revision,
    targetLanguage: corpus.target_language,
    learnerBand: corpus.learner_band,
    releaseState: eligibleForHumanActivation ? "eligible_for_human_activation" : "evaluation",
    eligibleForHumanActivation,
    sampleCount: corpus.items.length,
    songCount,
    acceptedGoldCount: accepted.length,
    rubricPassRate,
    distractorPassRate,
    missingCategories,
    failures,
  };
};

export type StudyTranslationCategoryQuotaV2 = Readonly<{
  category: StudyTranslationCorpusCategory;
  applicability: StudyTranslationCategoryApplicability;
  minimumSampleCount: number;
  observedSampleCount: number;
  shortfall: number;
}>;

export type StudyTranslationCorpusEvaluationV2 = Readonly<{
  evaluatorRevision: typeof STUDY_TRANSLATION_CORPUS_EVALUATOR_V2;
  schemaRevision: typeof STUDY_TRANSLATION_CORPUS_V2 | null;
  corpusRevision: string | null;
  targetLanguage: string | null;
  learnerBand: string | null;
  applicabilityPolicyRevision: string | null;
  librarySha256: string | null;
  releaseState: "evaluation" | "eligible_for_activation";
  eligibleForActivation: boolean;
  sampleCount: number;
  songCount: number;
  acceptedGoldCount: number;
  rubricPassRate: number;
  distractorPassRate: number;
  categoryQuotas: readonly StudyTranslationCategoryQuotaV2[];
  missingRequiredCategories: readonly StudyTranslationCorpusCategory[];
  opportunisticShortfalls: readonly StudyTranslationCorpusCategory[];
  notApplicableCategories: readonly StudyTranslationCorpusCategory[];
  failures: readonly string[];
}>;

const expectedCategoryPolicy = (
  category: StudyTranslationCorpusCategory,
): Readonly<{
  applicability: StudyTranslationCategoryApplicability;
  minimumSampleCount: number;
}> => {
  if (category === "already_target_language") {
    return { applicability: "not_applicable", minimumSampleCount: 0 };
  }
  if (category === "gender_or_formality") {
    return { applicability: "opportunistic", minimumSampleCount: 20 };
  }
  const highQuota = new Set<StudyTranslationCorpusCategory>([
    "mixed_language",
    "idiom",
    "slang",
    "ambiguity",
    "instruction_like_lyric",
  ]);
  return { applicability: "required", minimumSampleCount: highQuota.has(category) ? 20 : 10 };
};

const invalidEvaluationV2 = (): StudyTranslationCorpusEvaluationV2 => ({
  evaluatorRevision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
  schemaRevision: null,
  corpusRevision: null,
  targetLanguage: null,
  learnerBand: null,
  applicabilityPolicyRevision: null,
  librarySha256: null,
  releaseState: "evaluation",
  eligibleForActivation: false,
  sampleCount: 0,
  songCount: 0,
  acceptedGoldCount: 0,
  rubricPassRate: 0,
  distractorPassRate: 0,
  categoryQuotas: [],
  missingRequiredCategories: [],
  opportunisticShortfalls: [],
  notApplicableCategories: [],
  failures: ["invalid_corpus_format"],
});

/** Evaluates v2 evidence only. It never mutates or activates a quality-policy row. */
export const evaluateStudyTranslationCorpusV2 = (
  input: unknown,
): StudyTranslationCorpusEvaluationV2 => {
  const directCorpus = Schema.decodeUnknownOption(StudyTranslationCorpusV2, {
    onExcessProperty: "error",
  })(input);
  const candidateDocument = Option.isNone(directCorpus)
    ? Schema.decodeUnknownOption(StudyTranslationCorpusCandidateDocumentV2, {
        onExcessProperty: "error",
      })(input)
    : Option.none<StudyTranslationCorpusCandidateDocumentV2>();
  if (Option.isNone(directCorpus) && Option.isNone(candidateDocument)) {
    return invalidEvaluationV2();
  }

  const corpus = Option.isSome(directCorpus)
    ? directCorpus.value
    : Option.getOrThrow(candidateDocument).corpus;
  const policy = corpus.applicability_policy;
  const failures: string[] = [];
  const policyByCategory = new Map(policy.categories.map((entry) => [entry.category, entry]));
  const exactPolicy =
    corpus.target_language === policy.target_language &&
    corpus.learner_band === policy.learner_band &&
    policy.target_language === "zh-Hans" &&
    policy.learner_band === "B1" &&
    policy.minimum_corpus_sample_count === 200 &&
    policy.minimum_corpus_song_count === 25 &&
    policy.library_measurement.target_script_song_count === 0 &&
    STUDY_TRANSLATION_CORPUS_CATEGORIES.every((category) => {
      const actual = policyByCategory.get(category);
      const expected = expectedCategoryPolicy(category);
      return (
        actual?.applicability === expected.applicability &&
        actual.minimum_sample_count === expected.minimumSampleCount
      );
    });
  if (!exactPolicy) failures.push("unsupported_or_rebound_applicability_policy");

  const songCount = new Set(corpus.items.map(({ song_id }) => song_id)).size;
  const categoryCounts = new Map<StudyTranslationCorpusCategory, number>(
    STUDY_TRANSLATION_CORPUS_CATEGORIES.map((category) => [category, 0]),
  );
  for (const item of corpus.items) {
    for (const category of item.categories) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
  }
  const categoryQuotas = STUDY_TRANSLATION_CORPUS_CATEGORIES.map((category) => {
    const entry = policyByCategory.get(category);
    const minimumSampleCount = entry?.minimum_sample_count ?? 0;
    const observedSampleCount = categoryCounts.get(category) ?? 0;
    return {
      category,
      applicability: entry?.applicability ?? "required",
      minimumSampleCount,
      observedSampleCount,
      shortfall: Math.max(0, minimumSampleCount - observedSampleCount),
    } satisfies StudyTranslationCategoryQuotaV2;
  });
  const missingRequiredCategories = categoryQuotas
    .filter(({ applicability, shortfall }) => applicability === "required" && shortfall > 0)
    .map(({ category }) => category);
  const opportunisticShortfalls = categoryQuotas
    .filter(({ applicability, shortfall }) => applicability === "opportunistic" && shortfall > 0)
    .map(({ category }) => category);
  const notApplicableCategories = categoryQuotas
    .filter(({ applicability }) => applicability === "not_applicable")
    .map(({ category }) => category);
  if (missingRequiredCategories.length > 0) failures.push("required_category_quota_missing");
  if (
    categoryQuotas.some(
      ({ applicability, observedSampleCount }) =>
        applicability === "not_applicable" && observedSampleCount > 0,
    )
  ) {
    failures.push("not_applicable_category_present");
  }

  const accepted = corpus.items.filter(
    ({ expected_disposition }) => expected_disposition === "ready",
  );
  const allReviewed = corpus.items.every(({ reviewed }) => reviewed);
  const deterministicCorrect = corpus.items.every(
    (item) =>
      item.schema_correct &&
      item.source_binding_correct &&
      item.answer_key_secrecy_correct &&
      item.stale_write_correct &&
      item.expected_disposition === item.candidate_disposition,
  );
  const semanticallyUnambiguous = accepted.every(
    (item) => item.semantic_correct === true && item.no_second_correct_choice === true,
  );
  const rubricPassing = accepted.filter(
    (item) =>
      item.naturalness === true &&
      item.register_preserved === true &&
      item.explanation_accurate === true &&
      item.learner_band_fit === true,
  ).length;
  const distractorPassing = accepted.filter(
    ({ distractors_plausible_and_wrong }) => distractors_plausible_and_wrong === true,
  ).length;
  const rubricPassRate = ratio(rubricPassing, accepted.length);
  const distractorPassRate = ratio(distractorPassing, accepted.length);

  if (corpus.items.length < policy.minimum_corpus_sample_count) {
    failures.push("sample_count_below_200");
  }
  if (songCount < policy.minimum_corpus_song_count) failures.push("song_count_below_25");
  if (!allReviewed) failures.push("review_incomplete");
  if (!deterministicCorrect) failures.push("deterministic_correctness_below_100_percent");
  if (!semanticallyUnambiguous) failures.push("semantic_correctness_below_100_percent");
  if (rubricPassRate < 0.95) failures.push("review_rubric_below_95_percent");
  if (distractorPassRate < 0.95) failures.push("distractor_quality_below_95_percent");
  if (corpus.items.some(({ critical_defects }) => critical_defects.length > 0)) {
    failures.push("critical_defect_present");
  }

  const eligibleForActivation = failures.length === 0;
  return {
    evaluatorRevision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
    schemaRevision: corpus.schema_revision,
    corpusRevision: corpus.corpus_revision,
    targetLanguage: corpus.target_language,
    learnerBand: corpus.learner_band,
    applicabilityPolicyRevision: policy.policy_revision,
    librarySha256: policy.library_measurement.library_sha256,
    releaseState: eligibleForActivation ? "eligible_for_activation" : "evaluation",
    eligibleForActivation,
    sampleCount: corpus.items.length,
    songCount,
    acceptedGoldCount: accepted.length,
    rubricPassRate,
    distractorPassRate,
    categoryQuotas,
    missingRequiredCategories,
    opportunisticShortfalls,
    notApplicableCategories,
    failures,
  };
};
