// Shared account/guest public projection regression using accepted source shapes.
// These are semantic/privacy boundaries, not copies of individual helper branches.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { projectStudySessionItemV2 } from "./study-v2-item-projection.ts";

const sourceHash = createHash("sha256").update("I can love you").digest("hex");
const sourceRow = {
  exercise_version_id: "exercise-1",
  exercise_review_key: "study-say-it-back:study-post:unit-1",
  exercise_type: "say_it_back",
  exercise_variant: "spoken-recall-v2",
  post_id: "study-post",
  audio_revision: "1",
  lyrics_revision: "1",
  lyric_line_id: "line-1",
  study_unit_id: "unit-1",
  line_version: "1",
  line_source_hash: sourceHash,
  learning_language: "en",
  target_language: null,
  learner_band: null,
  language_profile_revision: null,
  presentation: {
    kind: "say_it_back",
    reference_text: "I can love you",
    capture: "microphone_audio",
  },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "script_aware_token_phonetic_v2",
  feedback_policy_revision: "spoken-feedback-v1",
  quality_policy_revision: "accepted-source-v1",
  // Real source rows contain these; they must never cross the public item seam.
  private_grader: {
    kind: "source_token_phonetic_v2",
    reference_text: "I can love you",
    secret_fixture_marker: "not-public",
  },
  request_hash: "a".repeat(64),
  provider_model: "private-provider-model",
  maximum_attempts: 999,
};
test("accepted ordinary source row has the exact retained public item snapshot and the same guest whitelist", () => {
  const item = projectStudySessionItemV2(sourceRow, "lesson-1", 0);
  expect(item).toEqual({
    object: "study_session_item_v2",
    session_item_id: "lesson-1_item_1",
    ordinal: 0,
    exercise_review_key: "study-say-it-back:study-post:unit-1",
    exercise_version_id: "exercise-1",
    exercise_type: "say_it_back",
    exercise_variant: "spoken-recall-v2",
    line: {
      post_id: "study-post",
      audio_revision: 1,
      lyrics_revision: 1,
      lyric_line_id: "line-1",
      study_unit_id: "unit-1",
      line_version: 1,
      line_source_hash: sourceHash,
    },
    languages: { learning_language: "en", target_language: null },
    learner_band: null,
    language_profile_revision: null,
    presentation: {
      kind: "say_it_back",
      reference_text: "I can love you",
      capture: "microphone_audio",
    },
    answer_visibility: "always_visible",
    feedback_release: "every_graded_attempt",
    grader_policy_revision: "script_aware_token_phonetic_v2",
    feedback_policy_revision: "spoken-feedback-v1",
    quality_policy_revision: "accepted-source-v1",
    maximum_attempts: 3,
  });
  const guest = projectStudySessionItemV2(
    { ...sourceRow, language_profile_revision: "1" },
    "guest-lesson",
    0,
  );
  expect({
    ...guest,
    session_item_id: item.session_item_id,
    language_profile_revision: null,
  }).toEqual(item);
  expect(JSON.stringify(guest)).not.toContain("not-public");
  expect(JSON.stringify(guest)).not.toContain("private_grader");
  expect(JSON.stringify(guest)).not.toContain("private-provider-model");
  expect(JSON.stringify(guest)).not.toContain("request_hash");
});
test("prepared translation keeps helper/band/profile and secret answer stays outside the shared public snapshot", () => {
  const presentation = {
    kind: "translation_choice",
    source_text: "I can love you",
    question: "Choose the prepared meaning",
    capture: "choice_selection",
    choices: ["a", "b", "c", "d"].map((choice_key) => ({
      choice_key,
      text: `Fixture ${choice_key}`,
    })),
  };
  const item = projectStudySessionItemV2(
    {
      ...sourceRow,
      exercise_version_id: "translation-ar-B1-1",
      exercise_review_key: "translation:ar:B1:unit-1",
      exercise_type: "translation_choice",
      exercise_variant: "whole-line-v1",
      target_language: "ar",
      learner_band: "B1",
      language_profile_revision: "1",
      presentation: JSON.stringify(presentation),
      answer_visibility: "secret_until_spent",
      feedback_release: "spent_only",
      grader_policy_revision: "exact_choice_v1",
      feedback_policy_revision: "choice-reveal-v1",
      private_grader: {
        kind: "exact_choice_v1",
        correct_choice_key: "b",
        correct_text: "secret-answer",
        explanation: "private grading rationale",
      },
    },
    "guest-lesson",
    1,
  );
  expect(item.languages).toEqual({
    learning_language: "en",
    target_language: "ar",
  });
  expect(item.learner_band).toBe("B1");
  expect(item.language_profile_revision).toBe(1);
  expect(item.presentation).toEqual(presentation);
  expect(item.maximum_attempts).toBe(3);
  expect(item.session_item_id).toBe("guest-lesson_item_2");
  expect(item.ordinal).toBe(1);
  expect(JSON.stringify(item)).not.toContain("correct_choice_key");
  expect(JSON.stringify(item)).not.toContain("secret-answer");
  expect(JSON.stringify(item)).not.toContain("private grading rationale");
});
test("unrepresentable source revisions or a missing immutable line identity cannot produce a public snapshot", () => {
  expect(() =>
    projectStudySessionItemV2(
      { ...sourceRow, audio_revision: "9007199254740993" },
      "guest-lesson",
      0,
    ),
  ).toThrow();
  expect(() =>
    projectStudySessionItemV2({ ...sourceRow, line_source_hash: null }, "guest-lesson", 0),
  ).toThrow();
});
