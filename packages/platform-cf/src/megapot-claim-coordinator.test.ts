import { describe, expect, test } from "bun:test";
import type {
  MegapotClaimCandidate,
  MegapotClaimProgress,
  MegapotClaimStore,
} from "@pirate/application";
import { Effect } from "effect";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import {
  deriveMegapotClaimEffectId,
  makeMegapotClaimCoordinator,
} from "./megapot-claim-coordinator.ts";
import {
  EVM_ZERO_ADDRESS,
  encodeMegapotV2ClaimRevert,
  type MegapotTransactionReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

const address = (byte: string): Hex => `0x${byte.repeat(40)}`;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const JACKPOT = address("1");
const USDC = address("2");
const NFT = address("3");
const CUSTODY = address("4");
const REFERRER = address("5");
const BLOCK = hash("a");
const SIGNED_TRANSACTION = "0x01020304" as Hex;
const SIGNED_TRANSACTION_HASH = keccak256(SIGNED_TRANSACTION);

const candidate: MegapotClaimCandidate = {
  poolLegId: "pool-leg-claim",
  drawingId: 101n,
  drawingVersion: 9,
  snapshotId: "snapshot-101",
  sweepId: "sweep-101",
  ticketId: 91n,
  expectedGrossWinningsAtomic: 1_001n,
  expectedReferralAccrualAtomic: 100n,
  expectedNetWinningsAtomic: 901n,
  referralAllocationVersion: "platform-referral-v1",
  attestationId: "megapot-base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  jackpotAddress: JACKPOT,
  usdcAddress: USDC,
  ticketNftAddress: NFT,
  custodyAddress: CUSTODY,
  referrerAddress: REFERRER,
  jackpotCodeHash: hash("6"),
  usdcCodeHash: hash("7"),
  ticketNftCodeHash: hash("8"),
};

const claimedEvent = parseAbi([
  "event TicketWinningsClaimed(address indexed userAddress, uint256 indexed drawingId, uint256 userTicketId, uint256 matchedNormals, bool bonusballMatch, uint256 winningsAmount)",
]);
const referralEvent = parseAbi([
  "event ReferralFeeCollected(address indexed referrer, uint256 amount)",
]);
const nftTransferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const usdcTransferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topics");
  return value as [Hex, ...Hex[]];
}

function receipt(): MegapotTransactionReceipt {
  const identity = {
    transactionHash: SIGNED_TRANSACTION_HASH,
    blockHash: BLOCK,
    blockNumber: 200n,
  };
  return {
    chainId: 84_532,
    status: "success",
    transactionHash: SIGNED_TRANSACTION_HASH,
    from: CUSTODY,
    to: JACKPOT,
    blockHash: BLOCK,
    blockNumber: 200n,
    logs: [
      {
        ...identity,
        address: JACKPOT,
        topics: topics(
          encodeEventTopics({
            abi: claimedEvent,
            eventName: "TicketWinningsClaimed",
            args: { userAddress: CUSTODY, drawingId: 101n },
          }),
        ),
        data: encodeAbiParameters(
          parseAbiParameters(
            "uint256 userTicketId,uint256 matchedNormals,bool bonusballMatch,uint256 winningsAmount",
          ),
          [91n, 3n, true, 901n],
        ),
        logIndex: 4,
      },
      {
        ...identity,
        address: JACKPOT,
        topics: topics(
          encodeEventTopics({
            abi: referralEvent,
            eventName: "ReferralFeeCollected",
            args: { referrer: REFERRER },
          }),
        ),
        data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [100n]),
        logIndex: 5,
      },
      {
        ...identity,
        address: NFT,
        topics: topics(
          encodeEventTopics({
            abi: nftTransferEvent,
            eventName: "Transfer",
            args: { from: CUSTODY, to: EVM_ZERO_ADDRESS, tokenId: 91n },
          }),
        ),
        data: "0x",
        logIndex: 6,
      },
      {
        ...identity,
        address: USDC,
        topics: topics(
          encodeEventTopics({
            abi: usdcTransferEvent,
            eventName: "Transfer",
            args: { from: JACKPOT, to: CUSTODY },
          }),
        ),
        data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [901n]),
        logIndex: 7,
      },
    ],
  };
}

