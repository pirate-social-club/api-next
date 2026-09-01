import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import {
  type AlertSink,
  type KaraokeFinalizationRecoveryNamespace,
  makeControlPlaneKaraokeFinalizationRecoveryStore,
  redriveKaraokeFinalizations,
} from "@pirate/platform-cf";
import { Effect, Layer } from "effect";

import { karaokeFinalizationRecoveryAlerts } from "./karaoke-finalization-recovery-alerts";
import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export const KARAOKE_FINALIZATION_RECOVERY_JOB = "karaoke.finalization-recovery";
export const KARAOKE_FINALIZATION_RECOVERY_LANE = "learner-audio-maintenance";
export const KARAOKE_FINALIZATION_RECOVERY_SCHEDULE = "* * * * *";
export const KARAOKE_FINALIZATION_RECOVERY_TIMEOUT = "45 seconds";

export const KARAOKE_FINALIZATION_RECOVERY_READS = [
  "postgres:karaoke_sessions",
  "postgres:karaoke_recordings",
] as const satisfies readonly TableKey[];

const KARAOKE_FINALIZATION_RECOVERY_SEVERITY: SeverityMapping = {
  expectedFailure: {
    ControlPlaneAcquireFailed: "medium",
    ControlPlaneOperationTimedOut: "medium",
    ControlPlaneStatementFailed: "medium",
    ControlPlaneTransactionOutcomeUnknown: "high",
    KaraokeFinalizationRecoveryInvalidRow: "high",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

export function makeKaraokeFinalizationRecoveryJob(
  sink: AlertSink,
  namespace: KaraokeFinalizationRecoveryNamespace,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const summary = yield* redriveKaraokeFinalizations({
      store: makeControlPlaneKaraokeFinalizationRecoveryStore(Layer.succeed(ControlPlaneDb, db)),
      namespace,
    });
    for (const alert of karaokeFinalizationRecoveryAlerts(summary)) {
      yield* collector.emit(alert);
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );

  return {
    name: KARAOKE_FINALIZATION_RECOVERY_JOB,
    lane: KARAOKE_FINALIZATION_RECOVERY_LANE,
    schedule: KARAOKE_FINALIZATION_RECOVERY_SCHEDULE,
    timeout: KARAOKE_FINALIZATION_RECOVERY_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: Object.keys(KARAOKE_FINALIZATION_RECOVERY_SEVERITY.expectedFailure),
    severity: KARAOKE_FINALIZATION_RECOVERY_SEVERITY,
    reads: KARAOKE_FINALIZATION_RECOVERY_READS,
    writes: [],
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
