import { describe, expect, test } from "bun:test";
import type {
  MegapotDrawingWork,
  MegapotDrawingWorkStatus,
} from "@pirate/platform-cf/megapot-work-repository";
import { Data, Effect } from "effect";
import { buildJobRegistry } from "./registry.ts";
import { makeSafePoolPilotJob } from "./safe-pool-pilot.ts";
import { runSafePoolPilotCycle, type SafePoolPilotRuntime } from "./safe-pool-pilot-cycle.ts";

class StepFailed extends Data.TaggedError("StepFailed")<{
  readonly reason: string;
  readonly detail: string;
}> {}

const drawingWork = (poolLegId: string, status: MegapotDrawingWorkStatus): MegapotDrawingWork =>
  ({ poolLegId, drawingId: 212n, status }) as MegapotDrawingWork;

function harness(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const step =
    <A>(name: string, value: A) =>
    (subject = "") => {
      const label = subject === "" ? name : `${name}:${subject}`;
      calls.push(label);
      return fail.has(label)
        ? Effect.fail(new StepFailed({ reason: "refused", detail: "provider text" }))
        : Effect.succeed(value);
    };
  const drawings: Record<string, readonly MegapotDrawingWork[]> = {
    cutoff_frozen: [drawingWork("leg-frozen", "cutoff_frozen")],
    "committed,drawing_pending": [drawingWork("leg-committed", "committed")],
    winnings_detected: [drawingWork("leg-won", "winnings_detected")],
    claimed: [drawingWork("leg-claimed", "claimed")],
  };
  const runtime: SafePoolPilotRuntime = {
    observeDrawing: () => step("observe_drawing", true)(),
    scan: () => step("scan", null)(),
    loadBoundEffects: () =>
      step("load_bound_effects", [
        { effectId: "purchase-1", kind: "ticket_purchase" },
        { effectId: "payout-1", kind: "reward_payout" },
      ] as const)(),
    settlePurchase: (effectId) => step("settle_purchase", null)(effectId),
    settlePayout: (effectId) => step("settle_payout", null)(effectId),
    loadPendingFunding: () => step("load_funding", ["funding-1"])(),
    reconcileFunding: (fundingEffectId) => step("reconcile_funding", null)(fundingEffectId),
    closeUnexecutedPurchases: () => step("close_unexecuted_purchases", 0)(),
    loadLegs: () => step("load_legs", ["leg-a", "leg-b"])(),
    preparePurchase: (legId) => step("prepare_purchase", null)(legId),
    freezeDue: () => step("freeze_due", [])(),
    loadDrawings: (statuses) =>
      step("load_drawings", drawings[statuses.join(",")] ?? [])(statuses.join(",")),
    publishCommitment: (drawing) => step("publish_commitment", null)(drawing.poolLegId),
    sweep: (drawing) => step("sweep", null)(drawing.poolLegId),
    settleClaim: (drawing) => step("settle_claim", null)(drawing.poolLegId),
    prepareClaim: (drawing) => step("prepare_claim", null)(drawing.poolLegId),
    allocate: (drawing) => step("allocate", null)(drawing.poolLegId),
    observeSolvency: () => step("observe_solvency", null)(),
    loadCredits: () => step("load_credits", ["credit-1"])(),
    preparePayout: (creditId) => step("prepare_payout", null)(creditId),
  };
  return { runtime, calls };
}

describe("Safe pool pilot cycle", () => {
  test("runs every step in the order a ticket-first pool moves", async () => {
    const { runtime, calls } = harness();
    const summary = await Effect.runPromise(runSafePoolPilotCycle(runtime));
    expect(calls).toEqual([
      "observe_drawing",
      "scan",
      "load_bound_effects",
      "settle_purchase:purchase-1",
      "settle_payout:payout-1",
      "load_funding",
      "reconcile_funding:funding-1",
      "close_unexecuted_purchases",
      "load_legs",
      "prepare_purchase:leg-a",
      "prepare_purchase:leg-b",
      "freeze_due",
      "load_drawings:cutoff_frozen",
      "publish_commitment:leg-frozen",
      "load_drawings:committed,drawing_pending",
      "sweep:leg-committed",
      "load_drawings:winnings_detected",
      "settle_claim:leg-won",
      "prepare_claim:leg-won",
      "load_drawings:claimed",
      "allocate:leg-claimed",
      "observe_solvency",
      "load_credits",
      "prepare_payout:credit-1",
    ]);
    expect(summary.failed).toEqual({});
    expect(summary.completed.prepare_purchase).toBe(2);
  });

  test("records a failed item by tag and reason and goes on with the pass", async () => {
    const { runtime, calls } = harness(new Set(["scan", "prepare_purchase:leg-a"]));
    const summary = await Effect.runPromise(runSafePoolPilotCycle(runtime));
    expect(summary.failed).toEqual({
      scan: ["StepFailed:refused"],
      prepare_purchase: ["StepFailed:refused"],
    });
    expect(calls).toContain("prepare_purchase:leg-b");
    expect(calls.at(-1)).toBe("prepare_payout:credit-1");
    expect(JSON.stringify(summary)).not.toContain("provider text");
  });

  test("declares a job the registry accepts, and never beside an EOA rewards writer", async () => {
    const job = makeSafePoolPilotJob(
      {},
      {
        environment: "staging",
        attestationId: "megapot-base-safe-pilot",
        rpcUrl: "https://base.example.invalid",
        requiredConfirmations: 3,
        productionEnabled: false,
        minimumEntrySeconds: 3_600,
        observationTtlMs: 60_000,
        commitmentBucket: {
          get: async () => null,
          put: async () => null,
        },
        commitmentPublicOrigin: "https://commitments.example.invalid",
      },
    );
    await expect(Effect.runPromise(buildJobRegistry([job]))).resolves.toBeDefined();
    await expect(
      Effect.runPromise(buildJobRegistry([job, { ...job, name: "megapot-rewards.cycle" }])),
    ).rejects.toMatchObject({ reason: "duplicate-table-writer" });
  });
});
