import { describe, expect, test } from "bun:test";
import type {
  RewardPayoutCandidate,
  RewardPayoutProgress,
  RewardPayoutStore,
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
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";
import {
  deriveRewardPayoutEffectId,
  makeRewardPayoutCoordinator,
} from "./reward-payout-coordinator.ts";

const address = (byte: string): Hex => `0x${byte.repeat(40)}`;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const JACKPOT = address("1");
const USDC = address("2");
const NFT = address("3");
const CUSTODY = address("4");
const RECIPIENT = address("5");
const REFERRER = address("6");
const BLOCK = hash("a");
const SIGNED_TRANSACTION = "0x01020304" as Hex;
const SIGNED_TRANSACTION_HASH = keccak256(SIGNED_TRANSACTION);
const transferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

const candidate: RewardPayoutCandidate = {
  creditId: "credit-901",
  accountId: "account-a",
  payoutPersonaId: "persona-a",
  amountAtomic: 901n,
  walletAssignmentId: "wallet-a",
  destinationAddress: RECIPIENT,
  solvencyObservationId: "solvency-199",
  custodyBalanceBeforeAtomic: 10_000n,
  solvencyExpiresAt: "2026-08-26T01:00:00.000Z",
  attestationId: "megapot-base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  usdcAddress: USDC,
  custodyAddress: CUSTODY,
  jackpotAddress: JACKPOT,
  ticketNftAddress: NFT,
  referrerAddress: REFERRER,
  jackpotCodeHash: hash("7"),
  usdcCodeHash: hash("8"),
  ticketNftCodeHash: hash("9"),
};

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topics");
  return value as [Hex, ...Hex[]];
}

function receipt(): MegapotTransactionReceipt {
  return {
    chainId: 84_532,
    status: "success",
    transactionHash: SIGNED_TRANSACTION_HASH,
    from: CUSTODY,
    to: USDC,
    blockHash: BLOCK,
    blockNumber: 200n,
    logs: [
      {
        address: USDC,
        topics: topics(
          encodeEventTopics({
            abi: transferEvent,
            eventName: "Transfer",
            args: { from: CUSTODY, to: RECIPIENT },
          }),
        ),
        data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [901n]),
        logIndex: 4,
        transactionHash: SIGNED_TRANSACTION_HASH,
        blockHash: BLOCK,
        blockNumber: 200n,
      },
    ],
  };
}

function harness() {
  let progress: RewardPayoutProgress | null = null;
  let sends = 0;
  const store: RewardPayoutStore = {
    loadCandidate: () => Effect.succeed(candidate),
    findProgress: () => Effect.succeed(progress),
    reserveNonce: (input) => {
      const reservation = {
        ...input.candidate,
        effectId: input.effectId,
        nonce: input.observedPendingNonce,
        effectVersion: 2,
      };
      progress = { state: "nonce_reserved", reservation };
      return Effect.succeed(reservation);
    },
    prepare: (input) => {
      progress = {
        ...input.reservation,
        state: "prepared",
        calldata: input.calldata,
        calldataHash: input.calldataHash,
        signedTransaction: input.signedTransaction,
        signedTransactionHash: input.signedTransactionHash,
        transactionHash: null,
      };
      return Effect.void;
    },
    recordSubmission: (input) => {
      if (progress === null || progress.state !== "prepared") throw new Error("invalid progress");
      progress = {
        ...progress,
        state: input.outcome === "accepted" ? "broadcast_pending" : "reconciliation_required",
        transactionHash: input.transactionHash,
      };
      return Effect.void;
    },
    requireReconciliation: (input) => {
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
        transactionHash: input.transactionHash,
      };
      return Effect.void;
    },
    confirm: (input) => {
      progress = {
        state: "confirmed",
        effectId: input.effectId,
        creditId: candidate.creditId,
        transactionHash: input.transactionHash,
        destinationAddress: candidate.destinationAddress,
        amountAtomic: input.amountAtomic,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        confirmations: input.confirmations,
      };
      return Effect.void;
    },
  };
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: candidate.jackpotCodeHash,
      ticketNftCodeHash: candidate.ticketNftCodeHash,
      usdcCodeHash: candidate.usdcCodeHash,
    }),
    readFeeQuote: async () => ({
      baseFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      observedBlockNumber: 199n,
      observedBlockHash: hash("b"),
    }),
    readBlock: async (blockNumber: bigint) => ({
      blockNumber,
      blockHash: blockNumber === 200n ? BLOCK : hash("b"),
    }),
    readUsdcBalance: async (_account: string, blockNumber?: bigint) =>
      blockNumber === 200n ? 9_099n : 10_000n,
    readPendingNonce: async () => 12n,
    estimateGas: async () => 50_000n,
    readNativeBalance: async () => 1_000_000n,
    sendRawTransaction: async () => {
      sends += 1;
      return SIGNED_TRANSACTION_HASH;
    },
    readReceipt: async () => receipt(),
    readHead: async () => ({ blockNumber: 202n, blockHash: hash("c") }),
  } as unknown as MegapotV2RpcClient;
  const signer: MegapotV2TransactionSigner = {
    address: CUSTODY,
    sign: async () => ({
      signedTransaction: SIGNED_TRANSACTION,
      signedTransactionHash: SIGNED_TRANSACTION_HASH,
    }),
  };
  return { store, rpc, signer, sends: () => sends };
}

describe("reward payout coordinator", () => {
  test("pays one credited liability exactly once and replays the confirmed receipt", async () => {
    const state = harness();
    const coordinator = makeRewardPayoutCoordinator({
      store: state.store,
      rpc: state.rpc,
      signer: state.signer,
      requiredConfirmations: 3,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });

    const first = await Effect.runPromise(coordinator.payout(candidate.creditId));
    const replay = await Effect.runPromise(coordinator.payout(candidate.creditId));

    expect(first).toMatchObject({
      kind: "confirmed",
      creditId: candidate.creditId,
      amountAtomic: 901n,
      destinationAddress: RECIPIENT,
    });
    expect(replay).toEqual(first);
    expect(state.sends()).toBe(1);
    expect(deriveRewardPayoutEffectId(candidate.creditId) as string).toBe(first.effectId);
  });
});
