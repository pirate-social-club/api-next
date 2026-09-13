import {
  type ControlPlaneError,
  type ControlPlaneTransaction,
  hnsRootImportLifecycleStateFromRowV1,
  planHnsRootImportLifecycleCommitV1,
} from "@pirate/application";
import type { HnsRootImportLifecycleEventV1 } from "@pirate/domain";
import { Effect } from "effect";

/**
 * Commit one lifecycle event inside a control-plane transaction the caller
 * already owns, against the reviewed SQL contract in migration 0137.
 *
 * The transition is committed in the same transaction as the fact it records —
 * the acknowledgement and its scheduled work — so an operation cannot end up
 * with the fact persisted and its lifecycle unmoved. The decision stays in the
 * pure reducer; PostgreSQL enforces revisions and transition invariants.
 */

export type HnsRootImportLifecycleTransitionResultV1 = Readonly<{
  readonly outcome: "transition" | "replay" | "pending" | "rejection";
  /** `lifecycle_absent` is explicit evidence, never a silently skipped event. */
  readonly reason: string;
}>;

type Row = Record<string, unknown>;

export function commitHnsRootImportLifecycleEventV1(
  transaction: ControlPlaneTransaction,
  rootImportSessionId: string,
  event: HnsRootImportLifecycleEventV1,
  nowEpochMs: number = event.occurred_at_epoch_ms,
): Effect.Effect<HnsRootImportLifecycleTransitionResultV1, ControlPlaneError, never> {
  return Effect.gen(function* () {
    const loaded = yield* transaction.execute<Row>({
      label: "hns.root-import-lifecycle.load-for-update",
      text: `SELECT phase, revision, generation, plan_exposed_at, publication_deadline_at,
                    first_current_observation_at, finality_deadline_at, readiness_observed_at,
                    pending_reason, next_check_at, observation_count,
                    consecutive_operational_failures, last_useful_error, last_useful_error_at,
                    terminal_decided_at
               FROM hns_root_import_lifecycle
              WHERE root_import_session_id=$1
                FOR UPDATE`,
      values: [rootImportSessionId],
      readonly: false,
    });
    const row = loaded.rows[0];
    if (loaded.rows.length !== 1 || row === undefined) {
      // A session that predates this machinery. Reported rather than invented:
      // a guessed phase is the reasoning that authorized destroying live
      // authority, and the caller decides what to do with the absence.
      return { outcome: "rejection", reason: "lifecycle_absent" } as const;
    }
    const applied = yield* transaction.execute<Row>({
      label: "hns.root-import-lifecycle.load-applied-events",
      text: "SELECT event_id FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1",
      values: [rootImportSessionId],
      readonly: false,
    });
    const state = hnsRootImportLifecycleStateFromRowV1(
      row,
      applied.rows.map((entry) => String(entry.event_id)),
    );
    const plan = planHnsRootImportLifecycleCommitV1(state, event, nowEpochMs);
    yield* transaction.execute({
      label: "hns.root-import-lifecycle.commit-decision",
      text: "SELECT * FROM commit_hns_root_import_lifecycle_decision_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)",
      values: [
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
      readonly: false,
    });
    return { outcome: plan.outcome_kind, reason: plan.outcome_reason } as const;
  });
}
