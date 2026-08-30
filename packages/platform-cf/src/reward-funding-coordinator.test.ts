import { describe, expect, test } from "bun:test";
import type { RewardFundingIntent, RewardFundingStore } from "@pirate/application";
import { Effect } from "effect";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbi,
  parseAbiParameters,
} from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import {
  deriveRewardFundingEffectId,
  makeRewardFundingCoordinator,
} from "./reward-funding-coordinator.ts";

const address = (byte: string): Hex => `0x${byte.repeat(40)}`;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const JACKPOT = address("1");
const USDC = address("2");
const BONUS = address("d");
const NFT = address("3");
const CUSTODY = address("4");
const SENDER = address("5");
const REFERRER = address("6");
const TX = hash("a");
const BLOCK = hash("b");
const transferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topics");
  return value as [Hex, ...Hex[]];
}

function receipt(): MegapotTransactionReceipt {
  return {
    chainId: 84_532,
    status: "success",
    transactionHash: TX,
    from: SENDER,
    to: BONUS,
    blockHash: BLOCK,
    blockNumber: 200n,
    logs: [
      {
        address: BONUS,
        topics: topics(
          encodeEventTopics({
            abi: transferEvent,
            eventName: "Transfer",
            args: { from: SENDER, to: CUSTODY },
          }),
        ),
        data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [10_000n]),
        logIndex: 3,
        transactionHash: TX,
        blockHash: BLOCK,
        blockNumber: 200n,
      },
    ],
  };
}

describe("reward funding coordinator", () => {
  test("observes one user-authorized bonus-token transfer and credits the leg once", async () => {
    let intent: RewardFundingIntent | null = null;
    let confirms = 0;
    const store: RewardFundingStore = {
      plan: (input) => {
        intent = {
          ...input,
          legKind: "asset_bonus",
          recipientAddress: CUSTODY,
          state: "planned",
          transactionHash: null,
          confirmedAmountAtomic: null,
          transferLogIndex: null,
          blockNumber: null,
          blockHash: null,
          attestationId: "megapot-base-sepolia-v2",
          environment: "staging",
          chainId: 84_532,
          tokenAddress: BONUS,
          tokenDecimals: 18,
          usdcAddress: USDC,
          custodyAddress: CUSTODY,
          jackpotAddress: JACKPOT,
          ticketNftAddress: NFT,
          referrerAddress: REFERRER,
          jackpotCodeHash: hash("7"),
          usdcCodeHash: hash("8"),
          ticketNftCodeHash: hash("9"),
        };
        return Effect.succeed(intent);
      },
      find: () => Effect.succeed(intent),
      bindTransaction: (input) => {
        if (intent === null) throw new Error("missing intent");
        intent = { ...intent, state: "confirming", transactionHash: input.transactionHash };
        return Effect.succeed(intent);
      },
      confirm: (input) => {
        if (intent === null) throw new Error("missing intent");
        confirms += 1;
        intent = {
          ...intent,
          state: "confirmed",
          confirmedAmountAtomic: input.amountAtomic,
          transferLogIndex: input.transferLogIndex,
          blockNumber: input.blockNumber,
          blockHash: input.blockHash,
        };
        return Effect.void;
      },
      revert: () => Effect.void,
      requireReconciliation: () => Effect.void,
    };
    const rpc = {
      attestDeployment: async () => ({
        jackpotCodeHash: hash("7"),
        usdcCodeHash: hash("8"),
        ticketNftCodeHash: hash("9"),
      }),
      readReceipt: async () => receipt(),
      readBlock: async () => ({ blockNumber: 200n, blockHash: BLOCK }),
      readHead: async () => ({ blockNumber: 202n, blockHash: hash("c") }),
    } as unknown as MegapotV2RpcClient;
    const coordinator = makeRewardFundingCoordinator({
      store,
      rpc,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });
    const request = {
      legId: "leg-a",
      funderAccountId: "account-a",
      senderAddress: SENDER,
      expectedAmountAtomic: 10_000n,
      requiredConfirmations: 3,
      idempotencyKey: "fund-1",
    } as const;

    const planned = await Effect.runPromise(coordinator.plan(request));
    const confirmed = await Effect.runPromise(
      coordinator.observe({ fundingEffectId: planned.intent.fundingEffectId, transactionHash: TX }),
    );
    const replay = await Effect.runPromise(coordinator.reconcile(planned.intent.fundingEffectId));

    expect(confirmed).toMatchObject({
      kind: "confirmed",
      intent: { confirmedAmountAtomic: 10_000n, transferLogIndex: 3 },
    });
    expect(replay).toEqual(confirmed);
    expect(confirms).toBe(1);
    expect(planned.intent.fundingEffectId).toBe(deriveRewardFundingEffectId(request));
  });
});