function harness(
  options: {
    readonly uncertain?: boolean;
    readonly badBalance?: boolean;
    readonly owner?: string;
    readonly estimateFailureAt?: number;
    readonly estimateRevert?: "no_tickets_to_claim" | "not_ticket_owner";
  } = {},
) {
  let progress: MegapotClaimProgress | null = null;
  let prepared = false;
  let sendCalls = 0;
  let signCalls = 0;
  let estimateCalls = 0;
  const reviews: Parameters<MegapotClaimStore["requireReview"]>[0][] = [];
  const store = {
    findProgress: () => Effect.succeed(progress),
    loadCandidate: () => Effect.succeed(candidate),
    requireReview: (request) => {
      reviews.push(request);
      progress = null;
      return Effect.void;
    },
    reserveNonce: (request) => {
      const reservation = {
        ...request.candidate,
        effectId: request.effectId,
        nonce: 7n,
        effectVersion: 2,
        custodyBalanceBeforeAtomic: request.custodyBalanceBeforeAtomic,
        referralBalanceBeforeAtomic: request.referralBalanceBeforeAtomic,
        preflightBlockNumber: request.observedBlockNumber,
        preflightBlockHash: request.observedBlockHash,
      } as const;
      progress = { state: "nonce_reserved", reservation };
      return Effect.succeed(reservation);
    },
    prepare: (request) => {
      prepared = true;
      progress = {
        ...request.reservation,
        state: "prepared",
        calldata: request.calldata,
        calldataHash: request.calldataHash,
        signedTransaction: request.signedTransaction,
        signedTransactionHash: request.signedTransactionHash,
        transactionHash: null,
      };
      return Effect.void;
    },
    recordSubmission: (request) => {
      if (
        progress === null ||
        progress.state === "confirmed" ||
        progress.state === "nonce_reserved"
      ) {
        throw new Error("invalid progress");
      }
      progress = {
        ...progress,
        state: request.outcome === "uncertain" ? "reconciliation_required" : "broadcast_pending",
        transactionHash: request.transactionHash,
      };
      return Effect.void;
    },
    requireReconciliation: (request) => {
      if (
        progress === null ||
        progress.state === "confirmed" ||
        progress.state === "nonce_reserved"
      ) {
        throw new Error("invalid progress");
      }
      progress = {
        ...progress,
        state: "reconciliation_required",
        transactionHash: request.transactionHash,
      };
      return Effect.void;
    },
    confirm: (request) => {
      progress = {
        state: "confirmed",
        effectId: request.effectId,
        poolLegId: candidate.poolLegId,
        drawingId: candidate.drawingId,
        ticketId: candidate.ticketId,
        transactionHash: request.transactionHash,
        grossWinningsAtomic: request.grossWinningsAtomic,
        referralAccrualAtomic: request.referralAccrualAtomic,
        netWinningsAtomic: request.netWinningsAtomic,
        blockNumber: request.blockNumber,
        blockHash: request.blockHash,
        confirmations: request.confirmations,
      };
      return Effect.void;
    },
  } satisfies MegapotClaimStore;
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: candidate.jackpotCodeHash,
      ticketNftCodeHash: candidate.ticketNftCodeHash,
      usdcCodeHash: candidate.usdcCodeHash,
    }),
    readTicketPurchasesAllowed: async () => true,
    readCurrentDrawing: async () => {
      throw new Error("unused");
    },
    readCurrentDrawingId: async () => 102n,
    readDrawing: async () => {
      throw new Error("unused");
    },
    readDrawingTierPayouts: async () => {
      throw new Error("unused");
    },
    readTicketTierIds: async () => {
      throw new Error("unused");
    },
    readReferralFees: async (_account, blockNumber) => (blockNumber === 200n ? 600n : 500n),
    readUsdcBalance: async (_account, blockNumber) =>
      blockNumber === 200n ? (options.badBalance ? 1_902n : 1_901n) : 1_000n,
    readNativeBalance: async () => 1_000_000_000_000_000n,
    readUsdcAllowance: async () => 0n,
    readTicketOwner: async () => options.owner ?? CUSTODY,
    readPendingNonce: async () => 7n,
    estimateGas: async () => {
      estimateCalls += 1;
      if (estimateCalls === options.estimateFailureAt) {
        if (options.estimateRevert !== undefined) {
          throw { cause: { data: encodeMegapotV2ClaimRevert(options.estimateRevert) } };
        }
        throw new Error("provider unavailable");
      }
      return 100_000n;
    },
    readFeeQuote: async () => ({
      baseFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
      maxFeePerGas: 22n,
      observedBlockNumber: 190n,
      observedBlockHash: hash("c"),
    }),
    sendRawTransaction: async () => {
      sendCalls += 1;
      if (options.uncertain) throw new Error("unknown");
      return SIGNED_TRANSACTION_HASH;
    },
    readReceipt: async () => (prepared ? receipt() : null),
    readHead: async () => ({ blockNumber: 202n, blockHash: hash("d") }),
    readBlock: async (blockNumber) => ({
      blockNumber,
      blockHash: blockNumber === 200n ? BLOCK : hash("c"),
    }),
  } satisfies MegapotV2RpcClient;
  const signer = {
    address: CUSTODY,
    sign: async () => {
      signCalls += 1;
      return {
        signedTransaction: SIGNED_TRANSACTION,
        signedTransactionHash: SIGNED_TRANSACTION_HASH,
      };
    },
  } satisfies MegapotV2TransactionSigner;
  return {
    coordinator: makeMegapotClaimCoordinator({
      store,
      rpc,
      signer,
      requiredConfirmations: 3,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    }),
    sendCalls: () => sendCalls,
    signCalls: () => signCalls,
    reviews: () => reviews,
  };
}

