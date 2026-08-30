import { describe, expect, test } from "bun:test";
import { MegapotDrawingObservationRejected } from "@pirate/application";
import {
  MegapotWorkStorageFailed,
  type MegapotWorkStore,
} from "@pirate/platform-cf/megapot-work-repository";
import { Effect } from "effect";
import {
  type MegapotRewardsRuntime,
  megapotRewardsLivenessAlerts,
  observeMegapotDrawingForCycle,
  runMegapotRewardsCycle,
  writeMegapotRewardsCycleSnapshot,
} from "./megapot-rewards-cycle.ts";

const drawing = (status: Parameters<MegapotWorkStore["loadDrawings"]>[0]["statuses"][number]) => ({
  poolLegId: "leg-1",
  drawingId: 101n,
  status,
  attestationId: "attestation-1",
  ticketPriceAtomic: 1_000_000n,
});

function fixture(approvalKind: "submitted" | "confirmed") {
  const calls: string[] = [];
  const work: MegapotWorkStore = {
    loadChainEffects: () =>
      Effect.succeed([{ effectId: "effect-1", effectKind: "ticket_purchase" }]),
    loadDrawings: ({ statuses }) => Effect.succeed(statuses.map(drawing)),
    loadCredits: () => Effect.succeed(["credit-1"]),
    loadRefunds: () => Effect.succeed(["funding-1"]),
    loadAgedPending: () => Effect.sync(() => calls.push("load-aged-pending")).pipe(Effect.as([])),
  };
  const call = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
      return { kind: "complete" };
    });
  const runtime: MegapotRewardsRuntime = {
    reconcile: () => call("reconcile"),
    observeDrawing: () => call("observe-drawing").pipe(Effect.as(true)),
    observeSolvency: () => call("observe-solvency"),
    freezeDue: () => call("cutoff").pipe(Effect.as([{}])),
    publishCommitment: () => call("commitment"),
    approve: () => call("approval").pipe(Effect.as({ kind: approvalKind })),
    purchase: () => call("purchase").pipe(Effect.as({ kind: "submitted" })),
    sweep: () => call("sweep"),
    claim: () => call("claim"),
    allocate: () => call("allocate"),
    closeExpiredOffers: () => call("close-expired").pipe(Effect.as([{}])),
    refund: () => call("refund"),
    payout: () => call("payout"),
  };
  return { calls, runtime, work };
}

