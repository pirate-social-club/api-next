import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { GuestStudyPreparedContentV1 } from "./guest-study.ts";
import {
  GuestStudyPreparedContentV2,
  OwnerAccountStudySessionV1,
  StartOwnerAccountStudySessionV1,
  SubmitOwnerAccountStudyAnswerV1,
} from "./owner-study.ts";
import { StartStudySessionV2, SubmitStudyAnswerV2 } from "./study-v2.ts";

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const instant = "2026-10-11T10:00:00.000Z";
const item = (ordinal: number) => ({
  object: "study_session_item_v2",
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "say_it_back",
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
  presentation: { kind: "say_it_back", reference_text: "Hold on", capture: "microphone_audio" },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "script-aware-token-diff-v1",
  feedback_policy_revision: "spoken-feedback-v1",
  quality_policy_revision: "study-quality-v1",
  maximum_attempts: 1,
});
const session = () => ({
  object: "study_session_v2",
  persona_id: "persona-1",
  session_id: "session-1",
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
  items: Array.from({ length: 4 }, (_, ordinal) => item(ordinal)),
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 3,
    score_bps: null,
  },
  lesson: {
    current: {
      session_item_id: "item-0",
      presentation_number: 1,
      is_reappearance: false,
      presented_at: instant,
    },
    resolved_card_count: 0,
    total_card_count: 4,
    presentation_count: 0,
    presentation_cap: 12,
    completion_reason: null,
  },
  created_at: instant,
  completed_at: null,
});
const terms = {
  community_id: "community-1",
  post_id: "post-1",
  audio_revision: 1,
  lyrics_revision: 1,
  offer_id: "offer-1",
  pool_leg_id: "leg-1",
  original_drawing_id: "7",
  qualification_policy_version_id: "study_session_first_pass_v2@1",
  policy_hash: "a".repeat(64),
  terms_hash: "b".repeat(64),
  entry_cutoff_at: instant,
  disclosure_version: "disclosure-v1",
};
const publicPractice = {
  object: "guest_study_prepared_content_v1",
  reward_preview: null,
  disclosure: { version: "disclosure-v1", text: "Actual server disclosure" },
  availability: {
    state: "ready",
    available_exercise_types: ["say_it_back"],
    learning_language: "en",
    target_languages: ["es"],
    learner_bands: ["A1"],
  },
};
describe("Additive119 original-source reward consent", () => {
  test("preview and native-issued hash travel together while118 remains closed", () => {
    expect(() => decode(GuestStudyPreparedContentV1, publicPractice)).not.toThrow();
    const v2 = {
      ...publicPractice,
      object: "guest_study_prepared_content_v2",
      reward_preview_terms_hash: null,
    };
    expect(() => decode(GuestStudyPreparedContentV2, v2)).not.toThrow();
    expect(() => decode(GuestStudyPreparedContentV1, v2)).toThrow();
    expect(() => decode(GuestStudyPreparedContentV2, { ...v2, reward_preview: terms })).toThrow();
    expect(() =>
      decode(GuestStudyPreparedContentV2, { ...v2, reward_preview_terms_hash: "c".repeat(64) }),
    ).toThrow();
    expect(() =>
      decode(GuestStudyPreparedContentV2, {
        ...v2,
        reward_preview: terms,
        reward_preview_terms_hash: "c".repeat(64),
      }),
    ).not.toThrow();
  });
  test("selected Account birth requires explicit consent and rejects supplied authority", () => {
    const ordinary = {
      idempotency_key: "start-1",
      persona_id: "persona-1",
      target_language: null,
      learner_band: null,
      timezone: "UTC",
    };
    expect(() => decode(StartStudySessionV2.request.body, ordinary)).not.toThrow();
    const selected = {
      ...ordinary,
      reward_preview_terms_hash: "c".repeat(64),
      disclosure: { version: "disclosure-v1", accepted: true },
    };
    expect(() => decode(StartOwnerAccountStudySessionV1.request.body, selected)).not.toThrow();
    expect(() => decode(StartStudySessionV2.request.body, selected)).toThrow();
    for (const changed of [
      { ...selected, disclosure: { version: "disclosure-v1", accepted: false } },
      { ...selected, reward_preview_terms_hash: null },
      { ...selected, account_id: "invented" },
      { ...selected, original_drawing_id: "8" },
    ])
      expect(() => decode(StartOwnerAccountStudySessionV1.request.body, changed)).toThrow();
  });
  test("completed progress cannot substitute a drawing or imply admission", () => {
    const base = {
      object: "owner_account_study_session_v1",
      session: session(),
      reward_terms: terms,
      participation: { state: "not_yet_qualified" },
    };
    expect(() => decode(OwnerAccountStudySessionV1, base)).not.toThrow();
    for (const changed of [
      { ...base, reward_terms: { ...terms, post_id: "other" } },
      { ...base, reward_terms: { ...terms, audio_revision: 2 } },
      { ...base, participation: { state: "practice_only" } },
      {
        ...base,
        participation: {
          state: "admitted",
          share_id: "share-1",
          pool_leg_id: "leg-1",
          original_drawing_id: "8",
        },
      },
    ])
      expect(() => decode(OwnerAccountStudySessionV1, changed)).toThrow();
    expect(() =>
      decode(OwnerAccountStudySessionV1, {
        ...base,
        participation: {
          state: "pending_confirmation",
          operation: {
            operation_kind: "study_answer",
            idempotency_key: "answer-1",
            operation_id: "operation-1",
          },
        },
      }),
    ).not.toThrow();
    const admitted = {
      state: "admitted",
      share_id: "share-1",
      pool_leg_id: "leg-1",
      original_drawing_id: "7",
    };
    expect(() =>
      decode(OwnerAccountStudySessionV1, { ...base, participation: admitted }),
    ).toThrow();
    const completed = {
      ...session(),
      status: "completed",
      completed_at: instant,
      progress: {
        ...session().progress,
        answered_exercise_count: 4,
        first_pass_correct: 3,
        score_bps: 7500,
      },
      lesson: {
        ...session().lesson,
        current: null,
        resolved_card_count: 4,
        presentation_count: 4,
        completion_reason: "all_resolved",
      },
    };
    expect(() =>
      decode(OwnerAccountStudySessionV1, { ...base, session: completed, participation: admitted }),
    ).not.toThrow();
    expect(() =>
      decode(OwnerAccountStudySessionV1, {
        ...base,
        session: {
          ...completed,
          progress: { ...completed.progress, first_pass_correct: 2, score_bps: 5000 },
        },
        participation: admitted,
      }),
    ).toThrow();
    expect(() =>
      decode(OwnerAccountStudySessionV1, {
        ...base,
        session: completed,
        participation: {
          state: "pending_confirmation",
          operation: {
            operation_kind: "study_answer",
            idempotency_key: "answer-1",
            operation_id: "operation-1",
          },
        },
      }),
    ).not.toThrow();
  });
  test("rewarded request keys remain valid original pending locators", () => {
    const start = {
      idempotency_key: "start-1",
      persona_id: "persona-1",
      target_language: null,
      learner_band: null,
      timezone: "UTC",
      reward_preview_terms_hash: "c".repeat(64),
      disclosure: { version: "disclosure-v1", accepted: true },
    };
    for (const key of ["answer with spaces", "\tanswer", "answer\n"])
      expect(() =>
        decode(StartOwnerAccountStudySessionV1.request.body, { ...start, idempotency_key: key }),
      ).toThrow();
    for (const type of ["application/json", "audio/webm"]) {
      const headers = {
        "content-type": type,
        "idempotency-key": "answer-1",
        "x-study-attempt-number": "1",
      };
      expect(() => decode(SubmitOwnerAccountStudyAnswerV1.request.headers, headers)).not.toThrow();
      expect(() =>
        decode(SubmitStudyAnswerV2.request.headers, {
          ...headers,
          "idempotency-key": "answer with spaces",
        }),
      ).not.toThrow();
      expect(() =>
        decode(SubmitOwnerAccountStudyAnswerV1.request.headers, {
          ...headers,
          "idempotency-key": "answer with spaces",
        }),
      ).toThrow();
    }
  });
});
