import {
  decideHnsRootImportLifecycleV1,
  HNS_ROOT_IMPORT_POLICY_V1,
  type HnsRootImportLifecycleDecisionV1,
  type HnsRootImportLifecycleEventV1,
  type HnsRootImportLifecycleStateV1,
  hnsRootImportPolicyDigestV1,
} from "@pirate/domain";

/**
 * The lifecycle row codec, deadline patch and decision serialization shared by
 * the control plane and the provisioner.
 *
 * The exact loading, reduction and mutation-argument construction must not
 * drift between the two adapters, so it lives here rather than in either
 * adapter or in the retired application service. The service's uncalled
 * begin/apply functions and their store ports were removal targets, not a
 * compatibility surface.
 */

/**
 * Map one `hns_root_import_lifecycle` row plus its applied event identities
 * onto the reducer's state. Shared by every caller so the control plane and
 * the provisioner cannot drift into two readings of the same row.
 */
export function hnsRootImportLifecycleStateFromRowV1(
  row: Readonly<Record<string, unknown>>,
  appliedEventIds: Iterable<string>,
): HnsRootImportLifecycleStateV1 {
  const instant = (value: unknown): number | null =>
    value instanceof Date ? value.getTime() : null;
  const counted = (value: unknown): number => {
    const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  };
  return {
    phase: row.phase as HnsRootImportLifecycleStateV1["phase"],
    revision: counted(row.revision),
    generation: counted(row.generation),
    plan_exposed_at_epoch_ms: instant(row.plan_exposed_at),
    publication_deadline_at_epoch_ms: instant(row.publication_deadline_at),
    first_current_observation_at_epoch_ms: instant(row.first_current_observation_at),
    finality_deadline_at_epoch_ms: instant(row.finality_deadline_at),
    readiness_observed_at_epoch_ms: instant(row.readiness_observed_at),
    pending_reason: (row.pending_reason as string | null) ?? null,
    next_check_at_epoch_ms: instant(row.next_check_at),
    observation_count: counted(row.observation_count),
    consecutive_operational_failures: counted(row.consecutive_operational_failures),
    last_useful_error: (row.last_useful_error as string | null) ?? null,
    last_useful_error_at_epoch_ms: instant(row.last_useful_error_at),
    applied_event_ids: new Set(appliedEventIds),
    terminal_decided_at_epoch_ms: instant(row.terminal_decided_at),
  };
}

/**
 * The patch the commit function applies.
 *
 * A timestamp is sent only when the prior state did not already hold it. Two
 * reasons, both load-bearing. The anchor and the finality deadline are
 * immutable once set and the database enforces that with `IS DISTINCT FROM`,
 * and PostgreSQL keeps microseconds while a JavaScript `Date` keeps
 * milliseconds — so resending a stored value at all would drift it and trip
 * the guard. Omitting it lets the commit function's COALESCE keep exactly what
 * is stored, which is also what "anchored exactly once, never recomputed on
 * restart" requires.
 */
export function hnsRootImportLifecycleDeadlinePatchV1(
  state: HnsRootImportLifecycleStateV1,
  prior?: HnsRootImportLifecycleStateV1,
): string {
  const iso = (value: number | null): string | null =>
    value === null ? null : new Date(value).toISOString();
  /** Established values are never rewritten, only established. */
  const established = (next: number | null, previous: number | null | undefined): string | null =>
    previous === null || previous === undefined ? iso(next) : null;
  return JSON.stringify({
    plan_exposed_at: established(state.plan_exposed_at_epoch_ms, prior?.plan_exposed_at_epoch_ms),
    publication_deadline_at: established(
      state.publication_deadline_at_epoch_ms,
      prior?.publication_deadline_at_epoch_ms,
    ),
    first_current_observation_at: established(
      state.first_current_observation_at_epoch_ms,
      prior?.first_current_observation_at_epoch_ms,
    ),
    finality_deadline_at: established(
      state.finality_deadline_at_epoch_ms,
      prior?.finality_deadline_at_epoch_ms,
    ),
    readiness_observed_at: iso(state.readiness_observed_at_epoch_ms),
    // Clearing is explicit. An absent field means "leave it alone", so an
    // invalidation has to say so rather than send a null the patch cannot
    // distinguish from omission.
    clear_readiness_observed_at:
      state.readiness_observed_at_epoch_ms === null &&
      prior !== undefined &&
      prior.readiness_observed_at_epoch_ms !== null,
    pending_reason: state.pending_reason,
    next_check_at: iso(state.next_check_at_epoch_ms),
    observation_count: state.observation_count,
    consecutive_operational_failures: state.consecutive_operational_failures,
    last_useful_error: state.last_useful_error,
    last_useful_error_at: iso(state.last_useful_error_at_epoch_ms),
    terminal_decided_at: iso(state.terminal_decided_at_epoch_ms),
  });
}

/** The positional arguments `commit_hns_root_import_lifecycle_decision_v1` consumes. */
export type HnsRootImportLifecycleCommitPlanV1 = Readonly<{
  readonly expected_revision: number;
  readonly outcome_kind: HnsRootImportLifecycleDecisionV1["outcome"]["kind"];
  readonly outcome_reason: string;
  readonly next_phase: string | null;
  readonly deadline_patch: string;
  readonly requested_work_json: string;
}>;

/**
 * Reduce one event and serialize the mutation arguments both adapters pass to
 * `commit_hns_root_import_lifecycle_decision_v1`. The reducer remains the only
 * business-policy owner; this shares the argument construction around it so a
 * change to the SQL contract lands in one place.
 *
 * The decision clock is an explicit required argument rather than a default
 * derived here. Each adapter already decides whether the caller supplies a
 * clock or the event's own occurrence time, and that choice belongs at the
 * adapter's transaction boundary, not silently inside the shared planner.
 */
export function planHnsRootImportLifecycleCommitV1(
  state: HnsRootImportLifecycleStateV1,
  event: HnsRootImportLifecycleEventV1,
  nowEpochMs: number,
): HnsRootImportLifecycleCommitPlanV1 {
  const decision = decideHnsRootImportLifecycleV1(
    state,
    event,
    HNS_ROOT_IMPORT_POLICY_V1,
    nowEpochMs,
  );
  const next = decision.next_state;
  return {
    expected_revision: state.revision,
    outcome_kind: decision.outcome.kind,
    outcome_reason: decision.outcome.reason,
    next_phase: next === null ? null : next.phase,
    deadline_patch: next === null ? "{}" : hnsRootImportLifecycleDeadlinePatchV1(next, state),
    requested_work_json: JSON.stringify(
      decision.requested_work.map((work) => ({
        kind: work.kind,
        due_at: new Date(work.due_at_epoch_ms).toISOString(),
      })),
    ),
  };
}

/** The policy identity every lifecycle row records, for migration safety. */
export const HNS_ROOT_IMPORT_LIFECYCLE_POLICY_NAME_V1 = "hns_root_import_lifecycle_v1";

export function hnsRootImportLifecyclePolicyDigest(): string {
  return hnsRootImportPolicyDigestV1();
}
