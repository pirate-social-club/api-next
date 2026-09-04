import { type AlertCollector, ControlPlaneDb } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect } from "effect";
import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export const HNS_ROOT_HEALTH_RENEWAL_JOB = "hns-root-health-renewal.schedule";
export const HNS_ROOT_HEALTH_RENEWAL_LANE = "hns-root-health-renewal";
export const HNS_ROOT_HEALTH_RENEWAL_SCHEDULE = "*/30 * * * *";
export const HNS_ROOT_HEALTH_RENEWAL_TIMEOUT = "15 seconds";
export const HNS_ROOT_HEALTH_RENEW_WHEN_REMAINING_SECONDS = 3 * 24 * 60 * 60;
export const HNS_ROOT_HEALTH_HEARTBEAT_FRESHNESS_SECONDS = 2 * 60 * 60;
export const HNS_ROOT_HEALTH_RENEWAL_BATCH_LIMIT = 25;

export const HNS_ROOT_HEALTH_RENEWAL_READS = [
  "postgres:hns_root_import_activation_operations",
  "postgres:hns_root_import_sessions",
  "postgres:hns_dns_zone_activation_current",
  "postgres:hns_dns_zone_health_observations",
] as const satisfies readonly TableKey[];

export const HNS_ROOT_HEALTH_RENEWAL_WRITES = [
  "postgres:hns_root_health_renewal_jobs",
  "postgres:hns_root_health_renewal_scheduler_heartbeat",
] as const satisfies readonly TableKey[];

const severity: SeverityMapping = {
  expectedFailure: {},
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

type Row = Readonly<Record<string, unknown>>;

function nonnegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function makeHnsRootHealthRenewalJob(
  sink: AlertSink,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const scheduled = yield* db.execute<Row>({
      label: "jobs.hns-root-health-renewal.schedule",
      text: "SELECT * FROM schedule_hns_root_health_renewals_v1($1,$2,$3)",
      values: [
        HNS_ROOT_HEALTH_RENEWAL_BATCH_LIMIT,
        HNS_ROOT_HEALTH_RENEW_WHEN_REMAINING_SECONDS,
        HNS_ROOT_HEALTH_HEARTBEAT_FRESHNESS_SECONDS,
      ],
      readonly: false,
    });
    const row = scheduled.rows[0];
    if (
      scheduled.rows.length !== 1 ||
      nonnegativeInteger(row?.eligible_roots) === null ||
      nonnegativeInteger(row?.enqueued_roots) === null ||
      (!(row?.successful_tick_at instanceof Date) && typeof row?.successful_tick_at !== "string")
    ) {
      return yield* Effect.die(
        new Error("HNS root health renewal scheduler returned invalid data"),
      );
    }
  }).pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );

  return {
    name: HNS_ROOT_HEALTH_RENEWAL_JOB,
    lane: HNS_ROOT_HEALTH_RENEWAL_LANE,
    schedule: HNS_ROOT_HEALTH_RENEWAL_SCHEDULE,
    timeout: HNS_ROOT_HEALTH_RENEWAL_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: [],
    severity,
    reads: HNS_ROOT_HEALTH_RENEWAL_READS,
    writes: HNS_ROOT_HEALTH_RENEWAL_WRITES,
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
