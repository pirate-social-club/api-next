import { describe, expect, test } from "bun:test";
import type {
  MegapotDrawingObservationRecord,
  MegapotDrawingObservationStore,
  MegapotDrawingObserverCandidate,
} from "@pirate/application";
import { Effect } from "effect";
import { makeMegapotDrawingObserver } from "./megapot-drawing-observer.ts";
import type { MegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const bytes32 = (byte: string): string => `0x${byte.repeat(64)}`;

const candidate = (): MegapotDrawingObserverCandidate => ({
  attestationId: "megapot-base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  jackpotAddress: address("1"),
  usdcAddress: address("2"),
  ticketNftAddress: address("3"),
  custodyAddress: address("4"),
  referrerAddress: address("5"),
  sourceTag: bytes32("6"),
  jackpotCodeHash: bytes32("7"),
  usdcCodeHash: bytes32("8"),
  ticketNftCodeHash: bytes32("9"),
  attestationBlockNumber: 90n,
  attestationBlockHash: bytes32("a"),
  verifiedAt: "2026-08-26T00:00:00.000Z",
});

const deployment = (value: MegapotDrawingObserverCandidate): MegapotV2DeploymentAttestation => ({
  attestationId: value.attestationId,
  environment: value.environment,
  chainId: value.chainId,
  jackpotAddress: value.jackpotAddress,
  usdcAddress: value.usdcAddress,
  ticketNftAddress: value.ticketNftAddress,
  custodyAddress: value.custodyAddress,
  referrerAddress: value.referrerAddress,
  jackpotCodeHash: value.jackpotCodeHash,
  usdcCodeHash: value.usdcCodeHash,
  ticketNftCodeHash: value.ticketNftCodeHash,
});

function rpc(authority: MegapotDrawingObserverCandidate): MegapotV2RpcClient {
  return {
    deployment: deployment(authority),
    attestDeployment: async () => ({
      jackpotCodeHash: authority.jackpotCodeHash,
      ticketNftCodeHash: authority.ticketNftCodeHash,
      usdcCodeHash: authority.usdcCodeHash,
    }),
    readTicketPurchasesAllowed: async () => true,
    readCurrentDrawing: async () => ({
      drawingId: 101n,
      state: await rpc(authority).readDrawing(101n),
    }),
    readCurrentDrawingId: async (blockNumber) => {
      expect(blockNumber).toBe(100n);
      return 101n;
    },
    readDrawing: async (drawingId, blockNumber) => {
      expect(drawingId).toBe(101n);
      if (blockNumber !== undefined) expect(blockNumber).toBe(100n);
      return {
        prizePool: 1_000_000n,
        ticketPrice: 10_000n,
        edgePerTicket: 1_000n,
        referralWinShare: 100_000_000_000_000_000n,
        referralFee: 100_000_000_000_000_000n,
        globalTicketsBought: 7n,
        lpEarnings: 9_000n,
        drawingTime: 1_777_507_200n,
        winningTicket: 0n,
        ballMax: 25,
        bonusballMax: 13,
        payoutCalculator: address("a"),
        jackpotLock: false,
      };
    },
    readDrawingTierPayouts: async () => [],
    readTicketTierIds: async () => [],
    readReferralFees: async () => 0n,
    readUsdcBalance: async () => 0n,
    readNativeBalance: async () => 0n,
    readUsdcAllowance: async () => 0n,
    readTicketOwner: async () => authority.custodyAddress,
    readPendingNonce: async () => 0n,
    estimateGas: async () => 100_000n,
    readFeeQuote: async () => ({
      baseFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 3n,
      observedBlockNumber: 100n,
      observedBlockHash: bytes32("b"),
    }),
    sendRawTransaction: async () => bytes32("c"),
    readReceipt: async () => null,
    readHead: async () => ({
      blockNumber: 100n,
      blockHash: bytes32("b"),
      blockTimestamp: 1_777_420_800n,
    }),
    readBlock: async (blockNumber) => ({
      blockNumber,
      blockHash: bytes32("b"),
      blockTimestamp: 1_777_420_800n,
    }),
  };
}

describe("Megapot drawing observer", () => {
  test("reads one immutable block and opens drawings from persisted authority", async () => {
    const authority = candidate();
    const recorded: MegapotDrawingObservationRecord[] = [];
    const store: MegapotDrawingObservationStore = {
      loadCandidate: () => Effect.succeed(authority),
      recordAndOpen: (observation) => {
        recorded.push(observation);
        return Effect.succeed({ ...observation, openedPoolLegIds: ["pool-leg-1"] });
      },
    };
    const observer = makeMegapotDrawingObserver({
      store,
      rpc: rpc(authority),
      observationTtlMs: 15 * 60 * 1_000,
      now: () => Date.parse("2026-04-29T00:01:00.000Z"),
    });
    const result = await Effect.runPromise(observer.observe(authority.attestationId));
    expect(result).toMatchObject({
      drawingId: 101n,
      ticketPriceAtomic: 10_000n,
      drawingTime: "2026-04-30T00:00:00.000Z",
      blockTimestamp: "2026-04-29T00:00:00.000Z",
      openedPoolLegIds: ["pool-leg-1"],
    });
    expect(recorded[0]?.observationId).toMatch(/^drawing_observation_[0-9a-f]{64}$/u);
    expect(recorded[0]?.rawStateHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects an RPC configured for a different deployment", async () => {
    const authority = candidate();
    const mismatched = { ...authority, jackpotAddress: address("f") };
    const store: MegapotDrawingObservationStore = {
      loadCandidate: () => Effect.succeed(authority),
      recordAndOpen: (observation) => Effect.succeed({ ...observation, openedPoolLegIds: [] }),
    };
    const observer = makeMegapotDrawingObserver({
      store,
      rpc: rpc(mismatched),
      observationTtlMs: 60_000,
    });
    await expect(
      Effect.runPromise(observer.observe(authority.attestationId)),
    ).rejects.toMatchObject({
      reason: "deployment-attestation-mismatch",
    });
  });
});
