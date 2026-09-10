/**
 * HNS root-import lifecycle, finality, and authority retention — pure
 * domain transition policy (spec 012, 2026-09-09 amendment). The function
 * consumes explicit operation state, event, evidence, time, and policy
 * inputs, and produces the next operation state, requested durable work,
 * and a bounded decision reason. The application layer loads authority,
 * invokes the function, and commits its decision; PostgreSQL enforces
 * revisions and transition invariants. No provider call runs inside a
 * transition transaction. The policy is one versioned document consumed
 * by name and digest; a caller cannot select or relax values.
 */

export type HnsRootImportPhaseV1 =
  | "preparing"
  | "awaiting_publication"
  | "checking_publication"
  | "waiting_safe_commitment"
  | "checking_authority"
  | "ready"
  | "activated"
  | "recovery_required";

export type HnsRootImportTerminalPhaseV1 = "failed";

export type HnsRootImportEventNameV1 =
  | "preparation_completed"
  | "publication_acknowledged"
  | "current_observation"
  | "safe_observation"
  | "readiness_observed"
  | "provider_failure"
  | "deadline_reached"
  | "activation_requested"
  | "reorg_detected"
  | "superseded"
  | "recovery_decided";

export type HnsRootImportDeadlineKindV1 = "publication" | "finality";

export type HnsRootImportReorgInvalidationV1 =
  | "current_inclusion_invalid"
  | "safe_commitment_invalid"
  | "neither_invalid";

export const HNS_ROOT_IMPORT_POLICY_V1 = {
  name: "hns_root_import_policy_v1",
  /** Frozen: publication window from plan_exposed_at. */
  publication_window_seconds: 1_209_600,
  /** Frozen: finality window anchored once at first_current_observation_at. */
  finality_window_seconds: 86_400,
  /** Frozen: readiness evidence age bound at activation decision time. */
  readiness_freshness_seconds: 1_800,
  /** Frozen: operational backoff, full jitter applied by the scheduler. */
  operational_backoff: {
    base_seconds: 60,
    factor: 2,
    ceiling_seconds: 1_800,
  },
  /** Frozen: consecutive operational errors before the budget is exhausted. */
  operational_failure_budget: 8,
  /** Frozen: observation cadence in checking phases. */
  observation_cadence_seconds: 900,
  /** Frozen: retention review after a terminal decision. */
  retention_review: {
    first_seconds: 604_800,
    recurring_seconds: 2_592_000,
  },
} as const;

export type HnsRootImportPolicyV1 = typeof HNS_ROOT_IMPORT_POLICY_V1;

export type HnsRootImportLifecycleStateV1 = Readonly<{
  readonly phase: HnsRootImportPhaseV1 | HnsRootImportTerminalPhaseV1;
  readonly revision: number;
  readonly generation: number;
  readonly plan_exposed_at_epoch_ms: number | null;
  readonly publication_deadline_at_epoch_ms: number | null;
  readonly first_current_observation_at_epoch_ms: number | null;
  readonly finality_deadline_at_epoch_ms: number | null;
  readonly readiness_observed_at_epoch_ms: number | null;
  readonly pending_reason: string | null;
  readonly next_check_at_epoch_ms: number | null;
  readonly observation_count: number;
  readonly consecutive_operational_failures: number;
  readonly last_useful_error: string | null;
  readonly last_useful_error_at_epoch_ms: number | null;
  /** Event identities already applied; replays change nothing. */
  readonly applied_event_ids: ReadonlySet<string>;
  readonly terminal_decided_at_epoch_ms: number | null;
}>;

