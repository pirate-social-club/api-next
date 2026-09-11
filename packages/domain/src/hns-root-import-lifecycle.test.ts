import { describe, expect, test } from "bun:test";
import {
  decideHnsRootImportLifecycleBatchV1,
  decideHnsRootImportLifecycleV1,
  HNS_ROOT_IMPORT_POLICY_V1,
  type HnsRootImportLifecycleEventV1,
  type HnsRootImportLifecycleStateV1,
  type HnsRootImportPhaseV1,
  hnsRootImportPolicyDigestV1,
  initialHnsRootImportLifecycleStateV1,
} from "./hns-root-import-lifecycle.ts";

const SECOND = 1_000;
const now = Date.parse("2026-09-09T12:00:00Z");

function state(
  phase: HnsRootImportPhaseV1,
  patch: Partial<HnsRootImportLifecycleStateV1> = {},
): HnsRootImportLifecycleStateV1 {
  return { ...initialHnsRootImportLifecycleStateV1(1), phase, ...patch };
}

function exposedState(
  phase: HnsRootImportPhaseV1,
  patch: Partial<HnsRootImportLifecycleStateV1> = {},
): HnsRootImportLifecycleStateV1 {
  const planExposedAt = now - 3_600 * SECOND;
  return {
    ...state(phase, {
      plan_exposed_at_epoch_ms: planExposedAt,
      publication_deadline_at_epoch_ms:
        planExposedAt + HNS_ROOT_IMPORT_POLICY_V1.publication_window_seconds * SECOND,
      ...patch,
    }),
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let eventIdCounter = 0;
function event(
  body: DistributiveOmit<HnsRootImportLifecycleEventV1, "event_id" | "occurred_at_epoch_ms"> & {
    readonly occurred_at_epoch_ms?: number;
  },
): HnsRootImportLifecycleEventV1 {
  eventIdCounter += 1;
  return {
    event_id: `event-${eventIdCounter}`,
    occurred_at_epoch_ms: body.occurred_at_epoch_ms ?? now,
    ...body,
  } as HnsRootImportLifecycleEventV1;
}

function qualifyingCurrent(at = now) {
  return event({
    event: "current_observation",
    qualifying: true,
    mismatch: false,
    resource_sha256: "a".repeat(64),
    occurred_at_epoch_ms: at,
  });
}

function qualifyingSafe(at = now, bracketAt = at) {
  return event({
    event: "safe_observation",
    qualifying: true,
    bracket_observed_at_epoch_ms: bracketAt,
    occurred_at_epoch_ms: at,
  });
}

describe("HNS root-import lifecycle transition policy", () => {
  test("pins the versioned frozen policy values exactly", () => {
    expect(HNS_ROOT_IMPORT_POLICY_V1.publication_window_seconds).toBe(1_209_600);
    expect(HNS_ROOT_IMPORT_POLICY_V1.finality_window_seconds).toBe(86_400);
    expect(HNS_ROOT_IMPORT_POLICY_V1.readiness_freshness_seconds).toBe(1_800);
    expect(HNS_ROOT_IMPORT_POLICY_V1.operational_backoff).toEqual({
      base_seconds: 60,
      factor: 2,
      ceiling_seconds: 1_800,
    });
    expect(HNS_ROOT_IMPORT_POLICY_V1.operational_failure_budget).toBe(8);
    expect(HNS_ROOT_IMPORT_POLICY_V1.observation_cadence_seconds).toBe(900);
    expect(HNS_ROOT_IMPORT_POLICY_V1.retention_review).toEqual({
      first_seconds: 604_800,
      recurring_seconds: 2_592_000,
    });
    expect(hnsRootImportPolicyDigestV1()).toMatch(/^hns_root_import_policy_v1:[0-9a-f]{8}$/u);
  });

  test("complete transition table: every event/phase pair resolves exactly once", () => {
    const events: readonly (readonly [string, () => HnsRootImportLifecycleEventV1])[] = [
      ["preparation_completed", () => event({ event: "preparation_completed" })],
      ["publication_acknowledged", () => event({ event: "publication_acknowledged" })],
      ["current_observation", qualifyingCurrent],
      ["safe_observation", () => qualifyingSafe()],
      ["readiness_observed", () => event({ event: "readiness_observed" })],
      [
        "provider_failure",
        () =>
          event({
            event: "provider_failure",
            classification: "transport_failure",
            budget_exempt: false,
          }),
      ],
      [
        "deadline_reached(publication)",
        () => event({ event: "deadline_reached", deadline: "publication" }),
      ],
      [
        "deadline_reached(finality)",
        () => event({ event: "deadline_reached", deadline: "finality" }),
      ],
      ["activation_requested", () => event({ event: "activation_requested" })],
      ["reorg_detected", () => event({ event: "reorg_detected", invalidated: "neither_invalid" })],
      ["superseded", () => event({ event: "superseded" })],
      [
        "recovery_decided",
        () => event({ event: "recovery_decided", target: "checking_publication" }),
      ],
    ];
    const phases: readonly HnsRootImportPhaseV1[] = [
      "preparing",
      "awaiting_publication",
      "checking_publication",
      "waiting_safe_commitment",
      "checking_authority",
      "ready",
      "activated",
      "recovery_required",
    ];
    // Expected resolution per event/phase: T=transition, R=replay,
    // P=pending, X=rejection. Derived line-by-line from the spec table.
    const expected: Record<string, string> = {
      preparing: "T X X X P P X X X P T X",
      awaiting_publication: "R T T X P P T X X P T X",
      checking_publication: "R R T T P P T X X P T X",
      waiting_safe_commitment: "R R R T P P X T X P T X",
      checking_authority: "R R R R T P X X X P T X",
      ready: "P R R R T P X X T P T X",
      activated: "P R R R R P X X R P P X",
      recovery_required: "P P P P P P R R X P R T",
    };
    for (const phase of phases) {
      const resolutions = expected[phase]?.split(" ") ?? [];
      for (let index = 0; index < events.length; index += 1) {
        const [name, make] = events[index] ?? ["", () => event({ event: "superseded" })];
        const base =
          phase === "preparing"
            ? state(phase)
            : exposedState(
                phase,
                phase === "ready" ? { readiness_observed_at_epoch_ms: now - 60 * SECOND } : {},
              );
        const decision = decideHnsRootImportLifecycleV1(base, make());
        const letter = resolutions[index];
        if (letter === undefined) throw new Error(`missing expectation ${phase}/${name}`);
        expect(
          `${decision.outcome.kind[0]?.toUpperCase()}${decision.outcome.kind.slice(1, 3)}`,
          `${name} in ${phase}`,
        ).toBe(letter === "T" ? "Tra" : letter === "R" ? "Rep" : letter === "P" ? "Pen" : "Rej");
      }
    }
  });

  test("acknowledgement before plan exposure is a typed rejection", () => {
    const decision = decideHnsRootImportLifecycleV1(
      state("preparing"),
      event({ event: "publication_acknowledged" }),
    );
    expect(decision.outcome).toEqual({
      kind: "rejection",
      reason: "acknowledgement_without_plan",
    });
    expect(decision.next_state).toBeNull();
    expect(decision.requested_work).toEqual([]);
  });

  test("preparation exposure starts the publication window and finality waits for inclusion", () => {
    const decision = decideHnsRootImportLifecycleV1(
      state("preparing"),
      event({ event: "preparation_completed" }),
    );
    expect(decision.outcome.kind).toBe("transition");
    const next = decision.next_state;
    expect(next?.phase).toBe("awaiting_publication");
    expect(next?.plan_exposed_at_epoch_ms).toBe(now);
    expect(next?.publication_deadline_at_epoch_ms).toBe(now + 1_209_600 * SECOND);
    expect(next?.first_current_observation_at_epoch_ms).toBeNull();
  });

  test("a qualifying current observation in awaiting_publication implies publication and anchors finality once", () => {
    const inclusionAt = now + 2 * 86_400 * SECOND;
    const decision = decideHnsRootImportLifecycleV1(
      exposedState("awaiting_publication"),
      qualifyingCurrent(inclusionAt),
    );
    expect(decision.outcome).toEqual({
      kind: "transition",
      reason: "current_inclusion_implied_publication",
    });
    const next = decision.next_state;
    expect(next?.phase).toBe("waiting_safe_commitment");
    expect(next?.first_current_observation_at_epoch_ms).toBe(inclusionAt);
    expect(next?.finality_deadline_at_epoch_ms).toBe(inclusionAt + 86_400 * SECOND);
    expect(decision.requested_work).toEqual([
      { kind: "observe_safe", due_at_epoch_ms: inclusionAt + 900 * SECOND },
    ]);

    // The anchor is persisted exactly once: a second qualifying observation
    // replays and never moves the deadline.
    const replay = decideHnsRootImportLifecycleV1(
      next ?? exposedState("waiting_safe_commitment"),
      qualifyingCurrent(inclusionAt + 3_600 * SECOND),
    );
    expect(replay.outcome.kind).toBe("replay");
  });

  test("event identity replays change nothing and are recorded in history", () => {
    const acknowledged = event({ event: "publication_acknowledged" });
    const first = decideHnsRootImportLifecycleV1(
      exposedState("awaiting_publication"),
      acknowledged,
    );
    expect(first.outcome.kind).toBe("transition");
    const withApplied = {
      ...(first.next_state ?? exposedState("checking_publication")),
      applied_event_ids: new Set([acknowledged.event_id]),
    };
    const replay = decideHnsRootImportLifecycleV1(withApplied, acknowledged);
    expect(replay.outcome.kind).toBe("replay");
    expect(replay.next_state).toBeNull();
  });

  test("stale events replay without state change", () => {
    // A preparation completion arriving after publication checking started.
    const decision = decideHnsRootImportLifecycleV1(
      exposedState("checking_publication"),
      event({ event: "preparation_completed" }),
    );
    expect(decision.outcome).toEqual({ kind: "replay", reason: "preparation_already_completed" });
  });

  test("safe-before-current arrival advances to checking_authority and backfills the anchor from the bracket", () => {
    const bracketAt = now + 400 * SECOND;
    const decision = decideHnsRootImportLifecycleV1(
      exposedState("checking_publication"),
      qualifyingSafe(now + 500 * SECOND, bracketAt),
    );
    expect(decision.outcome).toEqual({
      kind: "transition",
      reason: "safe_commitment_backfilled_current_anchor",
    });
    const next = decision.next_state;
    expect(next?.phase).toBe("checking_authority");
    expect(next?.first_current_observation_at_epoch_ms).toBe(bracketAt);
    expect(next?.finality_deadline_at_epoch_ms).toBe(bracketAt + 86_400 * SECOND);
  });

  test("deadline kinds: publication and finality windows, no active window elsewhere", () => {
    const publication = decideHnsRootImportLifecycleV1(
      exposedState("awaiting_publication"),
      event({ event: "deadline_reached", deadline: "publication" }),
    );
    expect(publication.next_state?.phase).toBe("recovery_required");
    expect(publication.next_state?.pending_reason).toBe("publication_deadline_reached");

    const waiting = exposedState("waiting_safe_commitment", {
      first_current_observation_at_epoch_ms: now - 86_400 * SECOND,
      finality_deadline_at_epoch_ms: now,
    });
    const finality = decideHnsRootImportLifecycleV1(
      waiting,
      event({ event: "deadline_reached", deadline: "finality" }),
    );
    expect(finality.next_state?.phase).toBe("recovery_required");
    expect(finality.next_state?.pending_reason).toBe("finality_deadline_reached");

    for (const phase of ["preparing", "checking_authority", "ready", "activated"] as const) {
      for (const deadline of ["publication", "finality"] as const) {
        const decision = decideHnsRootImportLifecycleV1(
          phase === "preparing" ? state(phase) : exposedState(phase),
          event({ event: "deadline_reached", deadline }),
        );
        expect(decision.outcome).toEqual({ kind: "rejection", reason: "no_active_window" });
      }
    }
  });

  test("deadline-and-observation precedence: a qualifying observation is evaluated before a deadline", () => {
    const inclusionAt = now + 86_400 * SECOND;
    const decisions = decideHnsRootImportLifecycleBatchV1(exposedState("awaiting_publication"), [
      event({
        event: "deadline_reached",
        deadline: "publication",
        occurred_at_epoch_ms: inclusionAt + 1,
      }),
      qualifyingCurrent(inclusionAt),
    ]);
    expect(decisions[0]?.outcome.kind).toBe("transition");
    expect(decisions[0]?.next_state?.phase).toBe("waiting_safe_commitment");
    // The observation closed the publication window first, so the
    // publication deadline no longer has an active window and is a typed
    // rejection rather than recovery.
    expect(decisions[1]?.outcome).toEqual({ kind: "rejection", reason: "no_active_window" });
  });

  test("a deadline already committed is never reset by a late observation", () => {
    const recovered = decideHnsRootImportLifecycleV1(
      exposedState("recovery_required"),
      qualifyingCurrent(now + 100 * SECOND),
    );
    expect(recovered.outcome.kind).toBe("pending");
    expect(recovered.outcome.reason).toBe("late_inclusion_recovery_evidence");
    expect(recovered.next_state?.phase).toBe("recovery_required");
    expect(recovered.next_state?.first_current_observation_at_epoch_ms).toBeNull();
  });

  test("reorg fallback depth: only invalidated evidence moves the phase and never resets deadlines", () => {
    const deadlines = {
      plan_exposed_at_epoch_ms: now - 86_400 * SECOND,
      publication_deadline_at_epoch_ms: now + 100 * SECOND,
      first_current_observation_at_epoch_ms: now - 43_200 * SECOND,
      finality_deadline_at_epoch_ms: now + 43_200 * SECOND,
    };
    const fromWaiting = decideHnsRootImportLifecycleV1(
      exposedState("waiting_safe_commitment", deadlines),
      event({ event: "reorg_detected", invalidated: "current_inclusion_invalid" }),
    );
    expect(fromWaiting.next_state?.phase).toBe("checking_publication");
    expect(fromWaiting.next_state?.finality_deadline_at_epoch_ms).toBe(
      deadlines.finality_deadline_at_epoch_ms,
    );
    expect(fromWaiting.next_state?.first_current_observation_at_epoch_ms).toBe(
      deadlines.first_current_observation_at_epoch_ms,
    );

    const fromAuthority = decideHnsRootImportLifecycleV1(
      exposedState("checking_authority", deadlines),
      event({ event: "reorg_detected", invalidated: "safe_commitment_invalid" }),
    );
    expect(fromAuthority.next_state?.phase).toBe("waiting_safe_commitment");

    const fromReady = decideHnsRootImportLifecycleV1(
      exposedState("ready", deadlines),
      event({ event: "reorg_detected", invalidated: "neither_invalid" }),
    );
    expect(fromReady.outcome.kind).toBe("pending");
    expect(fromReady.next_state?.phase).toBe("ready");
  });

  test("provider failures preserve the phase, back off with the frozen curve, and exhaust the budget", () => {
    const current = exposedState("checking_publication");
    let decision = decideHnsRootImportLifecycleV1(
      current,
      event({
        event: "provider_failure",
        classification: "transport_failure",
        budget_exempt: false,
      }),
    );
    expect(decision.outcome.kind).toBe("pending");
    expect(decision.next_state?.phase).toBe("checking_publication");
    expect(decision.next_state?.consecutive_operational_failures).toBe(1);
    expect(decision.next_state?.next_check_at_epoch_ms).toBe(now + 60 * SECOND);

    for (let index = 2; index <= 8; index += 1) {
      const previous = decision.next_state ?? current;
      decision = decideHnsRootImportLifecycleV1(
        previous,
        event({
          event: "provider_failure",
          classification: "transport_failure",
          budget_exempt: false,
          occurred_at_epoch_ms: previous.next_check_at_epoch_ms ?? now,
        }),
      );
      expect(decision.next_state?.consecutive_operational_failures).toBe(index);
    }
    const exhausted = decision.next_state;
    expect(exhausted?.pending_reason).toBe(
      "operational_failure_budget_exhausted:transport_failure",
    );
    // The budget exhaustion records the retained last useful error and its
    // time without changing the phase.
    expect(exhausted?.phase).toBe("checking_publication");
    expect(exhausted?.last_useful_error).toBe("transport_failure");
    expect(exhausted?.last_useful_error_at_epoch_ms).not.toBeNull();
  });

  test("a normal current/safe mismatch during finality waiting consumes no budget", () => {
    const decision = decideHnsRootImportLifecycleV1(
      exposedState("waiting_safe_commitment", { consecutive_operational_failures: 3 }),
      event({
        event: "provider_failure",
        classification: "resource_mismatch",
        budget_exempt: true,
      }),
    );
    expect(decision.next_state?.consecutive_operational_failures).toBe(3);
    expect(decision.next_state?.pending_reason).toBe("provider_failure:resource_mismatch");
  });

  test("readiness freshness gates activation; stale evidence re-enters checking_authority", () => {
    const fresh = decideHnsRootImportLifecycleV1(
      exposedState("ready", { readiness_observed_at_epoch_ms: now - 1_000 * SECOND }),
      event({ event: "activation_requested" }),
      undefined,
      now,
    );
    expect(fresh.next_state?.phase).toBe("activated");

    const stale = decideHnsRootImportLifecycleV1(
      exposedState("ready", { readiness_observed_at_epoch_ms: now - 1_801 * SECOND }),
      event({ event: "activation_requested" }),
      undefined,
      now,
    );
    expect(stale.outcome.kind).toBe("pending");
    expect(stale.outcome.reason).toBe("readiness_evidence_stale");

    const unauthorized = decideHnsRootImportLifecycleV1(
      exposedState("awaiting_publication"),
      event({ event: "activation_requested" }),
    );
    expect(unauthorized.outcome).toEqual({
      kind: "rejection",
      reason: "activation_not_permitted_in_phase",
    });
  });

  test("a qualifying readiness refresh advances revision in place and leaves the anchors unchanged", () => {
    const anchors = {
      first_current_observation_at_epoch_ms: now - 3_600 * SECOND,
      finality_deadline_at_epoch_ms: now + 23 * 3_600 * SECOND,
    };
    const before = exposedState("ready", {
      ...anchors,
      readiness_observed_at_epoch_ms: now - 2_000 * SECOND,
      pending_reason: "readiness_evidence_stale",
      next_check_at_epoch_ms: now - 1_000 * SECOND,
    });
    const decision = decideHnsRootImportLifecycleV1(
      before,
      event({ event: "readiness_observed", occurred_at_epoch_ms: now }),
      undefined,
      now,
    );
    expect(decision.outcome).toEqual({ kind: "transition", reason: "readiness_refreshed" });
    expect(decision.next_state?.phase).toBe("ready");
    expect(decision.next_state?.revision).toBe(before.revision + 1);
    expect(decision.next_state?.readiness_observed_at_epoch_ms).toBe(now);
    expect(decision.next_state?.next_check_at_epoch_ms).toBe(
      now + HNS_ROOT_IMPORT_POLICY_V1.readiness_freshness_seconds * SECOND,
    );
    expect(decision.next_state?.pending_reason).toBeNull();
    // The refresh moves readiness evidence only: publication and finality
    // anchors are untouched.
    expect(decision.next_state?.first_current_observation_at_epoch_ms).toBe(
      anchors.first_current_observation_at_epoch_ms,
    );
    expect(decision.next_state?.finality_deadline_at_epoch_ms).toBe(
      anchors.finality_deadline_at_epoch_ms,
    );
    expect(decision.requested_work).toEqual([]);
  });

  test("a re-delivered readiness identity replays, and activated readiness replays", () => {
    const first = event({ event: "readiness_observed" });
    const alreadyApplied = exposedState("ready", {
      applied_event_ids: new Set([first.event_id]),
      readiness_observed_at_epoch_ms: now - 60 * SECOND,
    });
    const redelivered = decideHnsRootImportLifecycleV1(alreadyApplied, first, undefined, now);
    expect(redelivered.outcome.kind).toBe("replay");
    expect(redelivered.next_state).toBeNull();
    expect(redelivered.requested_work).toEqual([]);

    const activated = decideHnsRootImportLifecycleV1(
      exposedState("activated", { readiness_observed_at_epoch_ms: now - 60 * SECOND }),
      event({ event: "readiness_observed" }),
      undefined,
      now,
    );
    expect(activated.outcome).toEqual({ kind: "replay", reason: "readiness_already_retained" });
    expect(activated.next_state).toBeNull();
    expect(activated.requested_work).toEqual([]);
  });

  test("repeated stale activation requests schedule one readiness observation", () => {
    const stale = exposedState("ready", {
      readiness_observed_at_epoch_ms: now - 1_801 * SECOND,
    });
    const first = decideHnsRootImportLifecycleV1(
      stale,
      event({ event: "activation_requested" }),
      undefined,
      now,
    );
    expect(first.outcome).toEqual({ kind: "pending", reason: "readiness_evidence_stale" });
    expect(first.requested_work.map((work) => work.kind)).toEqual(["observe_readiness"]);
    const afterFirst = first.next_state;
    if (afterFirst === null) throw new Error("expected the stale pending hold");

    const second = decideHnsRootImportLifecycleV1(
      afterFirst,
      event({ event: "activation_requested" }),
      undefined,
      now + SECOND,
    );
    expect(second.outcome).toEqual({
      kind: "replay",
      reason: "readiness_refresh_already_pending",
    });
    expect(second.requested_work).toEqual([]);
    expect(second.next_state).toBeNull();
  });

  test("recovery exit moves to the evidenced phase or terminal failed with a retention review", () => {
    const resumed = decideHnsRootImportLifecycleV1(
      exposedState("recovery_required"),
      event({ event: "recovery_decided", target: "waiting_safe_commitment" }),
    );
    expect(resumed.next_state?.phase).toBe("waiting_safe_commitment");

    const terminal = decideHnsRootImportLifecycleV1(
      exposedState("recovery_required"),
      event({ event: "recovery_decided", target: "failed" }),
    );
    expect(terminal.next_state?.phase).toBe("failed");
    expect(terminal.next_state?.terminal_decided_at_epoch_ms).toBe(now);
    expect(terminal.requested_work).toEqual([
      { kind: "retention_review", due_at_epoch_ms: now + 604_800 * SECOND },
    ]);

    // Terminal decisions allow no further transitions.
    const after = decideHnsRootImportLifecycleV1(
      terminal.next_state ?? exposedState("recovery_required"),
      qualifyingCurrent(),
    );
    expect(after.outcome.kind).toBe("replay");
  });

  test("activated roots record renewal and diagnostic events without regressing serving state", () => {
    for (const lifecycleEvent of [
      qualifyingCurrent(),
      qualifyingSafe(),
      event({ event: "superseded" }),
      event({ event: "reorg_detected", invalidated: "current_inclusion_invalid" }),
    ]) {
      const decision = decideHnsRootImportLifecycleV1(exposedState("activated"), lifecycleEvent);
      expect(decision.next_state?.phase ?? "activated").toBe("activated");
    }
  });

  test("finite deadlines: windows are computed once and produce recovery, never teardown", () => {
    const exposed = decideHnsRootImportLifecycleV1(
      state("preparing"),
      event({ event: "preparation_completed" }),
    );
    const awaiting = exposed.next_state ?? state("awaiting_publication");
    const inclusionAt = awaiting.plan_exposed_at_epoch_ms! + 5 * 86_400 * SECOND;
    const included = decideHnsRootImportLifecycleV1(awaiting, qualifyingCurrent(inclusionAt));
    const waiting = included.next_state ?? awaiting;
    expect(waiting.finality_deadline_at_epoch_ms).toBe(inclusionAt + 86_400 * SECOND);
    // Restart-and-replay of the same observation never extends anything.
    const replayed = decideHnsRootImportLifecycleV1(
      { ...waiting, applied_event_ids: new Set<string>() },
      qualifyingCurrent(inclusionAt + 86_400 * SECOND),
    );
    expect(replayed.outcome.kind).toBe("replay");
    const deadlineAt = waiting.finality_deadline_at_epoch_ms ?? 0;
    const exhaustedWindow = decideHnsRootImportLifecycleV1(
      waiting,
      event({ event: "deadline_reached", deadline: "finality", occurred_at_epoch_ms: deadlineAt }),
    );
    expect(exhaustedWindow.next_state?.phase).toBe("recovery_required");
    // Authority retention, not teardown: no transition erases the anchor.
    expect(exhaustedWindow.next_state?.first_current_observation_at_epoch_ms).toBe(inclusionAt);
  });
});
