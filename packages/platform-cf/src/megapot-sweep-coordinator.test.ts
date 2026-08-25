import { describe, expect, test } from "bun:test";
import type {
  MegapotSweepCandidate,
  MegapotSweepResult,
  MegapotSweepStore,
} from "@pirate/application";
import { Effect } from "effect";
import { deriveMegapotSweepId, makeMegapotSweepCoordinator } from "./megapot-sweep-coordinator.ts";
import type { MegapotV2DrawingState } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

const hash = (byte: string) => `0x${byte.repeat(64)}`;
const address = (byte: string) => `0x${byte.repeat(40)}`;

const candidate: MegapotSweepCandidate = {
  poolLegId: "pool-leg-sweep",
  drawingId: 101n,
  drawingVersion: 7,
  drawingStatus: "tickets_confirmed",
  attestationId: "megapot-base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  jackpotAddress: address("1"),
  usdcAddress: address("2"),
  ticketNftAddress: address("3"),
  custodyAddress: address("4"),
  referrerAddress: address("5"),
  jackpotCodeHash: hash("6"),
  usdcCodeHash: hash("7"),
  ticketNftCodeHash: hash("8"),
  ticketId: 91n,
};

const drawingState: MegapotV2DrawingState = {
  prizePool: 10_000_000n,
  ticketPrice: 1_000_000n,
  edgePerTicket: 100_000n,
  referralWinShare: 100_000_000_000_000_000n,
  referralFee: 100_000_000_000_000_000n,
  globalTicketsBought: 10n,
  lpEarnings: 9_000_000n,
  drawingTime: 1_800_000_000n,
  winningTicket: 123n,
  ballMax: 25,
  bonusballMax: 13,
  payoutCalculator: address("9"),
  jackpotLock: false,
};

function harness(options: { readonly tierId: bigint; readonly settled?: boolean }) {
  let stored: MegapotSweepResult | null = null;
  let pendingCalls = 0;
  let completeCalls = 0;
  const store = {
    loadCandidate: () => Effect.succeed(candidate),
    findResult: () => Effect.succeed(stored),
    markDrawingPending: () => {
      pendingCalls += 1;
      return Effect.void;
    },
    complete: (input) => {
      completeCalls += 1;
      stored = {
        sweepId: input.sweepId,
        poolLegId: input.candidate.poolLegId,
        drawingId: input.candidate.drawingId,
        ticketId: input.candidate.ticketId,
        outcome: input.tierId === 0 || input.tierId === 2 ? "no_win" : "winnings_detected",
        tierId: input.tierId,
        grossWinningsAtomic: input.grossWinningsAtomic,
        referralAccrualAtomic: input.referralAccrualAtomic,
        netWinningsAtomic: input.netWinningsAtomic,
        observationBlockNumber: input.observationBlockNumber,
        observationBlockHash: input.observationBlockHash,
      };
      return Effect.succeed(stored);
    },
  } satisfies MegapotSweepStore;
  const payouts = Array<bigint>(12).fill(0n);
  payouts[Number(options.tierId)] = options.tierId === 0n || options.tierId === 2n ? 0n : 1_001n;
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: candidate.jackpotCodeHash,
      ticketNftCodeHash: candidate.ticketNftCodeHash,
      usdcCodeHash: candidate.usdcCodeHash,
    }),
    readCurrentDrawing: async () => ({ drawingId: 102n, state: drawingState }),
    readCurrentDrawingId: async () => (options.settled === false ? 101n : 102n),
    readDrawing: async () =>
      options.settled === false ? { ...drawingState, winningTicket: 0n } : drawingState,
    readDrawingTierPayouts: async () => payouts,
    readTicketTierIds: async () => [options.tierId],
    readReferralFees: async () => 0n,
    readUsdcBalance: async () => 0n,
    readNativeBalance: async () => 0n,
    readUsdcAllowance: async () => 0n,
    readTicketOwner: async () => candidate.custodyAddress,
    readPendingNonce: async () => 0n,
    estimateGas: async () => 0n,
    readFeeQuote: async () => ({
      baseFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      maxFeePerGas: 0n,
      observedBlockNumber: 100n,
      observedBlockHash: hash("a"),
    }),
    sendRawTransaction: async () => hash("b"),
    readReceipt: async () => null,
    readHead: async () => ({ blockNumber: 102n, blockHash: hash("c") }),
    readBlock: async (blockNumber) => ({ blockNumber, blockHash: hash("d") }),
  } satisfies MegapotV2RpcClient;
  return {
    coordinator: makeMegapotSweepCoordinator({
      store,
      rpc,
      requiredConfirmations: 3,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    }),
    pendingCalls: () => pendingCalls,
    completeCalls: () => completeCalls,
  };
}

describe("Megapot sweep coordinator", () => {
  test("records one finalized winning ticket with exact referral/net conservation", async () => {
    const testHarness = harness({ tierId: 7n });
    const first = await Effect.runPromise(
      testHarness.coordinator.sweep({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(first).toMatchObject({
      kind: "complete",
      sweepId: deriveMegapotSweepId(candidate.poolLegId, 101n),
      outcome: "winnings_detected",
      tierId: 7,
      grossWinningsAtomic: 1_001n,
      referralAccrualAtomic: 100n,
      netWinningsAtomic: 901n,
      observationBlockNumber: 100n,
    });
    const replay = await Effect.runPromise(
      testHarness.coordinator.sweep({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(replay).toEqual(first);
    expect(testHarness.completeCalls()).toBe(1);
  });

  test("distinguishes no-win from an unsettled drawing", async () => {
    const noWinHarness = harness({ tierId: 2n });
    await expect(
      Effect.runPromise(
        noWinHarness.coordinator.sweep({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).resolves.toMatchObject({ kind: "complete", outcome: "no_win", grossWinningsAtomic: 0n });

    const pendingHarness = harness({ tierId: 0n, settled: false });
    await expect(
      Effect.runPromise(
        pendingHarness.coordinator.sweep({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).resolves.toMatchObject({ kind: "drawing_pending", observationBlockNumber: 100n });
    expect(pendingHarness.pendingCalls()).toBe(1);
    expect(pendingHarness.completeCalls()).toBe(0);
  });
});