export type HnsRootImportLifecycleEventV1 = Readonly<
  {
    readonly event_id: string;
    readonly occurred_at_epoch_ms: number;
  } & (
    | { readonly event: "preparation_completed" }
    | { readonly event: "publication_acknowledged" }
    | {
        readonly event: "current_observation";
        /** True when the digest equals the exposed plan's encoded digest. */
        readonly qualifying: boolean;
        /** Normal current/safe mismatch finding during finality waiting. */
        readonly mismatch: boolean;
        readonly resource_sha256: string | null;
      }
    | {
        readonly event: "safe_observation";
        readonly qualifying: boolean;
        /** The bracketed read timestamp for safe-before-current arrival. */
        readonly bracket_observed_at_epoch_ms: number;
      }
    | { readonly event: "readiness_observed" }
    | {
        readonly event: "provider_failure";
        readonly classification: string;
        /** Finality current/safe mismatch is exempt from the budget. */
        readonly budget_exempt: boolean;
      }
    | { readonly event: "deadline_reached"; readonly deadline: HnsRootImportDeadlineKindV1 }
    | { readonly event: "activation_requested" }
    | { readonly event: "reorg_detected"; readonly invalidated: HnsRootImportReorgInvalidationV1 }
    | { readonly event: "superseded" }
    | {
        readonly event: "recovery_decided";
        readonly target:
          | "checking_publication"
          | "waiting_safe_commitment"
          | "checking_authority"
          | "ready"
          | "failed";
      }
  )
>;

export type HnsRootImportRequestedWorkV1 = Readonly<{
  readonly kind:
    | "observe_current"
    | "observe_safe"
    | "observe_readiness"
    | "reconcile_provider"
    | "retention_review";
  readonly due_at_epoch_ms: number;
}>;

export type HnsRootImportDecisionOutcomeV1 =
  | { readonly kind: "transition"; readonly reason: string }
  | { readonly kind: "replay"; readonly reason: string }
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "rejection"; readonly reason: string };

export type HnsRootImportLifecycleDecisionV1 = Readonly<{
  readonly outcome: HnsRootImportDecisionOutcomeV1;
  readonly next_state: HnsRootImportLifecycleStateV1 | null;
  readonly requested_work: readonly HnsRootImportRequestedWorkV1[];
}>;

