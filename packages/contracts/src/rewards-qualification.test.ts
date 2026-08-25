import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ActivityQualificationV1,
  ActivityStreakLeaderboardV1,
  GetCommunityActivityLeaderboard,
  GetSongActivityLeaderboard,
  GetStudySession,
  SetAccountStreakTimezone,
  SetActivityPresentationPersona,
  StartStudySession,
  StudyAnswerResultV1,
  StudySessionV1,
  SubmitStudyAnswer,
} from "./rewards-qualification.ts";

const qualification = {
  object: "activity_qualification",
  qualification_id: "qualification_1",
  persona_id: "persona_1",
  community_id: "community_1",
  post_id: "post_1",
  audio_revision: 3,
  activity: "study",
  attempt_ref: { kind: "study", session_id: "session_1" },
  score_bps: 10_000,
  qualification_policy_version_id: "study-policy-v2",
  qualified_at: "2026-08-25T12:00:00.000Z",
  reward_period_key: "2026-08-25",
  streak_day: "2026-08-25",
  evidence_summary: {
    kind: "study_session_first_pass_v2",
    qualifying_exercise_count: 1,
    first_pass_correct: 1,
    required_correct: 1,
  },
} as const;

const session = {
  object: "study_session",
  session_id: "session_1",
  persona_id: "persona_1",
  community_id: "community_1",
  post_id: "post_1",
  audio_revision: 3,
  lyrics_revision: 2,
  source_revision: 4,
  qualification_policy_version_id: "study-policy-v2",
  status: "completed",
  timezone: "UTC",
  streak_day: "2026-08-25",
  items: [
    {
      session_item_id: "session_item_1",
      ordinal: 0,
      source_identity: {
        community_id: "community_1",
        post_id: "post_1",
        audio_revision: 3,
        lyrics_revision: 2,
        source_revision: 4,
        source_item_key: "line-1",
      },
      prompt: { kind: "text_response", text: "Sing the line back." },
      presentation_count: 1,
      answer_count: 1,
      first_pass_outcome: "correct",
    },
  ],
  progress: {
    qualifying_exercise_count: 1,
    answered_exercise_count: 1,
    first_pass_correct: 1,
    required_correct: 1,
    score_bps: 10_000,
  },
  qualification,
  created_at: "2026-08-25T11:59:00.000Z",
  completed_at: "2026-08-25T12:00:00.000Z",
} as const;

describe("rewards qualification contracts", () => {
  test("round-trips Study sessions and qualifications without private reward identity", () => {
    const decodedSession = Schema.decodeUnknownSync(StudySessionV1)(session);
    const decodedQualification = Schema.decodeUnknownSync(ActivityQualificationV1)(qualification);
    expect(Schema.encodeSync(StudySessionV1)(decodedSession)).toEqual(session);
    expect(Schema.encodeSync(ActivityQualificationV1)(decodedQualification)).toEqual(qualification);
    expect(JSON.stringify(decodedSession)).not.toContain("answer_key");
    expect(JSON.stringify(decodedSession)).not.toContain("account_id");
    expect(JSON.stringify(decodedSession)).not.toContain("score_submission");
  });

  test("accepts only typed answers and never a browser score", () => {
    const decode = Schema.decodeUnknownSync(
      SubmitStudyAnswer.request?.body as unknown as Schema.ConstraintDecoder<unknown>,
      { onExcessProperty: "error" },
    );
    expect(
      decode({
        idempotency_key: "answer_1",
        attempt_number: 1,
        answer: { kind: "single_select", choice_key: "choice-a" },
      }),
    ).toEqual({
      idempotency_key: "answer_1",
      attempt_number: 1,
      answer: { kind: "single_select", choice_key: "choice-a" },
    });
    const encoded = JSON.stringify(
      Schema.encodeSync(StudyAnswerResultV1)(
        Schema.decodeUnknownSync(StudyAnswerResultV1)({
          object: "study_answer_result",
          session_item_id: "session_item_1",
          attempt_number: 1,
          outcome: "correct",
          first_pass: true,
          session,
        }),
      ),
    );
    expect(encoded).not.toContain("answer_key");
    expect(encoded).not.toContain("correct_choice_key");
    expect(() =>
      decode({
        idempotency_key: "answer_1",
        attempt_number: 1,
        answer: { kind: "single_select", choice_key: "choice-a" },
        score_bps: 10_000,
      }),
    ).toThrow();
  });

  test("rejects empty sessions and mismatched qualification evidence", () => {
    expect(() => Schema.decodeUnknownSync(StudySessionV1)({ ...session, items: [] })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ActivityQualificationV1)({
        ...qualification,
        activity: "karaoke",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StudySessionV1)({
        ...session,
        progress: { ...session.progress, first_pass_correct: 0 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StudySessionV1)({
        ...session,
        items: [
          {
            ...session.items[0],
            source_identity: {
              ...session.items[0].source_identity,
              lyrics_revision: 99,
            },
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps public leaderboard rows persona-only with typed day semantics", () => {
    const leaderboard = Schema.decodeUnknownSync(ActivityStreakLeaderboardV1)({
      object: "activity_streak_leaderboard",
      scope: { kind: "song", community_id: "community_1", post_id: "post_1" },
      day_semantics: "account_pinned_iana_timezone_v1",
      entries: [
        {
          rank: 1,
          current: 4,
          best: 8,
          started_day: "2026-08-22",
          last_day: "2026-08-25",
          total_days: 9,
          persona: {
            persona_id: "persona_1",
            object: "persona",
            display_name: "Sailor",
            avatar_ref: null,
            primary_public_handle: "sailor",
          },
          is_viewer: false,
        },
      ],
      viewer_standing: null,
    });
    expect(JSON.stringify(leaderboard)).not.toContain("account_id");
    expect(JSON.stringify(leaderboard)).not.toContain("wallet");
    expect(JSON.stringify(leaderboard)).not.toContain("sibling");
  });

  test("declares the exact persona-scoped command and leaderboard routes", () => {
    expect(StartStudySession.path).toBe("/communities/:communityId/posts/:postId/study/sessions");
    expect(GetStudySession.path).toBe("/communities/:communityId/study/sessions/:sessionId");
    expect(SubmitStudyAnswer.path).toBe(
      "/communities/:communityId/study/sessions/:sessionId/items/:sessionItemId/answers",
    );
    expect(SetAccountStreakTimezone.path).toBe("/rewards/streak-timezone");
    expect(SetActivityPresentationPersona.path).toBe(
      "/communities/:communityId/rewards/presentation-persona",
    );
    expect(GetSongActivityLeaderboard.auth.optionalUser).toBe(true);
    expect(GetCommunityActivityLeaderboard.auth.optionalUser).toBe(true);
  });
});
