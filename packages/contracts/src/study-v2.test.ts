import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  StudyAnswerSubmissionV2,
  StudySessionItemV2,
  StudySessionV2,
  SubmitStudyAnswerV2,
} from "./study-v2.ts";

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const spokenItem = (ordinal: number) => ({
  object: "study_session_item_v2" as const,
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "say_it_back" as const,
  exercise_variant: "spoken-recall-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line-${ordinal}`,
    study_unit_id: `unit-${ordinal}`,
    line_version: 1,
    line_source_hash: "a".repeat(64),
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: null,
  presentation: {
    kind: "say_it_back" as const,
    reference_text: "Hold on",
    capture: "microphone_audio" as const,
  },
  answer_visibility: "always_visible" as const,
  feedback_release: "every_graded_attempt" as const,
  grader_policy_revision: "script-aware-token-diff-v1",
  feedback_policy_revision: "spoken-feedback-v1",
  quality_policy_revision: "study-quality-v1",
  maximum_attempts: 1,
});

describe("Study v2 contracts after spec 019", () => {
  test("keeps spoken practice source-only with a shared Study unit", () => {
    expect(decode(StudySessionItemV2, spokenItem(0)).line.study_unit_id).toBe("unit-0");
  });

  test("allows only four through ten cards", () => {
    const session = (count: number) => ({
      object: "study_session_v2",
      session_id: "session-1",
      persona_id: "persona-1",
      community_id: "community-1",
      post_id: "post-1",
      audio_revision: 1,
      lyrics_revision: 1,
      languages: { learning_language: "en", target_language: null },
      learner_band: null,
      study_profile_revision: 1,
      language_profile_revision: null,
      source_set_revision: 1,
      selection_policy_revision: "selection-v1",
      qualification_policy_revision: "study_session_first_pass_v2@1",
      timezone: "UTC",
      status: "active",
      items: Array.from({ length: count }, (_, ordinal) => spokenItem(ordinal)),
      progress: {
        qualifying_exercise_count: count,
        answered_exercise_count: 0,
        first_pass_correct: 0,
        required_correct: Math.max(1, Math.ceil((7 * count) / 10)),
        score_bps: null,
      },
      created_at: "2026-08-29T10:00:00.000Z",
      completed_at: null,
    });
    expect(() => decode(StudySessionV2, session(10))).not.toThrow();
    expect(() => decode(StudySessionV2, session(11))).toThrow();
  });

  test("does not admit client-authored transcripts or cloze", () => {
    expect(() =>
      decode(StudyAnswerSubmissionV2, { kind: "transcript_response", transcript: "x" }),
    ).toThrow();
    expect(() =>
      decode(StudySessionItemV2, { ...spokenItem(0), exercise_type: "typed_cloze" }),
    ).toThrow();
  });

  test("declares a bounded raw-audio command", () => {
    expect(SubmitStudyAnswerV2.request?.rawBodyMaxBytes).toBe(524_288);
    expect(SubmitStudyAnswerV2.request?.rawBodyContentTypes).toContain("audio/webm");
    const errors = SubmitStudyAnswerV2.errors ?? [];
    expect(errors.map((ErrorType) => new ErrorType({} as never).code)).toContain(
      "provider_unavailable",
    );
  });
});
