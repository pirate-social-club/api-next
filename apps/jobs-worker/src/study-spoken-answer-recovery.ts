import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import {
  type AlertSink,
  makeControlPlaneStudySpokenAnswerRecoveryStore,
  recoverExpiredStudySpokenAnswers,
  type StudySpokenAnswerRecoveryBucket,
} from "@pirate/platform-cf";
import { Clock, Effect, Layer } from "effect";

import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export const STUDY_SPOKEN_ANSWER_RECOVERY_JOB = "study-spoken-answer.recover-expired";
export const STUDY_SPOKEN_ANSWER_RECOVERY_LANE = "learner-audio-maintenance";
export const STUDY_SPOKEN_ANSWER_RECOVERY_SCHEDULE = "* * * * *";
export const STUDY_SPOKEN_ANSWER_RECOVERY_TIMEOUT = "45 seconds";

export const STUDY_SPOKEN_ANSWER_RECOVERY_READS = [
  "postgres:study_spoken_answer_commands",
  "postgres:learner_audio_artifacts",
] as const satisfies readonly TableKey[];

export const STUDY_SPOKEN_ANSWER_RECOVERY_WRITES = [
  "postgres:study_spoken_answer_commands",
  "postgres:learner_audio_artifacts",
] as const satisfies readonly TableKey[];

const STUDY_SPOKEN_ANSWER_RECOVERY_SEVERITY: SeverityMapping = {
  expectedFailure: {
    ControlPlaneAcquireFailed: "medium",
    ControlPlaneOperationTimedOut: "medium",
    ControlPlaneStatementFailed: "medium",
    ControlPlaneTransactionOutcomeUnknown: "high",
    StudySpokenAnswerRecoveryInvariantFailed: "high",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

export function makeStudySpokenAnswerRecoveryJob(
  sink: AlertSink,
  bucket: StudySpokenAnswerRecoveryBucket,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const context = yield* JobContext;
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const now = yield* Clock.currentTimeMillis;
    const summary = yield* recoverExpiredStudySpokenAnswers({
      store: makeControlPlaneStudySpokenAnswerRecoveryStore(Layer.succeed(ControlPlaneDb, db)),
      bucket,
      leaseToken: context.attemptId,
      failedAt: new Date(now).toISOString(),
    });
    if (summary.storageFailures > 0) {
      yield* collector.emit({
        key: "study-spoken-answer-recovery:storage-failure",
        severity: "medium",
        body: "Expired Study spoken-answer audio could not be confirmed absent.",
        entity: `job:${STUDY_SPOKEN_ANSWER_RECOVERY_JOB}:count:${summary.storageFailures}`,
      });
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );

  return {
    name: STUDY_SPOKEN_ANSWER_RECOVERY_JOB,
    lane: STUDY_SPOKEN_ANSWER_RECOVERY_LANE,
    schedule: STUDY_SPOKEN_ANSWER_RECOVERY_SCHEDULE,
    timeout: STUDY_SPOKEN_ANSWER_RECOVERY_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: Object.keys(STUDY_SPOKEN_ANSWER_RECOVERY_SEVERITY.expectedFailure),
    severity: STUDY_SPOKEN_ANSWER_RECOVERY_SEVERITY,
    reads: STUDY_SPOKEN_ANSWER_RECOVERY_READS,
    writes: STUDY_SPOKEN_ANSWER_RECOVERY_WRITES,
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
