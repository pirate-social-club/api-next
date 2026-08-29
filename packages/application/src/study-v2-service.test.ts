import { describe, expect, test } from "bun:test";
import type { StudyAnswerResultV2, StudySessionItemV2, StudySessionV2 } from "@pirate/contracts";
import { Effect } from "effect";
import { Clock, IdGen } from "./ports.ts";
import {
  makeStudyV2Service,
  type StudyAudioArchiveResult,
  type StudyV2Store,
} from "./study-v2-service.ts";

const item = (ordinal: number): StudySessionItemV2 => ({
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
  presentation: {
    kind: "say_it_back",
    reference_text: "Hold on",
    capture: "microphone_audio",
  },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "script_aware_token_diff_v1",
  feedback_policy_revision: "feedback-v1",
  quality_policy_revision: "quality-v1",
  maximum_attempts: 3,
});

const session: StudySessionV2 = {
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
  qualification_policy_revision: "qualification-v1",
  timezone: "UTC",
  status: "active",
  items: [item(0), item(1), item(2), item(3)],
  progress: {
    qualifying_exercise_count: 4,
    answered_exercise_count: 1,
    first_pass_correct: 1,
    required_correct: 3,
    score_bps: null,
  },
  lesson: {
    current: {
      session_item_id: "item-0",
      presentation_number: 1,
      is_reappearance: false,
      presented_at: "2026-08-29T10:00:00.000Z",
    },
    resolved_card_count: 0,
    total_card_count: 4,
    presentation_count: 0,
    presentation_cap: 12,
    completion_reason: null,
  },
  created_at: "2026-08-29T00:00:00.000Z",
  completed_at: null,
};

describe("Study spoken answer command", () => {
  test("pays for one transcription and replays even when archival fails", async () => {
    let transcriptions = 0;
    let archives = 0;
    let completed: StudyAnswerResultV2 | null = null;
    const recordedArchives: StudyAudioArchiveResult[] = [];
    const unused = () => Effect.die("unused Study store operation");
    const store: StudyV2Store = {
      getAvailability: unused,
      startSession: unused,
      getSession: unused,
      submitAnswer: unused,
      loadSpokenAnswerContext: () =>
        Effect.succeed({ item: item(0), referenceText: "Hold on", dominantLanguage: null }),
      reserveSpokenAnswer: (input) =>
        completed === null
          ? Effect.succeed({
              state: "reserved",
              commandId: "command-1",
              leaseToken: input.leaseToken,
              attemptId: input.attemptId,
              artifactId: input.artifactId,
            })
          : Effect.succeed({ state: "completed", result: completed }),
      failSpokenAnswer: () => Effect.void,
      completeSpokenAnswer: (input) => {
        recordedArchives.push(input.archive);
        completed = {
          object: "study_answer_result_v2",
          session_item_id: input.sessionItemId,
          attempt_number: input.attemptNumber,
          exercise_type: "say_it_back",
          outcome: input.grade.correct ? "correct" : "incorrect",
          first_pass: true,
          attempt_state: "spent",
          feedback: {
            kind: "transcript_diff",
            heard_transcript: input.grade.heardTranscript,
            matched: input.grade.matched,
            missing: input.grade.missing,
            extra: input.grade.extra,
            substituted: input.grade.substituted,
            policy_revision: input.grade.policyRevision,
          },
          session,
        };
        return Effect.succeed(completed);
      },
    };
    const service = makeStudyV2Service(store, {
      transcriber: {
        transcribe: () => {
          transcriptions += 1;
          return Effect.succeed({
            transcript: "Hold on",
            detectedLanguage: "en",
            detectedLanguageConfidence: 0.99,
          });
        },
      },
      archive: {
        store: () => {
          archives += 1;
          return Effect.succeed({ state: "failed", objectRef: null });
        },
      },
    });
    let id = 0;
    const run = () =>
      Effect.runPromise(
        service
          .submitSpokenAnswer({
            accountId: "account-1",
            attemptNumber: 1,
            audio: new Uint8Array([1, 2, 3]),
            audioContentType: "audio/webm",
            audioDurationMs: 1_000,
            communityId: "community-1",
            idempotencyKey: "answer-1",
            sessionId: "session-1",
            sessionItemId: "item-0",
          })
          .pipe(
            Effect.provideService(Clock, { now: Effect.succeed(Date.UTC(2026, 7, 29)) }),
            Effect.provideService(IdGen, { next: Effect.sync(() => String(++id)) }),
          ),
      );
    await expect(run()).resolves.toMatchObject({ outcome: "correct" });
    await expect(run()).resolves.toMatchObject({ outcome: "correct" });
    expect(transcriptions).toBe(1);
    expect(archives).toBe(1);
    expect(recordedArchives).toEqual([{ state: "failed", objectRef: null }]);
  });
});
