import { describe, expect, test } from "bun:test";
import {
  evaluateStudyTranslationCorpus,
  evaluateStudyTranslationCorpusV2,
  STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1,
  STUDY_TRANSLATION_CORPUS_CATEGORIES,
  STUDY_TRANSLATION_CORPUS_EVALUATOR_V1,
  STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
  STUDY_TRANSLATION_CORPUS_V1,
  STUDY_TRANSLATION_CORPUS_V2,
  STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1,
  STUDY_TRANSLATION_ZH_HANS_B1_APPLICABILITY_V1,
} from "./study-translation-corpus.ts";
import {
  STUDY_TRANSLATION_PROMPT_V2,
  STUDY_TRANSLATION_VALIDATOR_V2,
} from "./study-translation-generator.ts";

const reviewedCorpus = (): Record<string, unknown> & { items: Record<string, unknown>[] } => ({
  schema_revision: STUDY_TRANSLATION_CORPUS_V1,
  corpus_revision: "es-B1-reviewed-v1",
  target_language: "es",
  learner_band: "B1",
  prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
  validator_revision: STUDY_TRANSLATION_VALIDATOR_V2,
  reviewer_role: "qualified_bilingual_reviewer",
  reviewed_at: "2026-08-29T12:00:00.000Z",
  items: Array.from({ length: 100 }, (_, index) => ({
    song_id: `song-${index % 20}`,
    post_id: `post-${index % 20}`,
    lyrics_revision: 1,
    study_unit_id: `unit-${index}`,
    source_hash: index.toString(16).padStart(64, "0"),
    generation_run_id: `run-${index}`,
    candidate_hash: (index + 100).toString(16).padStart(64, "0"),
    categories: [
      STUDY_TRANSLATION_CORPUS_CATEGORIES[index % STUDY_TRANSLATION_CORPUS_CATEGORIES.length],
    ],
    expected_disposition: "ready",
    candidate_disposition: "ready",
    human_reviewed: true,
    schema_correct: true,
    source_binding_correct: true,
    answer_key_secrecy_correct: true,
    stale_write_correct: true,
    semantic_correct: true,
    no_second_correct_choice: true,
    naturalness: true,
    register_preserved: true,
    explanation_accurate: true,
    learner_band_fit: true,
    distractors_plausible_and_wrong: true,
    critical_defects: [],
  })),
});

const zhHansPolicy = () => ({
  policy_revision: STUDY_TRANSLATION_ZH_HANS_B1_APPLICABILITY_V1,
  evaluator_revision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
  target_language: "zh-Hans",
  learner_band: "B1",
  minimum_corpus_sample_count: 200,
  minimum_corpus_song_count: 25,
  library_measurement: {
    measurement_revision: STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1,
    library_sha256: "a".repeat(64),
    song_directory_count: 97,
    lyrics_file_count: 94,
    target_script_predicate: "unicode_script_han_v1",
    target_script_song_count: 0,
  },
  categories: STUDY_TRANSLATION_CORPUS_CATEGORIES.map((category) => ({
    category,
    applicability:
      category === "already_target_language"
        ? "not_applicable"
        : category === "gender_or_formality"
          ? "opportunistic"
          : "required",
    minimum_sample_count:
      category === "already_target_language"
        ? 0
        : [
              "mixed_language",
              "idiom",
              "slang",
              "ambiguity",
              "gender_or_formality",
              "instruction_like_lyric",
            ].includes(category)
          ? 20
          : 10,
    reason: `zh-Hans-B1-${category}`,
  })),
});

const reviewedCorpusV2 = (): Record<string, unknown> & { items: Record<string, unknown>[] } => {
  const requiredCategories = STUDY_TRANSLATION_CORPUS_CATEGORIES.filter(
    (category) => category !== "already_target_language" && category !== "gender_or_formality",
  );
  const highQuota = [
    "mixed_language",
    "idiom",
    "slang",
    "ambiguity",
    "instruction_like_lyric",
  ] as const;
  return {
    schema_revision: STUDY_TRANSLATION_CORPUS_V2,
    evaluator_revision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
    corpus_revision: "zh-Hans-B1-dual-ai-v1",
    target_language: "zh-Hans",
    learner_band: "B1",
    prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
    validator_revision: STUDY_TRANSLATION_VALIDATOR_V2,
    reviewer_role: "dual_ai_review",
    review_method: "dual_ai_review_v1",
    reviewed_at: "2026-08-31T12:00:00.000Z",
    applicability_policy: zhHansPolicy(),
    items: Array.from({ length: 200 }, (_, index) => ({
      song_id: `song-${index % 25}`,
      post_id: `post-${index % 25}`,
      lyrics_revision: 1,
      study_unit_id: `unit-${index}`,
      source_hash: index.toString(16).padStart(64, "0"),
      generation_run_id: `run-${index}`,
      candidate_hash: (index + 300).toString(16).padStart(64, "0"),
      categories: [
        requiredCategories[index % requiredCategories.length],
        ...(index < 20 ? highQuota : []),
      ].filter((category, position, categories) => categories.indexOf(category) === position),
      expected_disposition: "ready",
      candidate_disposition: "ready",
      reviewed: true,
      schema_correct: true,
      source_binding_correct: true,
      answer_key_secrecy_correct: true,
      stale_write_correct: true,
      semantic_correct: true,
      no_second_correct_choice: true,
      naturalness: true,
      register_preserved: true,
      explanation_accurate: true,
      learner_band_fit: true,
      distractors_plausible_and_wrong: true,
      critical_defects: [],
    })),
  };
};

