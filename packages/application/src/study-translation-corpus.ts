import { LanguageTagV1, StudyLearnerBandV2 } from "@pirate/contracts";
import { Option, Schema } from "effect";
import {
  STUDY_TRANSLATION_PROMPT_V1,
  STUDY_TRANSLATION_VALIDATOR_V1,
} from "./study-translation-generator.ts";

export const STUDY_TRANSLATION_CORPUS_V1 = "study_translation_corpus_v1" as const;

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
const CandidateDisposition = Schema.Literals(["ready", "not_applicable", "skipped"]);
const NullableReviewMetric = Schema.NullOr(Schema.Boolean);

const StudyTranslationCorpusItemV1 = Schema.Struct({
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
  human_reviewed: Schema.Boolean,
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
});

export const StudyTranslationCorpusV1 = Schema.Struct({
  schema_revision: Schema.Literal(STUDY_TRANSLATION_CORPUS_V1),
  corpus_revision: Identifier,
  target_language: LanguageTagV1,
  learner_band: StudyLearnerBandV2,
  prompt_revision: Schema.Literal(STUDY_TRANSLATION_PROMPT_V1),
  validator_revision: Schema.Literal(STUDY_TRANSLATION_VALIDATOR_V1),
  reviewer_role: Identifier,
  reviewed_at: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  items: Schema.Array(StudyTranslationCorpusItemV1).check(Schema.isMaxLength(10_000)),
});

export type StudyTranslationCorpusV1 = Schema.Schema.Type<typeof StudyTranslationCorpusV1>;

export type StudyTranslationCorpusEvaluation = Readonly<{
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
  const decoded = Schema.decodeUnknownOption(StudyTranslationCorpusV1, {
    onExcessProperty: "error",
  })(input);
  if (Option.isNone(decoded)) return invalidEvaluation();

  const corpus = decoded.value;
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
