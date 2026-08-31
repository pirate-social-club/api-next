import { describe, expect, test } from "bun:test";
import type { StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";

import { runStagingStudyParticipant } from "./staging-study-participant.ts";

const communityId = "community_1";
const postId = "post_1";
const personaId = "persona_1";
const acceptedLyrics = "Line 1\nLine 2\nLine 3\nLine 4";
const createdAt = "2026-08-31T05:00:00.000Z";

const items = Array.from({ length: 4 }, (_, ordinal) => ({
  object: "study_session_item_v2" as const,
  session_item_id: `item_${ordinal + 1}`,
  ordinal,
  exercise_review_key: `review_${ordinal + 1}`,
  exercise_version_id: `exercise_${ordinal + 1}`,
  exercise_type: "say_it_back" as const,
  exercise_variant: "source_line_v1",
  line: {
    post_id: postId,
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line_${ordinal + 1}`,
    study_unit_id: `unit_${ordinal + 1}`,
    line_version: 1,
    line_source_hash: `source_${ordinal + 1}`,
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: null,
  presentation: {
    kind: "say_it_back" as const,
    reference_text: `Line ${ordinal + 1}`,
    capture: "microphone_audio" as const,
  },
  answer_visibility: "always_visible" as const,
  feedback_release: "every_graded_attempt" as const,
  grader_policy_revision: "grader_v1",
  feedback_policy_revision: "feedback_v1",
  quality_policy_revision: "quality_v1",
  maximum_attempts: 3,
}));

function studySession(input: {
  readonly nextOrdinal: number | null;
  readonly answered: number;
  readonly firstPassCorrect: number;
}): StudySessionV2 {
  const completed = input.nextOrdinal === null;
  return {
    object: "study_session_v2",
    session_id: "session_1",
    persona_id: personaId,
    community_id: communityId,
    post_id: postId,
    audio_revision: 1,
    lyrics_revision: 1,
    languages: { learning_language: "en", target_language: null },
    learner_band: null,
    study_profile_revision: 1,
    language_profile_revision: null,
    source_set_revision: 1,
    selection_policy_revision: "selection_v1",
    qualification_policy_revision: "qualification_v1",
    timezone: "UTC",
    status: completed ? "completed" : "active",
    items,
    progress: {
      qualifying_exercise_count: 4,
      answered_exercise_count: input.answered,
      first_pass_correct: input.firstPassCorrect,
      required_correct: 3,
      score_bps: completed ? input.firstPassCorrect * 2_500 : null,
    },
    lesson: {
      current: completed
        ? null
        : {
            session_item_id: `item_${input.nextOrdinal + 1}`,
            presentation_number: 1,
            is_reappearance: false,
            presented_at: createdAt,
          },
      resolved_card_count: input.answered,
      total_card_count: 4,
      presentation_count: completed ? 4 : input.nextOrdinal + 1,
      presentation_cap: 12,
      completion_reason: completed ? "all_resolved" : null,
    },
    created_at: createdAt,
    completed_at: completed ? "2026-08-31T05:01:00.000Z" : null,
  };
}

const participantInput = (
  session: StudySessionV2 = studySession({
    nextOrdinal: 0,
    answered: 0,
    firstPassCorrect: 0,
  }),
) => ({
  runId: "run-1",
  communityId,
  postId,
  personaId,
  acceptedLyrics,
  session,
});

const transcriptFeedback = {
  kind: "transcript_diff" as const,
  heard_transcript: "Line",
  matched: [],
  missing: [],
  extra: [],
  substituted: [],
  policy_revision: "grader_v1",
};

describe("staging Study v2 participant", () => {
  test("follows server-selected cards and requires a persisted qualifying score", async () => {
    let state = studySession({ nextOrdinal: 0, answered: 0, firstPassCorrect: 0 });
    const submitted: string[] = [];
    const result = await runStagingStudyParticipant(participantInput(state), {
      synthesizeAudio: async (referenceText) => {
        submitted.push(referenceText);
        return { bytes: new Uint8Array([1]), durationMs: 100 };
      },
      submitAnswer: async ({ sessionItemId, attemptNumber, idempotencyKey }) => {
        expect(idempotencyKey).toContain(`-${sessionItemId.replace("item_", "")}-1`);
        const ordinal = Number(sessionItemId.replace("item_", "")) - 1;
        state = studySession({
          nextOrdinal: ordinal === 3 ? null : ordinal + 1,
          answered: ordinal + 1,
          firstPassCorrect: ordinal + 1,
        });
        return {
          object: "study_answer_result_v2",
          session_item_id: sessionItemId,
          attempt_number: attemptNumber,
          exercise_type: "say_it_back",
          outcome: "correct",
          first_pass: true,
          attempt_state: "spent",
          feedback: transcriptFeedback,
          session: state,
        } satisfies StudyAnswerResultV2;
      },
      getSession: async () => state,
    });

    expect(submitted).toEqual(["Line 1", "Line 2", "Line 3", "Line 4"]);
    expect(result).toMatchObject({
      object: "staging_study_participant_result_v2",
      session_id: "session_1",
      first_pass_correct: 4,
      required_correct: 3,
      score_bps: 10_000,
    });
  });

  test("accepts a terminal three-of-four first-pass score", async () => {
    let state = studySession({ nextOrdinal: 0, answered: 0, firstPassCorrect: 0 });
    let submissions = 0;
    const result = await runStagingStudyParticipant(participantInput(state), {
      synthesizeAudio: async () => ({ bytes: new Uint8Array([1]), durationMs: 100 }),
      submitAnswer: async ({ sessionItemId, attemptNumber }) => {
        submissions += 1;
        const correct = submissions > 1;
        state =
          submissions === 5
            ? {
                ...studySession({ nextOrdinal: null, answered: 4, firstPassCorrect: 3 }),
                lesson: {
                  ...studySession({ nextOrdinal: null, answered: 4, firstPassCorrect: 3 }).lesson,
                  presentation_count: 5,
                },
              }
            : {
                ...studySession({
                  nextOrdinal: submissions === 4 ? 0 : submissions,
                  answered: submissions,
                  firstPassCorrect: correct ? submissions - 1 : 0,
                }),
                ...(submissions === 4
                  ? {
                      lesson: {
                        ...studySession({
                          nextOrdinal: 0,
                          answered: 4,
                          firstPassCorrect: 3,
                        }).lesson,
                        current: {
                          session_item_id: "item_1",
                          presentation_number: 2,
                          is_reappearance: true,
                          presented_at: createdAt,
                        },
                        resolved_card_count: 3,
                        presentation_count: 5,
                      },
                    }
                  : {}),
              };
        return {
          object: "study_answer_result_v2",
          session_item_id: sessionItemId,
          attempt_number: attemptNumber,
          exercise_type: "say_it_back",
          outcome: correct ? "correct" : "incorrect",
          first_pass: submissions <= 4,
          attempt_state: correct ? "spent" : "retryable",
          feedback: transcriptFeedback,
          session: state,
        } satisfies StudyAnswerResultV2;
      },
      getSession: async () => state,
    });

    expect(submissions).toBe(5);
    expect(result.score_bps).toBe(7_500);
    expect(result.first_pass_correct).toBe(3);
  });

  test("fails before synthesis when accepted lyrics do not match the typed source", async () => {
    let synthesized = false;
    await expect(
      runStagingStudyParticipant(
        { ...participantInput(), acceptedLyrics: "Different lines" },
        {
          synthesizeAudio: async () => {
            synthesized = true;
            return { bytes: new Uint8Array([1]), durationMs: 100 };
          },
          submitAnswer: async () => {
            throw new Error("unexpected");
          },
          getSession: async () => {
            throw new Error("unexpected");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "source-mismatch" });
    expect(synthesized).toBe(false);
  });

  test("rejects an answer transition that switches the typed session", async () => {
    const otherSession = {
      ...studySession({ nextOrdinal: 1, answered: 1, firstPassCorrect: 1 }),
      session_id: "session_other",
    };
    await expect(
      runStagingStudyParticipant(participantInput(), {
        synthesizeAudio: async () => ({ bytes: new Uint8Array([1]), durationMs: 100 }),
        submitAnswer: async ({ sessionItemId, attemptNumber }) => ({
          object: "study_answer_result_v2",
          session_item_id: sessionItemId,
          attempt_number: attemptNumber,
          exercise_type: "say_it_back",
          outcome: "correct",
          first_pass: true,
          attempt_state: "spent",
          feedback: transcriptFeedback,
          session: otherSession,
        }),
        getSession: async () => otherSession,
      }),
    ).rejects.toMatchObject({ code: "answer-rejected" });
  });

  test("reuses a completed typed session without duplicate answers", async () => {
    const completed = studySession({ nextOrdinal: null, answered: 4, firstPassCorrect: 3 });
    let submitted = false;
    const result = await runStagingStudyParticipant(participantInput(completed), {
      synthesizeAudio: async () => {
        submitted = true;
        return { bytes: new Uint8Array([1]), durationMs: 100 };
      },
      submitAnswer: async () => {
        throw new Error("unexpected");
      },
      getSession: async () => completed,
    });

    expect(submitted).toBe(false);
    expect(result.score_bps).toBe(7_500);
  });
});
