import { describe, expect, test } from "bun:test";
import type {
  MegapotAllocationCandidate,
  MegapotAllocationResult,
  MegapotAllocationStore,
} from "@pirate/application";
import { Effect } from "effect";
import {
  deriveMegapotAllocationBatchId,
  makeMegapotAllocationCoordinator,
  prepareEqualMegapotAllocations,
} from "./megapot-allocation-coordinator.ts";

const candidate: MegapotAllocationCandidate = {
  poolLegId: "pool-leg-allocation",
  drawingId: 101n,
  drawingVersion: 11,
  drawingStatus: "claimed",
  snapshotId: "snapshot-101",
  claimEffectId: "claim-101",
  algorithmVersion: "equal_v1",
  netWinningsAtomic: 901n,
  chainId: 84_532,
  tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  fallback: false,
  fundingSource: "leg_budget",
  fallbackBeneficiaryAccountId: null,
  fallbackPayoutPersonaId: null,
  leaves: [
    { ordinal: 0, accountId: "account-a", personaId: "persona-a" },
    { ordinal: 1, accountId: "account-b", personaId: "persona-b" },
    { ordinal: 2, accountId: "account-c", personaId: "persona-c" },
  ],
};

function harness(inputCandidate: MegapotAllocationCandidate = candidate) {
  let result: MegapotAllocationResult | null = null;
  let creditCalls = 0;
  const store: MegapotAllocationStore = {
    loadCandidate: () => Effect.succeed(inputCandidate),
    findResult: () => Effect.succeed(result),
    credit: (input) => {
      creditCalls += 1;
      result = {
        allocationBatchId: input.allocationBatchId,
        poolLegId: input.candidate.poolLegId,
        drawingId: input.candidate.drawingId,
        snapshotId: input.candidate.snapshotId,
        claimEffectId: input.candidate.claimEffectId,
        netWinningsAtomic: input.candidate.netWinningsAtomic,
        allocationHash: input.allocationHash,
        allocations: input.allocations,
        state: "credited",
      };
      return Effect.succeed(result);
    },
  };
  return { store, creditCalls: () => creditCalls };
}

describe("Megapot allocation coordinator", () => {
  test("credits equal shares with the deterministic remainder in snapshot order", async () => {
    const state = harness();
    const coordinator = makeMegapotAllocationCoordinator({
      store: state.store,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });

    const first = await Effect.runPromise(
      coordinator.allocate({ poolLegId: candidate.poolLegId, drawingId: candidate.drawingId }),
    );
    const replay = await Effect.runPromise(
      coordinator.allocate({ poolLegId: candidate.poolLegId, drawingId: candidate.drawingId }),
    );

    expect(first.allocations.map((allocation) => allocation.amountAtomic)).toEqual([
      301n,
      300n,
      300n,
    ]);
    expect(first.allocations.map((allocation) => allocation.allocationKind)).toEqual([
      "participant",
      "participant",
      "participant",
    ]);
    expect(first.allocationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(replay).toEqual(first);
    expect(state.creditCalls()).toBe(1);
  });

  test("distinguishes external and platform fallback liabilities", () => {
    const batchId = deriveMegapotAllocationBatchId("fallback-leg", 7n, "claim-7");
    const external = prepareEqualMegapotAllocations(
      {
        ...candidate,
        poolLegId: "fallback-leg",
        drawingId: 7n,
        claimEffectId: "claim-7",
        netWinningsAtomic: 900n,
        fallback: true,
        fallbackBeneficiaryAccountId: "account-a",
        fallbackPayoutPersonaId: "persona-a",
        leaves: [{ ordinal: 0, accountId: "account-a", personaId: "persona-a" }],
      },
      batchId,
    );
    const platform = prepareEqualMegapotAllocations(
      {
        ...candidate,
        poolLegId: "fallback-leg",
        drawingId: 7n,
        claimEffectId: "claim-7",
        netWinningsAtomic: 900n,
        fallback: true,
        fundingSource: "shared_sponsor_budget",
        fallbackBeneficiaryAccountId: "platform-sponsor",
        fallbackPayoutPersonaId: null,
        leaves: [{ ordinal: 0, accountId: "platform-sponsor", personaId: "platform-persona" }],
      },
      batchId,
    );

    expect(external[0]).toMatchObject({
      amountAtomic: 900n,
      allocationKind: "external_fallback",
    });
    expect(external[0]?.creditId).not.toBeNull();
    expect(platform[0]).toMatchObject({
      amountAtomic: 900n,
      allocationKind: "platform_sponsorship",
      creditId: null,
      creditSourceReference: null,
    });
  });

  test("rejects a noncanonical snapshot or a zero-value beneficiary", () => {
    const batchId = deriveMegapotAllocationBatchId("pool", 1n, "claim");
    expect(() =>
      prepareEqualMegapotAllocations(
        {
          ...candidate,
          netWinningsAtomic: 1n,
          leaves: [
            { ordinal: 1, accountId: "account-a", personaId: "persona-a" },
            { ordinal: 0, accountId: "account-b", personaId: "persona-b" },
          ],
        },
        batchId,
      ),
    ).toThrow();
  });
});
