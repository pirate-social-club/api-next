import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  StudySourceItemV2,
  StudySourceSetV2,
  studySourcePromptV2,
} from "./study-item-source-v2.ts";

const item = {
  source_item_key: "line-1-choice-A2-zh",
  exercise_review_key: "review-1",
  exercise_version_id: "exercise-version-1",
  review_item_id: "private-review-item-1",
  exercise_type: "translation_choice",
  exercise_variant: "meaning-choice-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 2,
    lyric_line_id: "line-1",
    study_unit_id: "unit-1",
    line_version: 3,
    line_source_hash: "sha256-line-1-v3",
  },
  languages: { learning_language: "en", target_language: "zh" },
  learner_band: "A2",
  language_profile_revision: 1,
  presentation: {
    kind: "translation_choice",
    source_text: "Hold on to the night",
    question: "选择意思相同的句子",
    choices: [
      { choice_key: "a", text: "抓住这个夜晚" },
      { choice_key: "b", text: "放开这个早晨" },
      { choice_key: "c", text: "等待明天到来" },
      { choice_key: "d", text: "忘记昨天晚上" },
    ],
    capture: "choice_selection",
  },
  private_grader: {
    kind: "exact_choice_v1",
    correct_choice_key: "a",
    correct_text: "抓住这个夜晚",
    explanation: "这句话表示继续珍惜夜晚。",
  },
  answer_visibility: "secret_until_spent",
  feedback_release: "spent_only",
  grader_policy_revision: "exact-choice-v1",
  feedback_policy_revision: "spent-only-v1",
  provenance: {
    kind: "provider_generated",
    generation_run_id: "run-1",
    producer_id: "study-generator-v1",
    provider_model: "model-1",
    prompt_revision: "song-study-generation-prompt-v1",
    request_hash: "sha256-request-1",
    quality_policy_revision: "quality-v1",
    generated_at: "2026-08-29T10:00:00.000Z",
    accepted_at: "2026-08-29T10:01:00.000Z",
  },
} as const;

describe("Study source item v2", () => {
  test("projects browser content without private grader or review identity", () => {
    const decoded = Schema.decodeUnknownSync(StudySourceItemV2)(item);
    const projection = studySourcePromptV2(decoded);
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toContain("private_grader");
    expect(encoded).not.toContain("correct_choice_key");
    expect(encoded).not.toContain("private-review-item-1");
    expect(projection.exercise_version_id).toBe("exercise-version-1");
  });

  test("rejects an answer key that does not match a presented choice", () => {
    expect(() =>
      Schema.decodeUnknownSync(StudySourceItemV2)({
        ...item,
        private_grader: {
          ...item.private_grader,
          correct_choice_key: "missing",
        },
      }),
    ).toThrow();
  });

  test("rejects deterministic provenance carrying a provider model", () => {
    expect(() =>
      Schema.decodeUnknownSync(StudySourceItemV2)({
        ...item,
        provenance: { ...item.provenance, kind: "deterministic" },
      }),
    ).toThrow();
  });

  test("accepts the v2 spoken grader only with its matching immutable policy", () => {
    const spoken = {
      ...item,
      source_item_key: "line-1-spoken",
      exercise_type: "say_it_back",
      exercise_variant: "spoken-recall-v2",
      languages: { learning_language: "en", target_language: null },
      learner_band: null,
      language_profile_revision: null,
      presentation: {
        kind: "say_it_back",
        reference_text: "Hold on to the night",
        capture: "microphone_audio",
      },
      private_grader: {
        kind: "source_token_phonetic_v2",
        reference_text: "Hold on to the night",
        tokenizer_policy_revision: "script_aware_token_phonetic_v2",
      },
      answer_visibility: "always_visible",
      feedback_release: "every_graded_attempt",
      grader_policy_revision: "script_aware_token_phonetic_v2",
      provenance: { ...item.provenance, kind: "deterministic", provider_model: null },
    } as const;
    expect(Schema.decodeUnknownSync(StudySourceItemV2)(spoken).private_grader.kind).toBe(
      "source_token_phonetic_v2",
    );
    expect(() =>
      Schema.decodeUnknownSync(StudySourceItemV2)({
        ...spoken,
        grader_policy_revision: "script_aware_token_diff_v1",
      }),
    ).toThrow();
  });

  test("rejects two versions of one review key in a source set", () => {
    expect(() =>
      Schema.decodeUnknownSync(StudySourceSetV2)({
        version: "study_item_source_v2",
        community_id: "community-1",
        source_set_revision: 1,
        learning_language: "en",
        selection_policy_revision: "selection-v1",
        items: [
          item,
          {
            ...item,
            source_item_key: "line-1-choice-A2-zh-v2",
            exercise_version_id: "exercise-version-2",
          },
        ],
      }),
    ).toThrow();
  });
});
