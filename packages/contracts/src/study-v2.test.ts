import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { StudyAnswerResultV2, StudyAnswerSubmissionV2, StudySessionItemV2 } from "./study-v2.ts";

const line = {
  post_id: "post-1",
  audio_revision: 1,
  lyrics_revision: 2,
  lyric_line_id: "line-1",
  line_version: 1,
  line_source_hash: "sha256-1",
};

const shared = {
  object: "study_session_item_v2",
  session_item_id: "session-item-1",
  ordinal: 0,
  exercise_review_key: "review-key-1",
  exercise_version_id: "exercise-version-1",
  exercise_variant: "spoken-recall-v1",
  line,
  learner_band: "A2",
  grader_policy_revision: "grader-v1",
  feedback_policy_revision: "feedback-v1",
  quality_policy_revision: "quality-v1",
  maximum_attempts: 2,
} as const;

const sessionItem = (ordinal: number) => ({
  ...shared,
  session_item_id: `session-item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-key-${ordinal}`,
  exercise_version_id: `exercise-version-${ordinal}`,
  exercise_type: "typed_cloze" as const,
  exercise_variant: "vocabulary-v1",
  line: { ...line, lyric_line_id: `line-${ordinal}` },
  languages: { learning_language: "en" as const, helper_language: null },
  presentation: {
    kind: "typed_cloze" as const,
    segments: [
      { kind: "text" as const, text: "Hold " },
      { kind: "blank" as const, blank_id: "blank-1" },
    ],
    accessible_text: "Hold blank",
    capture: "keyboard_text" as const,
  },
  answer_visibility: "secret_until_spent" as const,
  feedback_release: "spent_only" as const,
});

const session = {
  object: "study_session_v2",
  session_id: "session-1",
  persona_id: "persona-1",
  community_id: "community-1",
  post_id: "post-1",
  audio_revision: 1,
  lyrics_revision: 2,
  languages: { learning_language: "en", helper_language: null },
  learner_band: "A2",
  study_profile_revision: 1,
  source_set_revision: 1,
  selection_policy_revision: "selection-v1",
  qualification_policy_revision: "qualification-v1",
  timezone: "UTC",
  status: "active",
  items: [sessionItem(0), sessionItem(1), sessionItem(2), sessionItem(3)],
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 3,
    score_bps: null,
  },
  created_at: "2026-08-29T10:00:00.000Z",
  completed_at: null,
} as const;

describe("Study v2 contracts", () => {
  test("keeps say-it-back spoken and source-only", () => {
    const decoded = Schema.decodeUnknownSync(StudySessionItemV2)({
      ...shared,
      exercise_type: "say_it_back",
      languages: { learning_language: "en", helper_language: null },
      presentation: {
        kind: "say_it_back",
        reference_text: "Hold on to the night",
        capture: "microphone_audio",
      },
      answer_visibility: "always_visible",
      feedback_release: "every_graded_attempt",
    });
    expect(decoded.exercise_type).toBe("say_it_back");
    expect(() =>
      Schema.decodeUnknownSync(StudyAnswerSubmissionV2)({
        kind: "transcript_response",
        transcript: "client-authored transcript",
      }),
    ).toThrow();
  });

  test("never reveals a secret answer on a retryable miss", () => {
    expect(
      Schema.decodeUnknownSync(StudyAnswerResultV2)({
        object: "study_answer_result_v2",
        session_item_id: "session-item-1",
        attempt_number: 1,
        exercise_type: "translation_choice",
        outcome: "incorrect",
        first_pass: false,
        attempt_state: "retryable",
        feedback: { kind: "none" },
        session,
      }).feedback.kind,
    ).toBe("none");
    expect(() =>
      Schema.decodeUnknownSync(StudyAnswerResultV2)({
        object: "study_answer_result_v2",
        session_item_id: "session-item-1",
        attempt_number: 1,
        exercise_type: "translation_choice",
        outcome: "incorrect",
        first_pass: false,
        attempt_state: "retryable",
        feedback: {
          kind: "choice_reveal",
          correct_choice_key: "choice-a",
          correct_text: "Correct",
        },
        session,
      }),
    ).toThrow();
  });

  test("rejects token-placement and mismatched spent feedback", () => {
    expect(() =>
      Schema.decodeUnknownSync(StudyAnswerSubmissionV2)({
        kind: "token_placement",
        assignments: [],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StudyAnswerResultV2)({
        object: "study_answer_result_v2",
        session_item_id: "session-item-1",
        attempt_number: 2,
        exercise_type: "typed_cloze",
        outcome: "incorrect",
        first_pass: false,
        attempt_state: "spent",
        feedback: {
          kind: "choice_reveal",
          correct_choice_key: "choice-a",
          correct_text: "Correct",
        },
        session,
      }),
    ).toThrow();
  });
});
