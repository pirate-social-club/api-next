import type { Alert } from "@pirate/application";

interface KaraokeFinalizationRecoveryAlertSummary {
  readonly rearmed: number;
  readonly missing: number;
  readonly rpcFailures: number;
}

const KARAOKE_FINALIZATION_RECOVERY_ALERT_JOB = "karaoke.finalization-recovery";

export function karaokeFinalizationRecoveryAlerts(
  summary: KaraokeFinalizationRecoveryAlertSummary,
): readonly Alert[] {
  const alerts: Alert[] = [];
  if (summary.rearmed > 0) {
    alerts.push({
      key: "karaoke-finalization-recovery:exhausted",
      severity: "high",
      body: "Exhausted Karaoke finalization work was centrally rearmed.",
      entity: `job:${KARAOKE_FINALIZATION_RECOVERY_ALERT_JOB}:count:${summary.rearmed}`,
    });
  }
  if (summary.missing > 0) {
    alerts.push({
      key: "karaoke-finalization-recovery:missing-object",
      severity: "high",
      body: "Postgres Karaoke finalization work has no Durable Object state.",
      entity: `job:${KARAOKE_FINALIZATION_RECOVERY_ALERT_JOB}:count:${summary.missing}`,
    });
  }
  if (summary.rpcFailures > 0) {
    alerts.push({
      key: "karaoke-finalization-recovery:rpc-failure",
      severity: "medium",
      body: "Karaoke finalization re-drive RPCs require a later sweep.",
      entity: `job:${KARAOKE_FINALIZATION_RECOVERY_ALERT_JOB}:count:${summary.rpcFailures}`,
    });
  }
  return alerts;
}