describe("Megapot rewards scheduled cycle", () => {
  test("writes one versioned cycle summary without entity identifiers", () => {
    const events: unknown[] = [];
    const written = writeMegapotRewardsCycleSnapshot(
      {
        reconciled: 1,
        observed: 1,
        frozen: 0,
        committed: 0,
        purchased: 0,
        swept: 1,
        claimed: 0,
        allocated: 0,
        terminalOffers: 1,
        refunded: 1,
        paid: 0,
        failures: ["RewardRefundRejected"],
        agedPending: [
          { family: "chain_effects", count: 2, oldestAgeSeconds: 1_200 },
          { family: "refund_liabilities", count: 1, oldestAgeSeconds: 900 },
        ],
      },
      {
        environment: "staging",
        emittedAt: "2026-08-30T05:00:00.000Z",
        durationMs: 1_234,
        workerVersion: {
          id: "worker-version-1",
          tag: "",
          timestamp: "2026-08-30T04:59:00.000Z",
        },
      },
      (event, fields) => events.push({ event, fields }),
    );
    expect(written).toBe(true);
    expect(events).toEqual([
      {
        event: "megapot.rewards.cycle",
        fields: expect.objectContaining({
          event: "megapot.rewards.cycle",
          schema_version: 2,
          environment: "staging",
          worker_version_id: "worker-version-1",
          duration_ms: 1_234,
          observed_count: 1,
          swept_count: 1,
          terminal_offer_count: 1,
          refunded_count: 1,
          failure_count: 1,
          failure_tags: ["RewardRefundRejected"],
          liveness_status: "available",
          aged_pending_threshold_seconds: 600,
          aged_pending_total_count: 3,
          aged_chain_effect_count: 2,
          aged_funding_effect_count: 0,
          aged_drawing_count: 0,
          aged_credit_count: 0,
          aged_refund_liability_count: 1,
          oldest_aged_pending_seconds: 1_200,
          outcome: "degraded",
          sampled: false,
        }),
      },
    ]);
  });

  test("keeps an unavailable cycle-summary sink diagnostic-only", () => {
    expect(
      writeMegapotRewardsCycleSnapshot(
        {
          reconciled: 0,
          observed: 0,
          frozen: 0,
          committed: 0,
          purchased: 0,
          swept: 0,
          claimed: 0,
          allocated: 0,
          terminalOffers: 0,
          refunded: 0,
          paid: 0,
          failures: [],
          agedPending: [],
        },
        {
          environment: "staging",
          emittedAt: "2026-08-30T05:00:00.000Z",
          durationMs: 50,
          workerVersion: {
            id: "worker-version-1",
            tag: "",
            timestamp: "2026-08-30T04:59:00.000Z",
          },
        },
        () => {
          throw new Error("sink unavailable");
        },
      ),
    ).toBe(false);
  });

  test("records an unavailable liveness projection without false zero counts", () => {
    const events: unknown[] = [];
    expect(
      writeMegapotRewardsCycleSnapshot(
        {
          reconciled: 0,
          observed: 0,
          frozen: 0,
          committed: 0,
          purchased: 0,
          swept: 0,
          claimed: 0,
          allocated: 0,
          terminalOffers: 0,
          refunded: 0,
          paid: 0,
          failures: [],
          agedPending: null,
        },
        {
          environment: "staging",
          emittedAt: "2026-08-30T05:00:00.000Z",
          durationMs: 50,
          workerVersion: {
            id: "worker-version-1",
            tag: "",
            timestamp: "2026-08-30T04:59:00.000Z",
          },
        },
        (_event, fields) => events.push(fields),
      ),
    ).toBe(true);
    expect(events[0]).toMatchObject({
      liveness_status: "unavailable",
      aged_pending_total_count: null,
      aged_chain_effect_count: null,
      aged_funding_effect_count: null,
      aged_drawing_count: null,
      aged_credit_count: null,
      aged_refund_liability_count: null,
      oldest_aged_pending_seconds: null,
      outcome: "degraded",
    });
  });

  test("advances every persisted phase sequentially under one custody lane", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(calls).toEqual([
      "reconcile",
      "observe-drawing",
      "observe-solvency",
      "cutoff",
      "commitment",
      "approval",
      "purchase",
      "sweep",
      "sweep",
      "claim",
      "allocate",
      "close-expired",
      "observe-solvency",
      "refund",
      "observe-solvency",
      "payout",
      "load-aged-pending",
    ]);
    expect(result).toMatchObject({
      reconciled: 1,
      observed: 1,
      frozen: 1,
      committed: 1,
      purchased: 1,
      swept: 2,
      claimed: 1,
      allocated: 1,
      terminalOffers: 1,
      refunded: 1,
      paid: 1,
      failures: [],
      agedPending: [],
    });
  });

  test("keeps an unavailable liveness projection diagnostic-only", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work: {
          ...work,
          loadAgedPending: () =>
            Effect.fail(new MegapotWorkStorageFailed({ reason: "unavailable" })),
        },
        runtime,
      }),
    );

    expect(calls).toContain("payout");
    expect(result.agedPending).toBeNull();
    expect(result.failures).toEqual([]);
  });

  test("emits stable identifier-free high conditions for aged state families", () => {
    expect(
      megapotRewardsLivenessAlerts([
        { family: "drawings", count: 2, oldestAgeSeconds: 1_800 },
        { family: "credits", count: 1, oldestAgeSeconds: 900 },
      ]),
    ).toEqual([
      {
        key: "megapot-rewards:aged-drawings",
        severity: "high",
        body: "Reward drawing transitions exceeded their persisted schedule grace period.",
      },
      {
        key: "megapot-rewards:aged-credits",
        severity: "high",
        body: "Reward credits exceeded the payout grace period.",
      },
    ]);
    expect(megapotRewardsLivenessAlerts([])).toEqual([]);
    expect(megapotRewardsLivenessAlerts(null)).toEqual([
      {
        key: "megapot-rewards:aged-state-projection-unavailable",
        severity: "high",
        body: "The aggregate rewards liveness projection was unavailable.",
      },
    ]);
  });

  test("does not purchase until the shared allowance transaction is confirmed", async () => {
    const { calls, runtime, work } = fixture("submitted");
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(calls).toContain("approval");
    expect(calls).not.toContain("purchase");
    expect(result.purchased).toBe(0);
  });

  test("does not count a pre-broadcast terminal closure as a purchase", async () => {
    const { runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          purchase: () => Effect.succeed({ kind: "closed" }),
        },
      }),
    );
    expect(result.purchased).toBe(0);
  });

  test("continues other candidates after a typed phase failure and reports its tag", async () => {
    const { runtime, work } = fixture("confirmed");
    let attempts = 0;
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work: {
          ...work,
          loadCredits: () => Effect.succeed(["credit-fail", "credit-pass"]),
        },
        runtime: {
          ...runtime,
          payout: () => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail({ _tag: "RewardPayoutRejected" as const })
              : Effect.succeed({});
          },
        },
      }),
    );
    expect(result.paid).toBe(1);
    expect(result.failures).toContain("RewardPayoutRejected");
  });

  test("continues return-side work while the contract rolls to its next drawing", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          observeDrawing: () =>
            observeMegapotDrawingForCycle(
              Effect.sync(() => calls.push("observe-drawing")).pipe(
                Effect.andThen(
                  Effect.fail(new MegapotDrawingObservationRejected({ reason: "drawing-closed" })),
                ),
              ),
            ),
        },
      }),
    );

    expect(result.observed).toBe(0);
    expect(calls).toContain("observe-solvency");
    expect(calls).toContain("sweep");
    expect(calls).toContain("claim");
    expect(calls).toContain("allocate");
    expect(calls).toContain("refund");
    expect(calls).toContain("payout");
  });

  test("keeps every non-rollover drawing rejection fail-closed", async () => {
    await expect(
      Effect.runPromise(
        observeMegapotDrawingForCycle(
          Effect.fail(
            new MegapotDrawingObservationRejected({
              reason: "deployment-attestation-mismatch",
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "MegapotDrawingObservationRejected",
      reason: "deployment-attestation-mismatch",
    });
  });
});