describe("Study translation enablement corpus", () => {
  test("reports reviewed evidence as eligible without activating anything", () => {
    const evaluation = evaluateStudyTranslationCorpus(reviewedCorpus());
    expect(evaluation.releaseState).toBe("eligible_for_human_activation");
    expect(evaluation.evaluatorRevision).toBe(STUDY_TRANSLATION_CORPUS_EVALUATOR_V1);
    expect(evaluation.eligibleForHumanActivation).toBe(true);
    expect(evaluation.sampleCount).toBe(100);
    expect(evaluation.songCount).toBe(20);
    expect(evaluation.failures).toEqual([]);
  });

  test("evaluates a reviewable candidate document containing generated proposals", () => {
    const corpus = reviewedCorpus();
    const evaluation = evaluateStudyTranslationCorpus({
      schema_revision: STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1,
      planner_revision: "study_corpus_candidate_planner_v1",
      corpus,
      generated_songs: [
        {
          song_id: "song-0",
          post_id: "post-0",
          proposal: {
            generation_run_id: "run-0",
            provider_id: "provider-1",
            provider_model: "model-1",
            prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
            units: [],
          },
        },
      ],
    });
    expect(evaluation.releaseState).toBe("eligible_for_human_activation");
    expect(evaluation.corpusRevision).toBe("es-B1-reviewed-v1");
  });

  test("keeps a corpus in evaluation when any ratified threshold fails", () => {
    const corpus = reviewedCorpus();
    corpus.items[0] = {
      ...corpus.items[0],
      human_reviewed: false,
      semantic_correct: false,
      distractors_plausible_and_wrong: false,
      critical_defects: ["instruction_injection"],
    };
    for (let index = 1; index < 6; index += 1) {
      corpus.items[index] = {
        ...corpus.items[index],
        distractors_plausible_and_wrong: false,
      };
    }
    const evaluation = evaluateStudyTranslationCorpus(corpus);
    expect(evaluation.releaseState).toBe("evaluation");
    expect(evaluation.failures).toEqual(
      expect.arrayContaining([
        "human_review_incomplete",
        "semantic_correctness_below_100_percent",
        "distractor_quality_below_95_percent",
        "critical_defect_present",
      ]),
    );
  });

  test("fails closed on malformed or undersized evidence", () => {
    expect(evaluateStudyTranslationCorpus({}).failures).toEqual(["invalid_corpus_format"]);
    const corpus = reviewedCorpus();
    corpus.items = corpus.items.slice(0, 10);
    expect(evaluateStudyTranslationCorpus(corpus).failures).toContain("sample_count_below_100");
  });
});

describe("Study translation corpus evaluator v2 applicability", () => {
  test("keeps evaluator v1 immutable and evaluates the exact zh-Hans policy separately", () => {
    expect(evaluateStudyTranslationCorpus(reviewedCorpus()).evaluatorRevision).toBe(
      STUDY_TRANSLATION_CORPUS_EVALUATOR_V1,
    );
    const evaluation = evaluateStudyTranslationCorpusV2(reviewedCorpusV2());
    expect(evaluation).toMatchObject({
      evaluatorRevision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
      releaseState: "eligible_for_activation",
      eligibleForActivation: true,
      sampleCount: 200,
      songCount: 25,
      missingRequiredCategories: [],
      notApplicableCategories: ["already_target_language"],
      opportunisticShortfalls: ["gender_or_formality"],
      failures: [],
    });
  });

  test("fails closed when required quota is missing without fabricating not-applicable coverage", () => {
    const corpus = reviewedCorpusV2();
    corpus.items = corpus.items.map((item) => {
      const categories = (item.categories as string[]).filter(
        (category) => category !== "ordinary",
      );
      return { ...item, categories: categories.length === 0 ? ["short_line"] : categories };
    });
    const evaluation = evaluateStudyTranslationCorpusV2(corpus);
    expect(evaluation.missingRequiredCategories).toContain("ordinary");
    expect(evaluation.notApplicableCategories).toEqual(["already_target_language"]);
    expect(evaluation.failures).toContain("required_category_quota_missing");
  });

  test("rejects unknown-language rebinding and a stale zero-Han measurement", () => {
    const rebound = reviewedCorpusV2();
    rebound.target_language = "es";
    expect(evaluateStudyTranslationCorpusV2(rebound).failures).toContain(
      "unsupported_or_rebound_applicability_policy",
    );

    const stale = reviewedCorpusV2();
    stale.applicability_policy = {
      ...(stale.applicability_policy as Record<string, unknown>),
      library_measurement: {
        ...zhHansPolicy().library_measurement,
        target_script_song_count: 1,
      },
    };
    expect(evaluateStudyTranslationCorpusV2(stale).failures).toContain(
      "unsupported_or_rebound_applicability_policy",
    );
  });

  test("cannot relabel v2 evidence as another evaluator revision", () => {
    const corpus = reviewedCorpusV2();
    corpus.evaluator_revision = "study_translation_corpus_evaluator_v3";
    expect(evaluateStudyTranslationCorpusV2(corpus).failures).toEqual(["invalid_corpus_format"]);
  });
});
