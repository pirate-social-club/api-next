import {
  hnsRootImportLifecycleStateFromRowV1,
  planHnsRootImportLifecycleCommitV1,
} from "@pirate/application/namespace-ownership";
import type { HnsRootImportLifecycleEventV1 } from "@pirate/domain";

/**
 * Commit one lifecycle event inside a transaction the caller already owns.
 *
 * The transition is applied in the same transaction that persists what the
 * event is about — the validated plan, the acknowledgement — so an operation
 * can never be left with the fact recorded and its lifecycle unmoved, or the
 * reverse. The decision itself stays in the pure reducer; this only loads
 * authority, decides, and commits.
 */

export type LifecycleTransactionClient = Readonly<{
  readonly query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: Row[] }>;
}>;

export type LifecycleTransitionResult = Readonly<{
  readonly applied: boolean;
  /** `lifecycle_absent` is explicit evidence, never a silently skipped event. */
  readonly reason: string;
}>;

export async function commitLifecycleEventInTransaction(
  client: LifecycleTransactionClient,
  rootImportSessionId: string,
  event: HnsRootImportLifecycleEventV1,
  nowEpochMs: number = event.occurred_at_epoch_ms,
): Promise<LifecycleTransitionResult> {
  const loaded = await client.query<Record<string, unknown>>(
    `SELECT phase, revision, generation, plan_exposed_at, publication_deadline_at,
            first_current_observation_at, finality_deadline_at, readiness_observed_at,
            pending_reason, next_check_at, observation_count,
            consecutive_operational_failures, last_useful_error, last_useful_error_at,
            terminal_decided_at
       FROM hns_root_import_lifecycle
      WHERE root_import_session_id=$1
        FOR UPDATE`,
    [rootImportSessionId],
  );
  const row = loaded.rows[0];
  if (loaded.rows.length !== 1 || row === undefined) {
    // A session that predates this machinery. Reported, never invented: a
    // guessed phase is what authorized destroying live authority before.
    return { applied: false, reason: "lifecycle_absent" };
  }
  const applied = await client.query<{ readonly event_id: string }>(
    "SELECT event_id FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1",
    [rootImportSessionId],
  );
  const state = hnsRootImportLifecycleStateFromRowV1(
    row,
    applied.rows.map((entry) => entry.event_id),
  );
  const plan = planHnsRootImportLifecycleCommitV1(state, event, nowEpochMs);
  await client.query(
    `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [
      rootImportSessionId,
      plan.expected_revision,
      event.event_id,
      event.event,
      plan.outcome_kind,
      plan.outcome_reason,
      plan.next_phase,
      plan.deadline_patch,
      plan.requested_work_json,
    ],
  );
  return { applied: plan.outcome_kind === "transition", reason: plan.outcome_reason };
}
