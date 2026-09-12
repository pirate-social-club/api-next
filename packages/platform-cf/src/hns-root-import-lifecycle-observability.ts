import { redactedDiagnosticCause } from "@pirate/application/namespace-ownership";

/**
 * The bounded operational snapshot for the HNS lifecycle.
 *
 * Phase counts exclude synthetic probe rows through the same predicate the
 * partial index marks, so the probe can never appear as an operation. Overdue
 * lifecycle and renewal work, the oldest pending operation age and repeated
 * operational failures are reported; correlation rows name the operation and
 * carry a redacted last-error classification. It is a read-only operator
 * surface and is not exposed to the serving role.
 */

export type HnsLifecycleOperationalSnapshotV1 = Readonly<{
  readonly phase_counts: readonly Readonly<{ readonly phase: string; readonly count: number }>[];
  readonly oldest_pending_age_seconds: number | null;
  readonly overdue_lifecycle_jobs: number;
  readonly overdue_renewal_jobs: number;
  readonly oldest_overdue_seconds: number | null;
  readonly operations_with_failures: number;
  readonly max_consecutive_failures: number;
  readonly correlation: readonly Readonly<{
    readonly root_import_session_id: string;
    readonly phase: string;
    readonly generation: number;
    readonly revision: number;
    readonly consecutive_operational_failures: number;
    readonly last_useful_error: string | null;
    readonly last_useful_error_at: string | null;
  }>[];
  readonly sampled_at: string;
}>;

export class HnsLifecycleObservabilityUnavailable extends Error {
  override readonly name = "HnsLifecycleObservabilityUnavailable";

  constructor(readonly cause: string | null) {
    super(`HNS lifecycle operational snapshot unavailable: ${cause ?? "unknown"}`);
  }
}

export type HnsLifecycleSnapshotQuery = <
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  text: string,
  values?: readonly unknown[],
) => Promise<{ readonly rows: Row[] }>;

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/u.test(value)) return Number(value);
  return null;
}

function instantOrNull(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

export async function readHnsLifecycleOperationalSnapshotV1(
  query: HnsLifecycleSnapshotQuery,
): Promise<HnsLifecycleOperationalSnapshotV1> {
  try {
    const phases = await query<Record<string, unknown>>(
      `SELECT phase, count(*)::integer AS count
         FROM hns_root_import_lifecycle
        WHERE NOT synthetic
        GROUP BY phase
        ORDER BY phase`,
    );
    const pending = await query<Record<string, unknown>>(
      `SELECT floor(extract(epoch FROM (clock_timestamp() - min(updated_at))))::integer
                AS age_seconds
         FROM hns_root_import_lifecycle
        WHERE NOT synthetic AND phase NOT IN ('activated', 'failed')`,
    );
    const overdueLifecycle = await query<Record<string, unknown>>(
      `SELECT count(*)::integer AS count,
              floor(extract(epoch FROM (clock_timestamp() - min(job.due_at))))::integer
                AS oldest_seconds
         FROM hns_root_import_lifecycle_jobs AS job
         JOIN hns_root_import_lifecycle AS lifecycle
           ON lifecycle.root_import_session_id = job.root_import_session_id
        WHERE NOT lifecycle.synthetic
          AND job.generation = lifecycle.generation
          AND (
            (job.state = 'queued' AND job.due_at <= clock_timestamp())
            OR (job.state = 'leased' AND job.lease_expires_at <= clock_timestamp())
          )`,
    );
    const overdueRenewal = await query<Record<string, unknown>>(
      `SELECT count(*)::integer AS count,
              floor(extract(epoch FROM (clock_timestamp()
                - min(COALESCE(next_attempt_at, created_at)))))::integer AS oldest_seconds
         FROM hns_root_health_renewal_jobs
        WHERE state = 'queued'
           OR (state = 'delayed' AND next_attempt_at <= clock_timestamp())
           OR (state = 'leased' AND lease_expires_at <= clock_timestamp())`,
    );
    const failures = await query<Record<string, unknown>>(
      `SELECT count(*)::integer AS operations,
              COALESCE(max(consecutive_operational_failures), 0)::integer AS max_consecutive
         FROM hns_root_import_lifecycle
        WHERE NOT synthetic AND consecutive_operational_failures > 0`,
    );
    const correlation = await query<Record<string, unknown>>(
      `SELECT root_import_session_id, phase, generation, revision,
              consecutive_operational_failures, last_useful_error, last_useful_error_at
         FROM hns_root_import_lifecycle
        WHERE NOT synthetic AND consecutive_operational_failures > 0
        ORDER BY consecutive_operational_failures DESC,
                 last_useful_error_at DESC NULLS LAST,
                 root_import_session_id
        LIMIT 10`,
    );
    const now = await query<Record<string, unknown>>("SELECT clock_timestamp() AS sampled_at");
    const oldestLifecycle = numberOrNull(overdueLifecycle.rows[0]?.oldest_seconds);
    const oldestRenewal = numberOrNull(overdueRenewal.rows[0]?.oldest_seconds);
    const oldestOverdue = [oldestLifecycle, oldestRenewal]
      .filter((value): value is number => value !== null)
      .sort((left, right) => right - left)[0];
    return {
      phase_counts: phases.rows.map((row) => ({
        phase: String(row.phase),
        count: numberOrNull(row.count) ?? 0,
      })),
      oldest_pending_age_seconds: numberOrNull(pending.rows[0]?.age_seconds),
      overdue_lifecycle_jobs: numberOrNull(overdueLifecycle.rows[0]?.count) ?? 0,
      overdue_renewal_jobs: numberOrNull(overdueRenewal.rows[0]?.count) ?? 0,
      oldest_overdue_seconds: oldestOverdue ?? null,
      operations_with_failures: numberOrNull(failures.rows[0]?.operations) ?? 0,
      max_consecutive_failures: numberOrNull(failures.rows[0]?.max_consecutive) ?? 0,
      correlation: correlation.rows.map((row) => ({
        root_import_session_id: String(row.root_import_session_id),
        phase: String(row.phase),
        generation: numberOrNull(row.generation) ?? 0,
        revision: numberOrNull(row.revision) ?? 0,
        consecutive_operational_failures: numberOrNull(row.consecutive_operational_failures) ?? 0,
        last_useful_error: redactedDiagnosticCause(row.last_useful_error),
        last_useful_error_at: instantOrNull(row.last_useful_error_at),
      })),
      sampled_at: instantOrNull(now.rows[0]?.sampled_at) ?? new Date(0).toISOString(),
    };
  } catch (error) {
    // A snapshot is evidence about operations, not a place where raw
    // infrastructure failures surface: report a bounded, redacted cause.
    throw new HnsLifecycleObservabilityUnavailable(redactedDiagnosticCause(error));
  }
}
