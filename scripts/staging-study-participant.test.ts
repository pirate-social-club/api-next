import { describe, expect, test } from "bun:test";
import type { ActivityQualificationV1, StudySessionV1 } from "@pirate/contracts";
import { buildAcceptedLyricsStudyItemSource } from "@pirate/platform-cf/accepted-lyrics-study-item-source";
import {
  runStagingStudyParticipant,
  type StagingStudyParticipantDependencies,
} from "./staging-study-participant.ts";

const input = {
  runId: "flow-001",
  communityId: "community_1",
  postId: "song_1",
  personaId: "persona_1",
  timezone: "UTC",
  acceptedLyrics: "Sail away\nUnder a paper moon!",
} as const;

const source = buildAcceptedLyricsStudyItemSource({
  request: {
    communityId: input.communityId,
    postId: input.postId,
    audioRevision: 3,
    lyricsRevision: 2,
  },
  lyricsText: input.acceptedLyrics,
});
if (source === null) throw new Error("expected source fixture");

const baseSession = (): StudySessionV1 => ({
  object: "study_session",
  session_id: "study_session_1",
  persona_id: input.personaId,
  community_id: input.communityId,
  post_id: input.postId,
  audio_revision: 3,
  lyrics_revision: 2,
  source_revision: 2,
  qualification_policy_version_id: "study_session_first_pass_v2@1",
  status: "active",
  timezone: "UTC",
  streak_day: null,
  items: source.items.map((item, ordinal) => ({
    session_item_id: `study_item_${ordinal + 1}`,
    ordinal,
    source_identity: {
      community_id: input.communityId,
      post_id: input.postId,
      audio_revision: 3,
      lyrics_revision: 2,
      source_revision: 2,
      source_item_key: item.source_item_key,
    },
    prompt: item.prompt,
    presentation_count: 1,
    answer_count: 0,
    first_pass_outcome: null,
  })),
  progress: {
    qualifying_exercise_count: source.items.length,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 2,
    score_bps: null,
  },
  qualification: null,
  created_at: "2026-08-26T10:00:00.000Z",
  completed_at: null,
});

const qualification = (): ActivityQualificationV1 => ({
  object: "activity_qualification",
  qualification_id: "qualification_1",
  persona_id: input.personaId,
  community_id: input.communityId,
  post_id: input.postId,
  audio_revision: 3,
  activity: "study",
  attempt_ref: { kind: "study", session_id: "study_session_1" },
  score_bps: 10_000,
  qualification_policy_version_id: "study_session_first_pass_v2@1",
  qualified_at: "2026-08-26T10:01:00.000Z",
  reward_period_key: "2026-08-26",
  streak_day: "2026-08-26",
  evidence_summary: {
    kind: "study_session_first_pass_v2",
    qualifying_exercise_count: 2,
    first_pass_correct: 2,
    required_correct: 2,
  },
});

const qualifiedSession = (): StudySessionV1 => {
  const session = baseSession();
  return {
    ...session,
    status: "completed",
    streak_day: "2026-08-26",
    items: session.items.map((item) => ({
      ...item,
      answer_count: 1,
      first_pass_outcome: "correct",
    })),
    progress: {
      ...session.progress,
      answered_exercise_count: session.items.length,
      first_pass_correct: session.items.length,
      score_bps: 10_000,
    },
    qualification: qualification(),
    completed_at: "2026-08-26T10:01:00.000Z",
  };
};

function participantFixture(): {
  readonly dependencies: StagingStudyParticipantDependencies;
  readonly answerCalls: readonly string[];
} {
  let session = baseSession();
  const answerCalls: string[] = [];
  return {
    answerCalls,
    dependencies: {
      startSession: async () => session,
      submitAnswer: async ({ sessionItemId, answer }) => {
        answerCalls.push(`${sessionItemId}:${answer.kind}`);
        const items = session.items.map((item) =>
          item.session_item_id === sessionItemId
            ? { ...item, answer_count: 1, first_pass_outcome: "correct" as const }
            : item,
        );
        session = {
          ...session,
          items,
          progress: {
            ...session.progress,
            answered_exercise_count: answerCalls.length,
            first_pass_correct: answerCalls.length,
            score_bps: answerCalls.length === items.length ? 10_000 : null,
          },
        };
        return {
          object: "study_answer_result",
          session_item_id: sessionItemId,
          attempt_number: 1,
          outcome: "correct",
          first_pass: true,
          session,
        };
      },
      getSession: async () => ({ ...qualifiedSession(), items: session.items }),
    },
  };
}

describe("staging Study participant", () => {
  test("submits every server-generated item and requires a persisted qualification", async () => {
    const fixture = participantFixture();
    const result = await runStagingStudyParticipant(input, fixture.dependencies);

    expect(fixture.answerCalls).toEqual([
      "study_item_1:text_response",
      "study_item_2:text_response",
    ]);
    expect(result).toEqual({
      object: "staging_study_participant_result",
      session_id: "study_session_1",
      audio_revision: 3,
      lyrics_revision: 2,
      source_revision: 2,
      qualifying_exercise_count: 2,
      first_pass_correct: 2,
      score_bps: 10_000,
      qualification_id: "qualification_1",
    });
  });

  test("fails before answering when the fixture does not reproduce the frozen source", async () => {
    const fixture = participantFixture();
    await expect(
      runStagingStudyParticipant(
        { ...input, acceptedLyrics: "Different accepted lyrics" },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "source-mismatch" });
    expect(fixture.answerCalls).toHaveLength(0);
  });

  test("fails closed when the final persisted session has no qualification", async () => {
    const fixture = participantFixture();
    await expect(
      runStagingStudyParticipant(input, {
        ...fixture.dependencies,
        getSession: async () => baseSession(),
      }),
    ).rejects.toMatchObject({ code: "qualification-missing" });
  });

  test("reuses an already-completed session without posting duplicate answers", async () => {
    const completed = qualifiedSession();
    let answerCalls = 0;
    const result = await runStagingStudyParticipant(input, {
      startSession: async () => completed,
      submitAnswer: async () => {
        answerCalls += 1;
        throw new Error("unexpected answer replay");
      },
      getSession: async () => completed,
    });

    expect(answerCalls).toBe(0);
    expect(result).toMatchObject({
      session_id: completed.session_id,
      qualification_id: "qualification_1",
      score_bps: 10_000,
    });
  });
});
