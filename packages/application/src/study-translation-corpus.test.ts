import { describe, expect, test } from "bun:test";
import {
  evaluateStudyTranslationCorpus,
  STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1,
  STUDY_TRANSLATION_CORPUS_CATEGORIES,
  STUDY_TRANSLATION_CORPUS_V1,
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

describe("Study translation enablement corpus", () => {
  test("reports reviewed evidence as eligible without activating anything", () => {
    const evaluation = evaluateStudyTranslationCorpus(reviewedCorpus());
    expect(evaluation.releaseState).toBe("eligible_for_human_activation");
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