export function hnsRootImportPolicyDigestV1(): string {
  const encoder = new TextEncoder();
  const canonical = JSON.stringify(
    HNS_ROOT_IMPORT_POLICY_V1,
    Object.keys(HNS_ROOT_IMPORT_POLICY_V1).sort(),
  );
  const bytes = encoder.encode(canonical);
  // Synchronous FNV-1a over the canonical policy document: the digest only
  // pins the versioned values by identity; cryptographic strength is not
  // required because the policy object is frozen at compile time.
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${HNS_ROOT_IMPORT_POLICY_V1.name}:${hash.toString(16).padStart(8, "0")}`;
}

export function initialHnsRootImportLifecycleStateV1(
  generation: number,
): HnsRootImportLifecycleStateV1 {
  return {
    phase: "preparing",
    revision: 1,
    generation,
    plan_exposed_at_epoch_ms: null,
    publication_deadline_at_epoch_ms: null,
    first_current_observation_at_epoch_ms: null,
    finality_deadline_at_epoch_ms: null,
    readiness_observed_at_epoch_ms: null,
    pending_reason: "preparing_retained_authority",
    next_check_at_epoch_ms: null,
    observation_count: 0,
    consecutive_operational_failures: 0,
    last_useful_error: null,
    last_useful_error_at_epoch_ms: null,
    applied_event_ids: new Set<string>(),
    terminal_decided_at_epoch_ms: null,
  };
}

function backoffSeconds(consecutiveFailures: number, policy: HnsRootImportPolicyV1): number {
  const baseSeconds: number = policy.operational_backoff.base_seconds;
  const factor: number = policy.operational_backoff.factor;
  const ceilingSeconds: number = policy.operational_backoff.ceiling_seconds;
  let delay = baseSeconds;
  for (let index = 1; index < consecutiveFailures; index += 1) {
    delay = Math.min(delay * factor, ceilingSeconds);
  }
  return Math.min(delay, ceilingSeconds);
}

function withState(
  state: HnsRootImportLifecycleStateV1,
  patch: Partial<HnsRootImportLifecycleStateV1>,
  reason: string,
  requestedWork: readonly HnsRootImportRequestedWorkV1[],
): HnsRootImportLifecycleDecisionV1 {
  return {
    outcome: { kind: "transition", reason },
    next_state: {
      ...state,
      ...patch,
      revision: state.revision + 1,
      applied_event_ids: state.applied_event_ids,
    },
    requested_work: requestedWork,
  };
}

function replay(reason: string): HnsRootImportLifecycleDecisionV1 {
  return { outcome: { kind: "replay", reason }, next_state: null, requested_work: [] };
}

function pending(
  state: HnsRootImportLifecycleStateV1,
  reason: string,
  nextCheckEpochMs: number | null,
  requestedWork: readonly HnsRootImportRequestedWorkV1[] = [],
): HnsRootImportLifecycleDecisionV1 {
  return {
    outcome: { kind: "pending", reason },
    next_state: {
      ...state,
      revision: state.revision + 1,
      pending_reason: reason,
      next_check_at_epoch_ms: nextCheckEpochMs,
    },
    requested_work: requestedWork,
  };
}

function rejection(reason: string): HnsRootImportLifecycleDecisionV1 {
  return { outcome: { kind: "rejection", reason }, next_state: null, requested_work: [] };
}

function qualifyingCurrentTransition(
  state: HnsRootImportLifecycleStateV1,
  event: HnsRootImportLifecycleEventV1 & { event: "current_observation" },
  policy: HnsRootImportPolicyV1,
): HnsRootImportLifecycleDecisionV1 {
  const observedAt = event.occurred_at_epoch_ms;
  // The anchor is persisted exactly once and never reset.
  const anchor =
    state.first_current_observation_at_epoch_ms === null
      ? observedAt
      : state.first_current_observation_at_epoch_ms;
  const finalityDeadline =
    state.finality_deadline_at_epoch_ms === null
      ? anchor + policy.finality_window_seconds * 1_000
      : state.finality_deadline_at_epoch_ms;
  const fromAcknowledgedCeremony = state.phase === "awaiting_publication";
  return withState(
    state,
    {
      phase: "waiting_safe_commitment",
      // Observation implies publication: the window closes at the
      // observation's persisted timestamp; a missing acknowledgement is
      // recorded as implied.
      publication_deadline_at_epoch_ms:
        state.publication_deadline_at_epoch_ms ??
        observedAt + policy.publication_window_seconds * 1_000,
      first_current_observation_at_epoch_ms: anchor,
      finality_deadline_at_epoch_ms: finalityDeadline,
      pending_reason: null,
      next_check_at_epoch_ms: observedAt + policy.observation_cadence_seconds * 1_000,
      observation_count: state.observation_count + 1,
    },
    fromAcknowledgedCeremony
      ? "current_inclusion_implied_publication"
      : "current_inclusion_confirmed",
    [
      {
        kind: "observe_safe",
        due_at_epoch_ms: observedAt + policy.observation_cadence_seconds * 1_000,
      },
    ],
  );
}

/**
 * Applies one lifecycle event to an operation state under the frozen
 * policy. Every event/phase pair resolves to exactly one of: a transition,
 * an idempotent replay (recorded in history, no state change), an
 * unchanged pending hold (typed classification recorded, next check
 * scheduled), or a typed rejection with a bounded reason.
 */
export function decideHnsRootImportLifecycleV1(
  state: HnsRootImportLifecycleStateV1,
  event: HnsRootImportLifecycleEventV1,
  policy: HnsRootImportPolicyV1 = HNS_ROOT_IMPORT_POLICY_V1,
  nowEpochMs: number = event.occurred_at_epoch_ms,
): HnsRootImportLifecycleDecisionV1 {
  if (state.phase === "failed") {
    // Terminal decisions allow no further transitions.
    return replay("terminal_failed");
  }
  if (event.event_id.length === 0) {
    return rejection("event_identity_missing");
  }
  if (state.applied_event_ids.has(event.event_id)) {
    return replay("event_identity_replayed");
  }
  const cadenceMs = policy.observation_cadence_seconds * 1_000;
  switch (event.event) {
    case "preparation_completed": {
      if (state.phase === "preparing") {
        return withState(
          state,
          {
            phase: "awaiting_publication",
            plan_exposed_at_epoch_ms: event.occurred_at_epoch_ms,
            publication_deadline_at_epoch_ms:
              event.occurred_at_epoch_ms + policy.publication_window_seconds * 1_000,
            pending_reason: null,
            next_check_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
          },
          "plan_exposed",
          [],
        );
      }
      if (state.phase === "activated") return pending(state, "activated_root", null);
      if (state.phase === "ready" || state.phase === "recovery_required") {
        return pending(state, "preparation_evidence_out_of_phase", null);
      }
      return replay("preparation_already_completed");
    }
    case "publication_acknowledged": {
      if (state.phase === "awaiting_publication") {
        return withState(state, { phase: "checking_publication" }, "acknowledged", []);
      }
      if (state.phase === "recovery_required") return pending(state, "recovery_hold", null);
      return replay("acknowledgement_replay");
    }
    case "current_observation": {
      if (state.phase === "preparing") return rejection("observation_before_plan");
      if (state.phase === "recovery_required") {
        // An observation arriving after a committed deadline is recovery
        // evidence, never a deadline reset.
        return pending(
          state,
          event.qualifying
            ? "late_inclusion_recovery_evidence"
            : "late_observation_recovery_evidence",
          null,
        );
      }
      if (state.phase === "activated") return replay("activated_renewal_evidence");
      if (!event.qualifying) {
        // Only resource findings are findings about the name; unavailable
        // evidence never reaches this event.
        if (state.phase === "checking_authority" || state.phase === "ready") {
          // Spec 012, "Conflicting current authority" (2026-09-09 amendment).
          // Only a confirmed finding about the name reaches this event;
          // unavailable evidence of every class arrives as `provider_failure`
          // and preserves both the phase and the readiness evidence. An outage
          // is not proof that control changed.
          // The chain no longer carries the resource this operation was made
          // ready against. Holding as pending would leave the phase at `ready`
          // with its readiness evidence intact, and a request arriving next
          // would activate — publishing app and handle authority for a name
          // whose current control has changed. The readiness evidence is
          // invalidated and the operation re-enters authority checking.
          return withState(
            state,
            {
              // `checking_publication`, not `checking_authority`: the current
              // chain no longer carries our resource, so publication evidence
              // is what must be re-established. It is also a transition the
              // ratified table permits from both phases.
              phase: "checking_publication",
              readiness_observed_at_epoch_ms: null,
              pending_reason: event.mismatch
                ? "current_authority_conflict"
                : "current_authority_absent",
            },
            event.mismatch ? "current_authority_conflict" : "current_authority_absent",
            [{ kind: "observe_current", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs }],
          );
        }
        return pending(
          state,
          event.mismatch ? "resource_mismatch_hold" : "resource_absent_hold",
          event.occurred_at_epoch_ms + cadenceMs,
          [
            {
              kind: "observe_current",
              due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
            },
          ],
        );
      }
      if (state.phase === "awaiting_publication" || state.phase === "checking_publication") {
        return qualifyingCurrentTransition(state, event, policy);
      }
      return replay("current_inclusion_already_retained");
    }
    case "safe_observation": {
      if (state.phase === "preparing" || state.phase === "awaiting_publication") {
        return rejection("safe_observation_without_current_evidence");
      }
      if (state.phase === "recovery_required") return pending(state, "recovery_hold", null);
      if (state.phase === "activated") return replay("activated_renewal_evidence");
      if (!event.qualifying) {
        return pending(
          state,
          "safe_resource_mismatch_hold",
          event.occurred_at_epoch_ms + cadenceMs,
          [
            {
              kind: "observe_safe",
              due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
            },
          ],
        );
      }
      if (state.phase === "checking_publication") {
        // Safe-before-current arrival: backfill the current-view anchor
        // from the same bracketed read set, never from wall clock.
        const anchor =
          state.first_current_observation_at_epoch_ms ?? event.bracket_observed_at_epoch_ms;
        return withState(
          state,
          {
            phase: "checking_authority",
            first_current_observation_at_epoch_ms: anchor,
            finality_deadline_at_epoch_ms:
              state.finality_deadline_at_epoch_ms ??
              anchor + policy.finality_window_seconds * 1_000,
            pending_reason: null,
            next_check_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
            observation_count: state.observation_count + 1,
          },
          "safe_commitment_backfilled_current_anchor",
          [
            {
              kind: "observe_readiness",
              due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
            },
          ],
        );
      }
      if (state.phase === "waiting_safe_commitment") {
        return withState(
          state,
          {
            phase: "checking_authority",
            pending_reason: null,
            next_check_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
            observation_count: state.observation_count + 1,
          },
          "safe_commitment_established",
          [
            {
              kind: "observe_readiness",
              due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
            },
          ],
        );
      }
      return replay("safe_commitment_already_retained");
    }
    case "readiness_observed": {
      if (state.phase === "checking_authority") {
        return withState(
          state,
          {
            phase: "ready",
            readiness_observed_at_epoch_ms: event.occurred_at_epoch_ms,
            pending_reason: null,
            next_check_at_epoch_ms:
              event.occurred_at_epoch_ms + policy.readiness_freshness_seconds * 1_000,
          },
          "readiness_retained",
          [],
        );
      }
      if (state.phase === "ready" || state.phase === "activated") {
        return replay("readiness_already_retained");
      }
      return pending(state, "readiness_evidence_out_of_phase", null);
    }
    case "provider_failure": {
      // A typed provider failure preserves the phase and records the next
      // operational check. Normal current/safe mismatch during finality
      // waiting consumes no budget.
      const failures = event.budget_exempt
        ? state.consecutive_operational_failures
        : state.consecutive_operational_failures + 1;
      const exhausted = failures >= policy.operational_failure_budget;
      const delaySeconds = backoffSeconds(failures, policy);
      const dueAt = event.occurred_at_epoch_ms + delaySeconds * 1_000;
      const held = pending(
        state,
        exhausted
          ? `operational_failure_budget_exhausted:${event.classification}`
          : `provider_failure:${event.classification}`,
        dueAt,
        [{ kind: "reconcile_provider", due_at_epoch_ms: dueAt }],
      );
      if (held.next_state === null) return held;
      return {
        ...held,
        next_state: {
          ...held.next_state,
          consecutive_operational_failures: failures,
          // The last useful error and its time are retained alongside any
          // exhausted-budget reason.
          last_useful_error: event.classification,
          last_useful_error_at_epoch_ms: event.occurred_at_epoch_ms,
        },
      };
    }
    case "deadline_reached": {
      if (state.phase === "recovery_required") return replay("deadline_already_committed");
      if (event.deadline === "publication") {
        if (state.phase === "awaiting_publication" || state.phase === "checking_publication") {
          return withState(
            state,
            { phase: "recovery_required", pending_reason: "publication_deadline_reached" },
            "publication_deadline_recovery_authority_retained",
            [],
          );
        }
        return rejection("no_active_window");
      }
      if (state.phase === "waiting_safe_commitment") {
        return withState(
          state,
          { phase: "recovery_required", pending_reason: "finality_deadline_reached" },
          "finality_deadline_recovery_authority_retained",
          [],
        );
      }
      return rejection("no_active_window");
    }
    case "activation_requested": {
      if (state.phase === "ready") {
        const readinessAgeMs = nowEpochMs - (state.readiness_observed_at_epoch_ms ?? 0);
        if (
          state.readiness_observed_at_epoch_ms === null ||
          readinessAgeMs > policy.readiness_freshness_seconds * 1_000
        ) {
          // Stale evidence re-enters checking_authority observation.
          return pending(state, "readiness_evidence_stale", nowEpochMs + cadenceMs, [
            { kind: "observe_readiness", due_at_epoch_ms: nowEpochMs + cadenceMs },
          ]);
        }
        return withState(state, { phase: "activated", pending_reason: null }, "activated", [
          // The initial review of an operation's authority follows the policy's
          // first-review cadence, the same one a terminal decision uses. There
          // is one initial cadence in the system, not one per scheduling site.
          {
            kind: "retention_review",
            due_at_epoch_ms: nowEpochMs + policy.retention_review.first_seconds * 1_000,
          },
        ]);
      }
      if (state.phase === "activated") return replay("activation_replayed");
      return rejection("activation_not_permitted_in_phase");
    }
    case "reorg_detected": {
      if (state.phase === "checking_publication") {
        if (event.invalidated === "current_inclusion_invalid") {
          return withState(
            state,
            { phase: "checking_publication", pending_reason: "reorg_rechecking_publication" },
            "reorg_current_inclusion_invalid",
            [{ kind: "observe_current", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs }],
          );
        }
        return pending(state, "reorg_recheck_scheduled", event.occurred_at_epoch_ms + cadenceMs, [
          { kind: "observe_current", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs },
        ]);
      }
      if (state.phase === "waiting_safe_commitment") {
        if (event.invalidated === "current_inclusion_invalid") {
          // Timing history and deadlines are retained; never reset by reorg.
          return withState(
            state,
            { phase: "checking_publication", pending_reason: "reorg_current_inclusion_invalid" },
            "reorg_current_inclusion_invalid",
            [{ kind: "observe_current", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs }],
          );
        }
        return pending(state, "reorg_recheck_scheduled", event.occurred_at_epoch_ms + cadenceMs, [
          { kind: "observe_safe", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs },
        ]);
      }
      if (state.phase === "checking_authority" || state.phase === "ready") {
        if (event.invalidated === "current_inclusion_invalid") {
          return withState(
            state,
            { phase: "checking_publication", pending_reason: "reorg_current_inclusion_invalid" },
            "reorg_current_inclusion_invalid",
            [{ kind: "observe_current", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs }],
          );
        }
        if (event.invalidated === "safe_commitment_invalid") {
          return withState(
            state,
            { phase: "waiting_safe_commitment", pending_reason: "reorg_safe_commitment_invalid" },
            "reorg_safe_commitment_invalid",
            [{ kind: "observe_safe", due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs }],
          );
        }
        return pending(state, "reorg_recheck_scheduled", event.occurred_at_epoch_ms + cadenceMs);
      }
      return pending(state, "reorg_recheck_scheduled", event.occurred_at_epoch_ms + cadenceMs);
    }
    case "superseded": {
      if (state.phase === "activated")
        return pending(state, "activated_diagnostic_superseded", null);
      if (state.phase === "recovery_required") return replay("superseded_already_committed");
      return withState(
        state,
        { phase: "recovery_required", pending_reason: "superseded" },
        "superseded_recovery_authority_retained",
        [],
      );
    }
    case "recovery_decided": {
      if (state.phase !== "recovery_required") return rejection("recovery_decision_out_of_phase");
      if (event.target === "failed") {
        return withState(
          state,
          {
            phase: "failed",
            pending_reason: null,
            terminal_decided_at_epoch_ms: event.occurred_at_epoch_ms,
          },
          "terminal_failed_retention_review_scheduled",
          [
            {
              kind: "retention_review",
              due_at_epoch_ms:
                event.occurred_at_epoch_ms + policy.retention_review.first_seconds * 1_000,
            },
          ],
        );
      }
      return withState(
        state,
        { phase: event.target, pending_reason: null },
        "recovery_resumed_with_fresh_evidence",
        [
          {
            kind:
              event.target === "checking_publication"
                ? "observe_current"
                : event.target === "waiting_safe_commitment"
                  ? "observe_safe"
                  : "observe_readiness",
            due_at_epoch_ms: event.occurred_at_epoch_ms + cadenceMs,
          },
        ],
      );
    }
  }
}

/**
 * Within one decision batch a qualifying observation is evaluated before a
 * deadline; inclusion observed exactly at the deadline boundary belongs to
 * the observation-first rule because the observation's persisted timestamp
 * precedes the deadline's committed transition.
 */
export function decideHnsRootImportLifecycleBatchV1(
  state: HnsRootImportLifecycleStateV1,
  events: readonly HnsRootImportLifecycleEventV1[],
  policy: HnsRootImportPolicyV1 = HNS_ROOT_IMPORT_POLICY_V1,
  nowEpochMs: number = Date.now(),
): HnsRootImportLifecycleDecisionV1[] {
  const isQualifyingObservation = (event: HnsRootImportLifecycleEventV1): boolean =>
    (event.event === "current_observation" || event.event === "safe_observation") &&
    (event as { readonly qualifying?: boolean }).qualifying === true;
  const ordered = [...events].sort((left, right) => {
    const leftObservation = isQualifyingObservation(left) ? 0 : 1;
    const rightObservation = isQualifyingObservation(right) ? 0 : 1;
    if (leftObservation !== rightObservation) return leftObservation - rightObservation;
    return left.occurred_at_epoch_ms - right.occurred_at_epoch_ms;
  });
  const decisions: HnsRootImportLifecycleDecisionV1[] = [];
  let current: HnsRootImportLifecycleStateV1 | null = state;
  for (const event of ordered) {
    const decision = decideHnsRootImportLifecycleV1(current, event, policy, nowEpochMs);
    if (current === null) break;
    if (decision.next_state !== null) {
      current = {
        ...decision.next_state,
        applied_event_ids: new Set([...decision.next_state.applied_event_ids, event.event_id]),
      };
    } else {
      current = {
        ...current,
        applied_event_ids: new Set([...current.applied_event_ids, event.event_id]),
      };
    }
    decisions.push(decision);
  }
  return decisions;
}
