import { describe, expect, test } from "bun:test";
import {
  COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
  type CommunityPurchaseOperationId,
  type ReconciliationFailureClass,
} from "@pirate/domain";
import { Effect } from "effect";
import type { Alert } from "../ports.ts";
import {
  CommunityPurchaseFundingRejected,
  CommunityPurchaseFundingStorageFailed,
} from "./community-purchase-funding";
import type {
  CommunityPurchaseFundingObservationFailure,
  CommunityPurchaseFundingObservationResult,
  CommunityPurchaseFundingObservationUseCase,
} from "./community-purchase-funding-observation";
import { CommunityPurchaseFundingChainReadFailed } from "./community-purchase-funding-observation";
import type { CommunityPurchaseFundingQueryStore } from "./community-purchase-funding-query";
import {
  COMMUNITY_PURCHASE_RECONCILIATION_STUCK_ALERT_KEY,
  type CommunityPurchaseFundingAttemptState,
  type CommunityPurchaseFundingReconciliationAttemptStore,
  classifyObservationFailure,
  makeCommunityPurchaseFundingReconciler,
} from "./community-purchase-funding-reconciliation";

const OPERATION_A =
  "money:v1:community_purchase:community_1:quote_a:purchase_a:3" as CommunityPurchaseOperationId;
const OPERATION_B =
  "money:v1:community_purchase:community_1:quote_b:purchase_b:3" as CommunityPurchaseOperationId;
const HASH_A = `0x${"aa".repeat(32)}` as const;
const HASH_B = `0x${"bb".repeat(32)}` as const;

const TEST_POLICY = { ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF, escalationThreshold: 3 };

type ObservationOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: CommunityPurchaseFundingObservationFailure };

function makeHarness(
  outcomes: Readonly<Record<string, ObservationOutcome>>,
  onObserve?: (
    operationId: string,
    internals: { readonly attemptRows: Map<string, CommunityPurchaseFundingAttemptState> },
  ) => void,
) {
  const attemptRows = new Map<string, CommunityPurchaseFundingAttemptState>();
  const blockedReservations = new Set<string>();
  const recordedDelays: number[] = [];
  const alerts: Alert[] = [];
  const observed: string[] = [];

  const queryStore: CommunityPurchaseFundingQueryStore = {
    loadForActor: () => Effect.succeed(null),
    listReconcilable: () =>
      Effect.succeed([
        { operationId: OPERATION_A, transactionHash: HASH_A },
        { operationId: OPERATION_B, transactionHash: HASH_B },
      ]),
    parkedCounts: () => Effect.succeed([]),
  };

  const attempts: CommunityPurchaseFundingReconciliationAttemptStore = {
    recordAttemptStart: (input) =>
      Effect.sync(() => {
        if (blockedReservations.has(input.operationId)) {
          return { kind: "unavailable" } as const;
        }
        const prior = attemptRows.get(input.operationId);
        const base: CommunityPurchaseFundingAttemptState =
          prior ??
          ({
            operationId: input.operationId,
            generation: 0,
            lastAttemptAt: null,
            nextAttemptAt: null,
            lastFailureClass: null,
            consecutiveFailures: 0,
            escalatedAt: null,
          } as const);
        const claimed: CommunityPurchaseFundingAttemptState = {
          ...base,
          generation: base.generation + 1,
          lastAttemptAt: "2026-08-19T00:00:00.000Z",
          nextAttemptAt: "2026-08-19T00:01:00.000Z",
        };
        attemptRows.set(input.operationId, claimed);
        return { kind: "reserved", state: claimed } as const;
      }),
    recordAttemptSuccess: (input) =>
      Effect.sync(() => {
        const row = attemptRows.get(input.operationId);
        if (!row || row.generation !== input.generation) {
          return { kind: "stale" } as const;
        }
        const next: CommunityPurchaseFundingAttemptState = {
          ...row,
          nextAttemptAt: null,
          lastFailureClass: null,
          consecutiveFailures: 0,
          escalatedAt: null,
        };
        attemptRows.set(input.operationId, next);
        return { kind: "finalized", state: next } as const;
      }),
    recordAttemptFailure: (input) =>
      Effect.sync(() => {
        const row = attemptRows.get(input.operationId);
        if (!row || row.generation !== input.generation) {
          return { kind: "stale" } as const;
        }
        recordedDelays.push(input.retryDelayMs);
        const consecutiveFailures = row.consecutiveFailures + 1;
        const escalated =
          consecutiveFailures >= input.escalationThreshold
            ? (row.escalatedAt ?? "2026-08-19T00:00:00.000Z")
            : null;
        const next: CommunityPurchaseFundingAttemptState = {
          ...row,
          lastFailureClass: input.failureClass,
          consecutiveFailures,
          escalatedAt: escalated,
          nextAttemptAt: "2026-08-19T00:05:00.000Z",
        };
        attemptRows.set(input.operationId, next);
        return { kind: "finalized", state: next } as const;
      }),
  };

  const observation: CommunityPurchaseFundingObservationUseCase = {
    observe: (input) => {
      observed.push(input.operationId);
      onObserve?.(input.operationId, { attemptRows });
      const outcome = outcomes[input.operationId] ?? { kind: "success" };
      if (outcome.kind === "failure") return Effect.fail(outcome.error);
      return Effect.succeed({
        lease: {
          operationId: input.operationId,
          ownerId: "worker_1",
          fenceToken: 1,
          expiresAt: "2026-08-19T00:01:00.000Z",
        },
        entry: { idempotencyKey: input.operationId, version: 2, state: {} },
        replayed: false,
      } as unknown as CommunityPurchaseFundingObservationResult);
    },
  };

  const alertsService = {
    emit: (alert: Alert): Effect.Effect<void> =>
      Effect.sync(() => {
        alerts.push(alert);
      }),
  };

  const reconcile = makeCommunityPurchaseFundingReconciler(
    queryStore,
    attempts,
    observation,
    alertsService,
    TEST_POLICY,
  );
  const runTick = () =>
    Effect.runPromise(reconcile({ limit: 10, ownerId: "job_1", leaseMs: 30_000, at: 1_700 }));

  return { attemptRows, blockedReservations, recordedDelays, alerts, observed, runTick };
}

