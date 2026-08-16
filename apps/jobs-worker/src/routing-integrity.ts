import { AlertCollector, ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { type Duration, Effect } from "effect";

import {
  defaultRetrySchedule,
  JobContext,
  type JobDeclaration,
  type SeverityMapping,
  type TableKey,
} from "./registry";

export const COMMUNITY_ROUTING_INTEGRITY_JOB = "community-routing.integrity-audit";
export const COMMUNITY_ROUTING_INTEGRITY_LANE = "control-plane-maintenance";
export const COMMUNITY_ROUTING_INTEGRITY_SCHEDULE = "*/5 * * * *";
export const COMMUNITY_ROUTING_INTEGRITY_TIMEOUT = "20 seconds";
export const COMMUNITY_ROUTING_STALE_AFTER_MS = 15 * 60 * 1000;

export const COMMUNITY_ROUTING_READS = [
  "control-plane:community_database_routing",
] as const satisfies readonly TableKey[];

/** Postgres-only, read-only invariant query for the authoritative route directory. */
export const COMMUNITY_ROUTING_INTEGRITY_SQL = `
  SELECT violation, COUNT(*)::integer AS violation_count
  FROM (
    SELECT 'stuck_provisioning' AS violation
    FROM community_database_routing
    WHERE backend = 'd1'
      AND provisioning_state = 'provisioning'
      AND updated_at < $1
    UNION ALL
    SELECT 'ready_missing_binding' AS violation
    FROM community_database_routing
    WHERE backend = 'd1'
      AND provisioning_state = 'ready'
      AND (
        shard_worker_id IS NULL
        OR binding_name IS NULL
        OR region IS NULL
        OR decommissioned_at IS NOT NULL
      )
    UNION ALL
    SELECT 'decommissioned_missing_timestamp' AS violation
    FROM community_database_routing
    WHERE backend = 'd1'
      AND provisioning_state = 'decommissioned'
      AND decommissioned_at IS NULL
  ) AS route_violations
  GROUP BY violation
  ORDER BY violation
`;

type RoutingViolation =
  | "stuck_provisioning"
  | "ready_missing_binding"
  | "decommissioned_missing_timestamp";

interface RoutingViolationRow {
  readonly violation: unknown;
  readonly violation_count: unknown;
}

const ALERT_BODY: Record<RoutingViolation, string> = {
  stuck_provisioning: "Community routing integrity invariant failed: stale provisioning.",
  ready_missing_binding: "Community routing integrity invariant failed: ready route is incomplete.",
  decommissioned_missing_timestamp:
    "Community routing integrity invariant failed: decommissioned route has no timestamp.",
};

const ALERT_SEVERITY: Record<RoutingViolation, "medium" | "high"> = {
  stuck_provisioning: "medium",
  ready_missing_binding: "high",
  decommissioned_missing_timestamp: "high",
};

export const COMMUNITY_ROUTING_SEVERITY: SeverityMapping = {
  expectedFailure: {
    ControlPlaneAcquireFailed: "high",
    ControlPlaneOperationTimedOut: "medium",
    ControlPlaneStatementFailed: "high",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

function violationOf(value: unknown): RoutingViolation | null {
  return value === "stuck_provisioning" ||
    value === "ready_missing_binding" ||
    value === "decommissioned_missing_timestamp"
    ? value
    : null;
}

function positiveCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function failureTag(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = error._tag;
    if (
      tag === "ControlPlaneAcquireFailed" ||
      tag === "ControlPlaneOperationTimedOut" ||
      tag === "ControlPlaneStatementFailed" ||
      tag === "ControlPlaneTransactionOutcomeUnknown"
    )
      return tag;
  }
  return "unexpected";
}

export interface CommunityRoutingIntegrityJobOptions {
  readonly now?: () => number;
  readonly timeout?: Duration.Input;
}

/**
 * The only side effect is an AlertCollector emission. The control-plane query
 * is read-only and its table inventory is declared alongside the job metadata.
 */
export function makeCommunityRoutingIntegrityJob(
  sink: AlertSink,
  options: CommunityRoutingIntegrityJobOptions = {},
): JobDeclaration<ControlPlaneError, ControlPlaneDb | AlertCollector> {
  const now = options.now ?? Date.now;
  const run = Effect.gen(function* () {
    const runtime = yield* JobContext;
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const cutoff = new Date(now() - COMMUNITY_ROUTING_STALE_AFTER_MS).toISOString();
    const result = yield* Effect.onInterrupt(
      db.execute<RoutingViolationRow>({
        label: "jobs.community-routing.integrity-audit",
        text: COMMUNITY_ROUTING_INTEGRITY_SQL,
        values: [cutoff],
        readonly: true,
      }),
      () => Effect.sync(runtime.adapterSafety.markAbortedOrFenced),
    );

    for (const row of result.rows) {
      const violation = violationOf(row.violation);
      const count = positiveCount(row.violation_count);
      if (violation === null || count === null) continue;
      yield* collector.emit({
        key: "community-routing:integrity",
        severity: ALERT_SEVERITY[violation],
        body: ALERT_BODY[violation],
        entity: `routing:${violation}`,
      });
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const collector = yield* AlertCollector;
        yield* collector.emit({
          key: "community-routing:audit-failure",
          severity: "high",
          body: "Community routing integrity audit could not complete.",
          entity: `failure:${failureTag(error)}`,
        });
        return yield* Effect.fail(error);
      }),
    ),
  );

  return {
    name: COMMUNITY_ROUTING_INTEGRITY_JOB,
    lane: COMMUNITY_ROUTING_INTEGRITY_LANE,
    schedule: COMMUNITY_ROUTING_INTEGRITY_SCHEDULE,
    timeout: options.timeout ?? COMMUNITY_ROUTING_INTEGRITY_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: [
      "ControlPlaneAcquireFailed",
      "ControlPlaneOperationTimedOut",
      "ControlPlaneStatementFailed",
    ],
    severity: COMMUNITY_ROUTING_SEVERITY,
    reads: COMMUNITY_ROUTING_READS,
    writes: [],
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
