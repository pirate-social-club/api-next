import { describe, expect, test } from "bun:test";
import { MegapotDrawingObservationRejected } from "@pirate/application";
import type { MegapotWorkStore } from "@pirate/platform-cf/megapot-work-repository";
import { Effect } from "effect";
import {
  type MegapotRewardsRuntime,
  observeMegapotDrawingForCycle,
  runMegapotRewardsCycle,
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
    purchase: () => call("purchase"),
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
    });
  });

  test("does not purchase until the shared allowance transaction is confirmed", async () => {
    const { calls, runtime, work } = fixture("submitted");
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(calls).toContain("approval");
    expect(calls).not.toContain("purchase");
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