describe("Megapot claim coordinator", () => {
  test("confirms exact net custody proceeds and separate referral accrual", async () => {
    const testHarness = harness();
    const result = await Effect.runPromise(
      testHarness.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(result).toMatchObject({
      kind: "confirmed",
      effectId: deriveMegapotClaimEffectId(candidate.poolLegId, 101n),
      ticketId: 91n,
      grossWinningsAtomic: 1_001n,
      referralAccrualAtomic: 100n,
      netWinningsAtomic: 901n,
      confirmations: 3,
    });
    const replay = await Effect.runPromise(
      testHarness.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(replay).toEqual(result);
    expect(testHarness.sendCalls()).toBe(1);
  });

  test("never resubmits an uncertain claim and fails closed on balance drift", async () => {
    const uncertain = harness({ uncertain: true });
    const first = await Effect.runPromise(
      uncertain.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(first.kind).toBe("reconciliation_required");
    const replay = await Effect.runPromise(
      uncertain.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(replay.kind).toBe("confirmed");
    expect(uncertain.sendCalls()).toBe(1);

    const drift = harness({ badBalance: true });
    await expect(
      Effect.runPromise(
        drift.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).resolves.toMatchObject({ kind: "reconciliation_required" });
  });

  test("persists custody mismatch before reserving a nonce", async () => {
    const testHarness = harness({ owner: address("f") });
    await expect(
      Effect.runPromise(
        testHarness.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).resolves.toMatchObject({
      kind: "operational_hold",
      reason: "ticket_owner_mismatch",
      ticketId: candidate.ticketId,
    });
    expect(testHarness.reviews()).toHaveLength(1);
    expect(testHarness.reviews()[0]).toMatchObject({
      claimEffectId: null,
      observedOwnerAddress: address("f"),
    });
    expect(testHarness.signCalls()).toBe(0);
    expect(testHarness.sendCalls()).toBe(0);
  });

  test("persists NoTicketsToClaim after nonce reservation and stops before signing", async () => {
    const testHarness = harness({
      estimateFailureAt: 2,
      estimateRevert: "no_tickets_to_claim",
    });
    const effectId = deriveMegapotClaimEffectId(candidate.poolLegId, candidate.drawingId);
    await expect(
      Effect.runPromise(
        testHarness.coordinator.claim({
          poolLegId: candidate.poolLegId,
          drawingId: candidate.drawingId,
        }),
      ),
    ).resolves.toMatchObject({
      kind: "operational_hold",
      effectId,
      reason: "no_tickets_to_claim",
    });
    expect(testHarness.reviews()).toHaveLength(1);
    expect(testHarness.reviews()[0]).toMatchObject({
      reviewId: effectId,
      claimEffectId: effectId,
      reason: "no_tickets_to_claim",
    });
    expect(testHarness.signCalls()).toBe(0);
    expect(testHarness.sendCalls()).toBe(0);
  });

  test("keeps unclassified gas-estimation failures retryable", async () => {
    const testHarness = harness({ estimateFailureAt: 1 });
    await expect(
      Effect.runPromise(
        testHarness.coordinator.claim({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).rejects.toMatchObject({ reason: "gas_estimate_failed", phase: "preflight" });
    expect(testHarness.reviews()).toHaveLength(0);
    expect(testHarness.signCalls()).toBe(0);
    expect(testHarness.sendCalls()).toBe(0);
  });
});
