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

export const COMMUNITY_CATALOG_INTEGRITY_JOB = "community-catalog.integrity-audit";
export const COMMUNITY_CATALOG_INTEGRITY_LANE = "control-plane-maintenance";
export const COMMUNITY_CATALOG_INTEGRITY_SCHEDULE = "*/5 * * * *";
export const COMMUNITY_CATALOG_INTEGRITY_TIMEOUT = "20 seconds";

export const COMMUNITY_CATALOG_READS = [
  "postgres:communities",
] as const satisfies readonly TableKey[];

/** Postgres-only, read-only checks against the api-next community catalog. */
export const COMMUNITY_CATALOG_INTEGRITY_SQL = `
  SELECT violation, COUNT(*)::integer AS violation_count
  FROM (
    SELECT 'blank_display_name' AS violation
    FROM communities
    WHERE btrim(display_name) = ''
    UNION ALL
    SELECT 'blank_creator_user_id' AS violation
    FROM communities
    WHERE btrim(created_by_user_id) = ''
    UNION ALL
    SELECT 'updated_before_created' AS violation
    FROM communities
    WHERE updated_at < created_at
  ) AS catalog_violations
  GROUP BY violation
  ORDER BY violation
`;

type CatalogViolation = "blank_display_name" | "blank_creator_user_id" | "updated_before_created";

interface RoutingViolationRow {
  readonly violation: unknown;
  readonly violation_count: unknown;
}

const ALERT_BODY: Record<CatalogViolation, string> = {
  blank_display_name: "Community catalog integrity invariant failed: display name is blank.",
  blank_creator_user_id: "Community catalog integrity invariant failed: creator user id is blank.",
  updated_before_created:
    "Community catalog integrity invariant failed: updated_at precedes created_at.",
};

const ALERT_SEVERITY: Record<CatalogViolation, "medium" | "high"> = {
  blank_display_name: "high",
  blank_creator_user_id: "high",
  updated_before_created: "high",
};

export const COMMUNITY_CATALOG_SEVERITY: SeverityMapping = {
  expectedFailure: {
    ControlPlaneAcquireFailed: "medium",
    ControlPlaneOperationTimedOut: "medium",
    ControlPlaneStatementFailed: "medium",
  },
  timeout: "high",
  transactionOutcomeUnknown: "high",
  defect: "high",
};

function violationOf(value: unknown): CatalogViolation | null {
  return value === "blank_display_name" ||
    value === "blank_creator_user_id" ||
    value === "updated_before_created"
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

export interface CommunityCatalogIntegrityJobOptions {
  readonly timeout?: Duration.Input;
}

/**
 * The only side effect is an AlertCollector emission. The control-plane query
 * is read-only and its table inventory is declared alongside the job metadata.
 * The historical module name is retained because this job is the successor to
 * the old routing audit, but api-next has no routing directory or D1 binding.
 */
export function makeCommunityCatalogIntegrityJob(
  sink: AlertSink,
  options: CommunityCatalogIntegrityJobOptions = {},
): JobDeclaration<ControlPlaneError, ControlPlaneDb | AlertCollector> {
  const run = Effect.gen(function* () {
    const runtime = yield* JobContext;
    const db = yield* ControlPlaneDb;
    const collector = yield* AlertCollector;
    const result = yield* Effect.onInterrupt(
      db.execute<RoutingViolationRow>({
        label: "jobs.community-catalog.integrity-audit",
        text: COMMUNITY_CATALOG_INTEGRITY_SQL,
        values: [],
        readonly: true,
      }),
      () => Effect.sync(runtime.adapterSafety.markAbortedOrFenced),
    );

    for (const row of result.rows) {
      const violation = violationOf(row.violation);
      const count = positiveCount(row.violation_count);
      if (violation === null || count === null) continue;
      yield* collector.emit({
        key: "community-catalog:integrity",
        severity: ALERT_SEVERITY[violation],
        body: ALERT_BODY[violation],
        entity: `community:${violation}`,
      });
    }
  });

  return {
    name: COMMUNITY_CATALOG_INTEGRITY_JOB,
    lane: COMMUNITY_CATALOG_INTEGRITY_LANE,
    schedule: COMMUNITY_CATALOG_INTEGRITY_SCHEDULE,
    timeout: options.timeout ?? COMMUNITY_CATALOG_INTEGRITY_TIMEOUT,
    retry: defaultRetrySchedule,
    expectedFailures: [
      "ControlPlaneAcquireFailed",
      "ControlPlaneOperationTimedOut",
      "ControlPlaneStatementFailed",
    ],
    severity: COMMUNITY_CATALOG_SEVERITY,
    reads: COMMUNITY_CATALOG_READS,
    writes: [],
    alertSink: sink,
    requiresAdapterSafety: true,
    run,
  };
}
