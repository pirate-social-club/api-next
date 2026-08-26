import { describe, expect, test } from "bun:test";
import type { MegapotWorkStore } from "@pirate/platform-cf/megapot-work-repository";
import { Effect } from "effect";
import { type MegapotRewardsRuntime, runMegapotRewardsCycle } from "./megapot-rewards-cycle.ts";

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
  };
  const call = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
      return { kind: "complete" };
    });
  const runtime: MegapotRewardsRuntime = {
    reconcile: () => call("reconcile"),
    observeDrawing: () => call("observe-drawing"),
    observeSolvency: () => call("observe-solvency"),
    freezeDue: () => call("cutoff").pipe(Effect.as([{}])),
    publishCommitment: () => call("commitment"),
    approve: () => call("approval").pipe(Effect.as({ kind: approvalKind })),
    purchase: () => call("purchase"),
    sweep: () => call("sweep"),
    claim: () => call("claim"),
    allocate: () => call("allocate"),
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
      "observe-solvency",
      "payout",
    ]);
    expect(result).toMatchObject({
      reconciled: 1,
      frozen: 1,
      committed: 1,
      purchased: 1,
      swept: 2,
      claimed: 1,
      allocated: 1,
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
});
