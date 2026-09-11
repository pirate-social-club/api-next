import {
  decideHnsRootImportLifecycleV1,
  HNS_ROOT_IMPORT_POLICY_V1,
  type HnsRootImportLifecycleDecisionV1,
  type HnsRootImportLifecycleEventV1,
  type HnsRootImportLifecycleStateV1,
  hnsRootImportPolicyDigestV1,
  initialHnsRootImportLifecycleStateV1,
} from "@pirate/domain";
import { Data, Effect } from "effect";

/**
 * The application seam between the pure lifecycle transition function and its
 * durable storage — spec 012 (2026-09-09 amendment), "Phases and the pure
 * transition policy": the application layer loads authority, invokes the
 * function, and commits its decision; PostgreSQL enforces revisions and
 * transition invariants. No provider call runs inside a transition
 * transaction, so this service takes evidence as an argument and never
 * observes anything itself.
 */

export class HnsRootImportLifecycleStorageFailed extends Data.TaggedError(
  "HnsRootImportLifecycleStorageFailed",
)<{ readonly cause?: unknown; readonly reason?: string }> {}

/** The durable record of one committed decision. */
export type HnsRootImportLifecycleCommitResultV1 = Readonly<{
  readonly outcome: "transition" | "replay" | "pending" | "rejection";
  readonly revision: number;
  readonly replayed: boolean;
}>;

export type HnsRootImportLifecycleCommitInputV1 = Readonly<{
  readonly root_import_session_id: string;
  readonly expected_revision: number;
  readonly event_id: string;
  readonly event_name: HnsRootImportLifecycleEventV1["event"];
  readonly decision: HnsRootImportLifecycleDecisionV1;
}>;

export interface HnsRootImportLifecycleStore {
  /**
   * Create the operation in `preparing`. Idempotent by session identity: a
   * retried Start must not produce a second lifecycle for one session.
   */
  readonly create: (
    input: Readonly<{
      readonly root_import_session_id: string;
      readonly root_label: string;
      readonly generation: number;
    }>,
  ) => Effect.Effect<void, HnsRootImportLifecycleStorageFailed>;
  readonly load: (
    rootImportSessionId: string,
  ) => Effect.Effect<HnsRootImportLifecycleStateV1 | null, HnsRootImportLifecycleStorageFailed>;
  readonly commit: (
    input: HnsRootImportLifecycleCommitInputV1,
  ) => Effect.Effect<HnsRootImportLifecycleCommitResultV1, HnsRootImportLifecycleStorageFailed>;
}

export type HnsRootImportLifecycleServices = Readonly<{
  readonly lifecycle_store: HnsRootImportLifecycleStore;
  readonly now_epoch_ms: () => number;
}>;

/**
 * Begin the durable lifecycle for a freshly admitted import.
 *
 * The generation is the authority generation this operation owns, so a later
 * retirement authorization can be validated against the exact generation
 * rather than the session alone.
 */
export function beginHnsRootImportLifecycleV1(
  input: Readonly<{
    readonly root_import_session_id: string;
    readonly root_label: string;
    readonly generation: number;
  }>,
  services: HnsRootImportLifecycleServices,
): Effect.Effect<HnsRootImportLifecycleStateV1, HnsRootImportLifecycleStorageFailed> {
  return Effect.gen(function* () {
    yield* services.lifecycle_store.create(input);
    const loaded = yield* services.lifecycle_store.load(input.root_import_session_id);
    return loaded ?? initialHnsRootImportLifecycleStateV1(input.generation);
  });
}

export type HnsRootImportLifecycleApplyResultV1 = Readonly<{
  readonly decision: HnsRootImportLifecycleDecisionV1;
  readonly committed: HnsRootImportLifecycleCommitResultV1 | null;
  readonly state: HnsRootImportLifecycleStateV1 | null;
}>;

/**
 * Apply one event: load the authoritative state, decide, and commit.
 *
 * An operation with no lifecycle row is a migrated session that predates this
 * machinery. It is reported rather than invented, because guessing a phase
 * for a session whose history is unknown is exactly the reasoning that
 * authorized destroying live authority.
 */
export function applyHnsRootImportLifecycleEventV1(
  input: Readonly<{
    readonly root_import_session_id: string;
    readonly event: HnsRootImportLifecycleEventV1;
  }>,
  services: HnsRootImportLifecycleServices,
): Effect.Effect<HnsRootImportLifecycleApplyResultV1, HnsRootImportLifecycleStorageFailed> {
  return Effect.gen(function* () {
    const state = yield* services.lifecycle_store.load(input.root_import_session_id);
    if (state === null) {
      return {
        decision: {
          outcome: { kind: "rejection", reason: "lifecycle_absent" },
          next_state: null,
          requested_work: [],
        },
        committed: null,
        state: null,
      } as const;
    }
    const decision = decideHnsRootImportLifecycleV1(
      state,
      input.event,
      HNS_ROOT_IMPORT_POLICY_V1,
      services.now_epoch_ms(),
    );
    const committed = yield* services.lifecycle_store.commit({
      root_import_session_id: input.root_import_session_id,
      expected_revision: state.revision,
      event_id: input.event.event_id,
      event_name: input.event.event,
      decision,
    });
    return { decision, committed, state: decision.next_state ?? state } as const;
  });
}

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

/** The policy identity every lifecycle row records, for migration safety. */
export const HNS_ROOT_IMPORT_LIFECYCLE_POLICY_NAME_V1 = "hns_root_import_lifecycle_v1";

export function hnsRootImportLifecyclePolicyDigest(): string {
  return hnsRootImportPolicyDigestV1();
}

export { HNS_ROOT_IMPORT_POLICY_V1 };
