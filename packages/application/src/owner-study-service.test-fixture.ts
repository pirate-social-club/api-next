// Retained current protocol unit fixture, extracted unchanged public checks.
// No database/HTTP/authority claim; parent owns its future execution.

import { GuestStudyAnswerResultV1 } from "@pirate/contracts";
import { Schema } from "effect";
import type { LearningAccess } from "./guest-participation-authority.ts";
import type { OwnerStudyAnswer } from "./guest-study-ports.ts";
import type { OwnerSpokenPreArchiveSuccess } from "./owner-spoken-success-protocol.ts";
import { ControlPlaneTransactionOutcomeUnknown } from "./ports.ts";
import {
  gradeStudySpokenTranscript,
  projectStudySpokenFeedback,
} from "./study-shared-lesson-engine.ts";
const operation = {
  sourceOwnerId: "owner-original",
  kind: "study_answer" as const,
  idempotencyKey: "answer-original",
  requestHash: "a".repeat(64),
};
export const transcript = {
  transcript: "I can love you",
  detectedLanguage: "en",
  detectedLanguageConfidence: 0.99,
};
const grading = gradeStudySpokenTranscript({
  referenceText: transcript.transcript,
  transcript: transcript.transcript,
  dominantLanguage: null,
  policy: "script_aware_token_phonetic_v2",
  languageProvenance: { kind: "no_authoritative_evidence" },
  detectedLanguage: "en",
  detectedLanguageConfidence: 0.99,
});
export const success: OwnerSpokenPreArchiveSuccess = {
  source: { kind: "guest", ownerId: "owner-original" },
  operation,
  commandId: "command-original",
  resourceReservationId: "resource-original",
  deletionFenceRevision: 0,
  providerResult: transcript,
  result: {
    acceptedAt: "2026-10-12T12:00:00.000Z",
    artifactId: "artifact-original",
    attemptId: "attempt-original",
    attemptNumber: 1,
    audioByteSize: 3,
    audioContentType: "audio/webm",
    audioDigest: "b".repeat(64),
    audioDurationMs: 1000,
    commandId: "command-original",
    leaseToken: "original-private-dispatch-lease",
    communityId: "community-original",
    ...grading,
    languageProvenance: { kind: "no_authoritative_evidence" },
    rerecordEnabled: true,
    providerDetectedLanguage: "en",
    providerDetectedLanguageConfidence: 0.99,
    qualificationId: "unused-guest-candidate",
    requestHash: operation.requestHash,
    sessionId: "session-original",
    sessionItemId: "item-original",
  },
};
const oldAccess: LearningAccess = {
  kind: "guest",
  ownerId: "owner-original",
  credentialId: "credential-before-provider",
  origin: "https://community.example",
  leaseUntil: "2000-01-01T00:00:00.000Z",
};
const committed = <A>(outcomeId: string, result: A) => ({
  state: "completed" as const,
  operation,
  outcomeId,
  result,
});
export const uncertain = () =>
  new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "private-checkpoint-fixture",
    limitMs: 1,
    elapsedMs: 1,
  });
// A complete public answer fixture, strictly decoded through genuine frozen
// checks. This ordering test does not claim it ran the production finalizer.
export const finalAnswer: Extract<OwnerStudyAnswer, { source: { kind: "guest" } }> = {
  source: success.source,
  participation: { state: "practice_only" },
  answer: Schema.decodeUnknownSync(GuestStudyAnswerResultV1, {
    onExcessProperty: "error",
  })({
    object: "guest_study_answer_result_v1",
    session_item_id: "item-0",
    attempt_number: 1,
    exercise_type: "say_it_back",
    outcome: "correct",
    first_pass: true,
    attempt_state: "spent",
    feedback: projectStudySpokenFeedback(grading.grade).feedback,
    participation: { state: "practice_only" },
    session: {
      object: "guest_study_session_v1",
      actor: { kind: "guest" },
      owner_id: success.source.ownerId,
      session_id: "session-original",
      community_id: "community-original",
      post_id: "post-original",
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
      items: Array.from({ length: 4 }, (_, ordinal) => ({
        object: "study_session_item_v2",
        session_item_id: `item-${ordinal}`,
        ordinal,
        exercise_review_key: `review-${ordinal}`,
        exercise_version_id: `version-${ordinal}`,
        exercise_type: "say_it_back",
        exercise_variant: "spoken-recall-v1",
        line: {
          post_id: "post-original",
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
          reference_text: transcript.transcript,
          capture: "microphone_audio",
        },
        answer_visibility: "always_visible",
        feedback_release: "every_graded_attempt",
        grader_policy_revision: "script_aware_token_phonetic_v2",
        feedback_policy_revision: "spoken-feedback-v1",
        quality_policy_revision: "study-quality-v1",
        maximum_attempts: 3,
      })),
      progress: {
        qualifying_exercise_count: 4,
        answered_exercise_count: 1,
        first_pass_correct: 1,
        required_correct: 3,
        score_bps: null,
      },
      lesson: {
        current: {
          session_item_id: "item-1",
          presentation_number: 1,
          is_reappearance: false,
          presented_at: success.result.acceptedAt,
        },
        resolved_card_count: 1,
        total_card_count: 4,
        presentation_count: 1,
        presentation_cap: 12,
        completion_reason: null,
      },
      created_at: "2026-10-12T10:00:00.000Z",
      completed_at: null,
      expires_at: "2026-10-13T10:00:00.000Z",
      reward_mode: "practice_only",
      reward_terms: null,
      participation: { state: "practice_only" },
    },
  }),
};
