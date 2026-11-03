import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import type { AlertSink, StudySpokenAnswerRecoveryBucket } from "@pirate/platform-cf";
import { Effect, Layer, Schedule } from "effect";
import {
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry.ts";
import {
  type GuestStudyRecoveryComposition,
  makeStudySourceRecoveryStages,
} from "./study-source-recovery-composition.ts";
import { runStudySourceRecoveryCycle } from "./study-source-recovery-cycle.ts";

// Existing registry name/schedule/lane and LEARNER_AUDIO registration gate stay
// stable. Implementation now resumes CLOSED accepted facts, not expired leases.
export const STUDY_SPOKEN_ANSWER_RECOVERY_JOB = "study-spoken-answer.recover-expired";
export const STUDY_SPOKEN_ANSWER_RECOVERY_LANE = "learner-audio-maintenance";
const READS = [
  "postgres:users",
  "postgres:account_aliases",
  "postgres:participation_owners",
  "postgres:guest_empty_owner_aliases",
  "postgres:guest_learning_schema_phase",
  "postgres:study_spoken_answer_commands",
  "postgres:learner_audio_artifacts",
  "postgres:study_sessions_v2",
  "postgres:study_session_items_v2",
  "postgres:study_review_items",
  "postgres:study_lesson_item_state_v2",
  "postgres:study_attempts_v2",
  "postgres:study_presentations_v2",
  "postgres:learner_audio_account_producer_captures",
  "postgres:learner_audio_account_spoken_checkpoints",
  "postgres:learner_audio_account_provider_calls",
  "postgres:learner_audio_upload_terminal_facts",
  "postgres:learner_audio_upload_attempts",
  "postgres:learner_audio_owner_fences",
  "postgres:learner_audio_deleted_objects",
  "postgres:learner_audio_object_names",
  "postgres:personas",
  "postgres:persona_community_bindings",
  "postgres:communities",
  "postgres:posts",
  "postgres:activity_qualifications",
  "postgres:account_streak_clocks",
  "postgres:song_streaks",
  "postgres:community_streaks",
  "postgres:song_streak_days",
  "postgres:song_streak_day_activities",
  "postgres:community_streak_days",
  "postgres:persona_activity_presentations",
  // Existing Account qualification triggers and adult-song authorization.
  "postgres:song_reward_offers",
  "postgres:song_reward_offer_legs",
  "postgres:megapot_pool_drawings",
  "postgres:policy_versions",
  "postgres:megapot_pool_shares",
  "postgres:reward_eligibility_decisions",
  "postgres:song_reward_bundle_claims",
  "postgres:song_reward_bundle_claim_legs",
  "postgres:reward_ledger_credits",
  "postgres:reward_subject_consumptions",
  "postgres:subject_keys",
  "postgres:active_subject_key_bindings",
  "postgres:assertion_bindings",
  "postgres:assertions",
  "postgres:evidence_receipts",
  "postgres:proof_sessions",
  "postgres:assertion_revalidation_events",
  "postgres:reward_uniqueness_authorities",
  "postgres:reward_asset_whitelist",
  "postgres:age_verification_ceremony_attempts",
  "postgres:age_verification_requirement_states",
  "postgres:account_age_verification_current",
] as const satisfies readonly TableKey[];
const GUEST_READS = [
  "postgres:guest_study_spoken_captures",
  "postgres:guest_study_spoken_checkpoints",
  "postgres:guest_participation_operations",
  "postgres:guest_resource_session_reservations",
  "postgres:guest_resource_provider_calls",
  "postgres:guest_resource_release_receipts",
  "postgres:guest_resource_global_lock",
  "postgres:guest_resource_edge_locks",
  // Exact pending-cleanup and positively confirmed owner-delete witnesses.
  "postgres:learner_audio_upload_cleanup_commands",
  "postgres:learner_audio_delete_batches",
  "postgres:learner_audio_delete_commands",
  "postgres:learner_audio_delete_sources",
  "postgres:learner_audio_delete_batch_items",
] as const satisfies readonly TableKey[];
export const STUDY_SPOKEN_ANSWER_RECOVERY_WRITES = [
  "postgres:study_spoken_answer_commands",
  "postgres:learner_audio_artifacts",
  "postgres:study_sessions_v2",
  "postgres:study_review_items",
  "postgres:study_lesson_item_state_v2",
  "postgres:study_attempts_v2",
  "postgres:study_presentations_v2",
  "postgres:activity_qualifications",
  "postgres:song_streaks",
  "postgres:community_streaks",
  "postgres:song_streak_days",
  "postgres:song_streak_day_activities",
  "postgres:community_streak_days",
  "postgres:persona_activity_presentations",
  // These existing Account fourth-card projections can execute in this job.
  // Shared Megapot writer ownership must be resolved before joint admission.
  "postgres:decision_records",
  "postgres:reward_eligibility_decisions",
  "postgres:megapot_pool_shares",
  "postgres:reward_subject_consumptions",
  "postgres:song_reward_bundle_claims",
  "postgres:song_reward_bundle_claim_legs",
  "postgres:song_reward_offer_legs",
  "postgres:reward_ledger_credits",
] as const satisfies readonly TableKey[];
const GUEST_WRITES = [
  "postgres:guest_participation_operations",
  "postgres:guest_resource_edge_locks",
  "postgres:guest_resource_session_reservations",
  "postgres:guest_resource_release_receipts",
  // learner_audio_artifacts is already declared by the shared Account closure.
  "postgres:learner_audio_upload_attempts",
  "postgres:learner_audio_upload_cleanup_commands",
] as const satisfies readonly TableKey[];
const SEVERITY: SeverityMapping = {
  expectedFailure: {
    ControlPlaneAcquireFailed: "medium",
    ControlPlaneOperationTimedOut: "medium",
    ControlPlaneStatementFailed: "high",
    ControlPlaneTransactionOutcomeUnknown: "high",
    StudyV2StoreFailed: "high",
    StudyV2CommandRejected: "medium",
    GuestParticipationStoreRejected: "high",
    GuestEphemeralStorageOutcomeUnknown: "high",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

export function makeStudySpokenAnswerRecoveryJob(
  sink: AlertSink,
  _registrationBucket: StudySpokenAnswerRecoveryBucket,
  guest?: GuestStudyRecoveryComposition,
  maximumAccountContinuations = 25,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.fn("StudySourceRecoveryJob.run")(function* () {
    const db = yield* ControlPlaneDb,
      collector = yield* AlertCollector;
    const summary = yield* runStudySourceRecoveryCycle(
      makeStudySourceRecoveryStages(
        Layer.succeed(ControlPlaneDb, db),
        guest,
        maximumAccountContinuations,
      ),
    );
    if (summary.account.fenced > 0)
      yield* collector.emit({
        key: "study-spoken-answer-recovery:account-continuation-pending",
        severity: "high",
        body: "Accepted Account Study checkpoint continuation remains unresolved.",
        entity: `job:${STUDY_SPOKEN_ANSWER_RECOVERY_JOB}:count:${summary.account.fenced}`,
      });
    if (summary.guest !== null && summary.guest.pending > 0)
      yield* collector.emit({
        key: "study-spoken-answer-recovery:guest-continuation-pending",
        severity: "medium",
        body: "Accepted guest Study checkpoint continuation remains unresolved.",
        entity: `job:${STUDY_SPOKEN_ANSWER_RECOVERY_JOB}:count:${summary.guest.pending}`,
      });
  })().pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );
  return {
    name: STUDY_SPOKEN_ANSWER_RECOVERY_JOB,
    lane: STUDY_SPOKEN_ANSWER_RECOVERY_LANE,
    schedule: "* * * * *",
    timeout: "45 seconds",
    // One bounded tick; uncertain acknowledgement is reconciled from original
    // durable facts next tick, never replayed by generic same-tick retries.
    retry: Schedule.recurs(0),
    expectedFailures: Object.keys(SEVERITY.expectedFailure),
    severity: SEVERITY,
    reads: [...READS, ...(guest === undefined ? [] : GUEST_READS)],
    writes: [...STUDY_SPOKEN_ANSWER_RECOVERY_WRITES, ...(guest === undefined ? [] : GUEST_WRITES)],
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