describe("community purchase funding reconciliation fairness", () => {
  test("isolates an expected failure and keeps processing later candidates", async () => {
    const harness = makeHarness({
      [OPERATION_A]: {
        kind: "failure",
        error: new CommunityPurchaseFundingChainReadFailed({ reason: "timeout" }),
      },
      [OPERATION_B]: { kind: "success" },
    });
    const result = await harness.runTick();
    expect(result).toEqual({ selected: 2, processed: 1, failed: 1, skipped: 0 });
    expect(harness.observed).toEqual([OPERATION_A, OPERATION_B]);
    expect(harness.attemptRows.get(OPERATION_A)).toMatchObject({
      lastFailureClass: "chain_timeout",
      consecutiveFailures: 1,
      escalatedAt: null,
    });
    expect(harness.attemptRows.get(OPERATION_B)).toMatchObject({
      lastFailureClass: null,
      consecutiveFailures: 0,
    });
    expect(harness.recordedDelays).toHaveLength(1);
    expect(harness.alerts).toEqual([]);
  });

  test("treats lease contention as an expected non-counting class", async () => {
    const harness = makeHarness({
      [OPERATION_A]: {
        kind: "failure",
        error: new CommunityPurchaseFundingRejected({ reason: "lease-busy" }),
      },
      [OPERATION_B]: { kind: "success" },
    });
    const result = await harness.runTick();
    expect(result).toEqual({ selected: 2, processed: 1, failed: 1, skipped: 0 });
    expect(harness.attemptRows.get(OPERATION_A)?.lastFailureClass).toBe("lease_contention");
  });

  test("skips a candidate whose reservation is unavailable without observing it", async () => {
    const harness = makeHarness({
      [OPERATION_A]: {
        kind: "failure",
        error: new CommunityPurchaseFundingChainReadFailed({ reason: "timeout" }),
      },
      [OPERATION_B]: { kind: "success" },
    });
    harness.blockedReservations.add(OPERATION_A);
    const result = await harness.runTick();
    expect(result).toEqual({ selected: 2, processed: 1, failed: 0, skipped: 1 });
    expect(harness.observed).toEqual([OPERATION_B]);
    expect(harness.attemptRows.has(OPERATION_A)).toBe(false);
    expect(harness.recordedDelays).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  test("a stale finalizer performs no write and owns no alert", async () => {
    const harness = makeHarness(
      {
        [OPERATION_A]: {
          kind: "failure",
          error: new CommunityPurchaseFundingChainReadFailed({ reason: "timeout" }),
        },
        [OPERATION_B]: { kind: "success" },
      },
      (operationId, internals) => {
        // A second worker claims the same operation while the first observes.
        if (operationId !== OPERATION_A) return;
        const row = internals.attemptRows.get(OPERATION_A);
        if (row) {
          internals.attemptRows.set(OPERATION_A, { ...row, generation: row.generation + 1 });
        }
      },
    );
    const result = await harness.runTick();
    expect(result).toEqual({ selected: 2, processed: 1, failed: 0, skipped: 1 });
    expect(harness.attemptRows.get(OPERATION_A)).toMatchObject({
      generation: 2,
      consecutiveFailures: 0,
      lastFailureClass: null,
    });
    expect(harness.recordedDelays).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  test("a stale successful finalizer is skipped rather than counted as processed", async () => {
    const harness = makeHarness(
      {
        [OPERATION_A]: { kind: "success" },
        [OPERATION_B]: { kind: "success" },
      },
      (operationId, internals) => {
        if (operationId !== OPERATION_A) return;
        const row = internals.attemptRows.get(OPERATION_A);
        if (row) {
          internals.attemptRows.set(OPERATION_A, { ...row, generation: row.generation + 1 });
        }
      },
    );
    const result = await harness.runTick();
    expect(result).toEqual({ selected: 2, processed: 1, failed: 0, skipped: 1 });
    expect(harness.attemptRows.get(OPERATION_A)).toMatchObject({
      generation: 2,
      consecutiveFailures: 0,
      lastFailureClass: null,
    });
    expect(harness.recordedDelays).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  test("aborts the batch on infrastructure defects without touching later candidates", async () => {
    const harness = makeHarness({
      [OPERATION_A]: {
        kind: "failure",
        error: new CommunityPurchaseFundingStorageFailed({ reason: "unavailable" }),
      },
      [OPERATION_B]: { kind: "success" },
    });
    await expect(harness.runTick()).rejects.toMatchObject({ reason: "unavailable" });
    expect(harness.observed).toEqual([OPERATION_A]);
    expect(harness.attemptRows.get(OPERATION_A)?.lastFailureClass).toBeNull();
    expect(harness.attemptRows.has(OPERATION_B)).toBe(false);
  });

  test("emits exactly one fixed-key stuck alert at the escalation threshold", async () => {
    const harness = makeHarness({
      [OPERATION_A]: {
        kind: "failure",
        error: new CommunityPurchaseFundingChainReadFailed({ reason: "not-found" }),
      },
      [OPERATION_B]: { kind: "success" },
    });
    await harness.runTick();
    await harness.runTick();
    expect(harness.alerts).toEqual([]);
    await harness.runTick();
    expect(harness.attemptRows.get(OPERATION_A)).toMatchObject({
      consecutiveFailures: 3,
      lastFailureClass: "transaction_not_found",
    });
    expect(harness.alerts).toEqual([
      {
        key: COMMUNITY_PURCHASE_RECONCILIATION_STUCK_ALERT_KEY,
        severity: "high",
        body: "community purchase funding reconciliation stuck after 3 consecutive failures (class: transaction_not_found); operator review required",
        entity: OPERATION_A,
      },
    ]);
    await harness.runTick();
    expect(harness.alerts).toHaveLength(1);
  });

  test("computes deterministic policy delays and resets on success", async () => {
    const outcomes: Record<string, ObservationOutcome> = {
      [OPERATION_A]: {
        kind: "failure",
        error: new CommunityPurchaseFundingChainReadFailed({ reason: "timeout" }),
      },
    };
    const harness = makeHarness(outcomes);
    await harness.runTick();
    expect(harness.recordedDelays).toHaveLength(1);
    const base = TEST_POLICY.baseDelayMs.chain_timeout;
    const jitterWindow = base * (TEST_POLICY.jitterPercent / 100);
    expect(harness.recordedDelays[0]).toBeGreaterThanOrEqual(Math.floor(base - jitterWindow));
    expect(harness.recordedDelays[0]).toBeLessThanOrEqual(Math.ceil(base + jitterWindow));

    outcomes[OPERATION_A] = { kind: "success" };
    await harness.runTick();
    expect(harness.attemptRows.get(OPERATION_A)).toMatchObject({
      consecutiveFailures: 0,
      lastFailureClass: null,
      nextAttemptAt: null,
    });
  });

  test("maps every observation failure to a bounded class or a defect", () => {
    const classes: Array<[CommunityPurchaseFundingObservationFailure, ReconciliationFailureClass]> =
      [
        [new CommunityPurchaseFundingChainReadFailed({ reason: "timeout" }), "chain_timeout"],
        [
          new CommunityPurchaseFundingChainReadFailed({ reason: "unavailable" }),
          "chain_unavailable",
        ],
        [
          new CommunityPurchaseFundingChainReadFailed({ reason: "not-found" }),
          "transaction_not_found",
        ],
        [
          new CommunityPurchaseFundingChainReadFailed({ reason: "invalid-evidence" }),
          "invalid_evidence",
        ],
        [new CommunityPurchaseFundingChainReadFailed({ reason: "reorg" }), "reorg"],
        [new CommunityPurchaseFundingRejected({ reason: "lease-busy" }), "lease_contention"],
        [new CommunityPurchaseFundingRejected({ reason: "lease-lost" }), "lease_contention"],
        [new CommunityPurchaseFundingRejected({ reason: "version-conflict" }), "lease_contention"],
        [
          new CommunityPurchaseFundingRejected({ reason: "transition-rejected" }),
          "lease_contention",
        ],
        [
          new CommunityPurchaseFundingRejected({ reason: "identity-conflict" }),
          "identity_conflict",
        ],
      ];
    for (const [error, failureClass] of classes) {
      expect(classifyObservationFailure(error)).toEqual({ kind: "expected", failureClass });
    }
    for (const defect of [
      new CommunityPurchaseFundingStorageFailed({ reason: "unavailable" }),
      new CommunityPurchaseFundingStorageFailed({ reason: "invalid-row" }),
      new CommunityPurchaseFundingStorageFailed({ reason: "constraint" }),
      new CommunityPurchaseFundingStorageFailed({ reason: "outcome-unknown" }),
      new CommunityPurchaseFundingRejected({ reason: "invalid-input" }),
      new CommunityPurchaseFundingRejected({ reason: "not-found" }),
    ]) {
      expect(classifyObservationFailure(defect)).toEqual({ kind: "defect" });
    }
  });
});
