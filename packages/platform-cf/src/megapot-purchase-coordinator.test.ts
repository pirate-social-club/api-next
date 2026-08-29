import { describe, expect, test } from "bun:test";
import type {
  MegapotPreparedPurchase,
  MegapotPurchaseCandidate,
  MegapotPurchaseProgress,
  MegapotPurchaseStore,
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
  deriveMegapotPurchaseEffectId,
  makeMegapotPurchaseCoordinator,
} from "./megapot-purchase-coordinator.ts";
import {
  EVM_ZERO_ADDRESS,
  type MegapotReceiptLog,
  type MegapotTransactionReceipt,
} from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

const address = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const JACKPOT = address("1");
const NFT = address("2");
const USDC = address("3");
const CUSTODY = address("4");
const REFERRER = address("5");
const SOURCE = hash("6");
const BLOCK = hash("7");
const SIGNED_TRANSACTION = "0x0102" as Hex;
const SIGNED_TRANSACTION_HASH = keccak256(SIGNED_TRANSACTION);

const ticketPurchasedEvent = parseAbi([
  "event TicketPurchased(address indexed recipient, uint256 indexed currentDrawingId, bytes32 indexed source, uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme)",
]);
const ticketOrderProcessedEvent = parseAbi([
  "event TicketOrderProcessed(address indexed buyer, address indexed recipient, uint256 indexed currentDrawingId, uint256 numberOfTickets, uint256 lpEarnings, uint256 referralFees)",
]);
const transferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

const candidate: MegapotPurchaseCandidate = {
  poolLegId: "pool-leg-1",
  drawingId: 101n,
  drawingVersion: 3,
  observationId: "observation-101",
  snapshotId: "snapshot-101",
  commitmentEffectId: "commitment-101",
  ticketPriceAtomic: 10_000n,
  ballMax: 25,
  bonusballMax: 13,
  sourceTag: SOURCE,
  attestationId: "base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  jackpotAddress: JACKPOT,
  usdcAddress: USDC,
  ticketNftAddress: NFT,
  custodyAddress: CUSTODY,
  referrerAddress: REFERRER,
  jackpotCodeHash: hash("8"),
  usdcCodeHash: hash("9"),
  ticketNftCodeHash: hash("a"),
};

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topics");
  return value as [Hex, ...Hex[]];
}

function receiptFor(purchase: MegapotPreparedPurchase): MegapotTransactionReceipt {
  const transactionHash = purchase.transactionHash ?? purchase.signedTransactionHash;
  const base = (input: {
    readonly address: string;
    readonly topics: [Hex, ...Hex[]];
    readonly data: Hex;
    readonly logIndex: number;
  }): MegapotReceiptLog => ({
    ...input,
    transactionHash,
    blockHash: BLOCK,
    blockNumber: 200n,
  });
  return {
    chainId: 84_532,
    status: "success",
    transactionHash,
    from: CUSTODY,
    to: JACKPOT,
    blockHash: BLOCK,
    blockNumber: 200n,
    logs: [
      base({
        address: JACKPOT,
        topics: topics(
          encodeEventTopics({
            abi: ticketPurchasedEvent,
            eventName: "TicketPurchased",
            args: { recipient: CUSTODY, currentDrawingId: 101n, source: SOURCE },
          }),
        ),
        data: encodeAbiParameters(
          parseAbiParameters(
            "uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme",
          ),
          [501n, [...purchase.ticket.normals], purchase.ticket.bonusball, hash("b")],
        ),
        logIndex: 3,
      }),
      base({
        address: JACKPOT,
        topics: topics(
          encodeEventTopics({
            abi: ticketOrderProcessedEvent,
            eventName: "TicketOrderProcessed",
            args: { buyer: CUSTODY, recipient: CUSTODY, currentDrawingId: 101n },
          }),
        ),
        data: encodeAbiParameters(
          parseAbiParameters("uint256 numberOfTickets, uint256 lpEarnings, uint256 referralFees"),
          [1n, 900n, 100n],
        ),
        logIndex: 4,
      }),
      base({
        address: NFT,
        topics: topics(
          encodeEventTopics({
            abi: transferEvent,
            eventName: "Transfer",
            args: { from: EVM_ZERO_ADDRESS, to: CUSTODY, tokenId: 501n },
          }),
        ),
        data: "0x",
        logIndex: 5,
      }),
    ],
  };
}

function harness(
  input: Readonly<{
    allowance?: bigint;
    currentDrawingId?: bigint;
    uncertainSend?: boolean;
  }> = {},
) {
  let progress: MegapotPurchaseProgress | null = null;
  let prepared: MegapotPreparedPurchase | null = null;
  let sendCalls = 0;
  const events: string[] = [];
  const store = {
    findProgress: () => Effect.succeed(progress),
    loadCandidate: () => Effect.succeed(candidate),
    closePreBroadcast: (request) => {
      events.push(`close:${request.reason}`);
      return Effect.void;
    },
    reserveNonce: (request) => {
      events.push("reserve");
      const reservation = {
        ...request.candidate,
        effectId: request.effectId,
        nonce: request.observedPendingNonce,
        effectVersion: 2,
        ticket: request.ticket,
      } as const;
      progress = { state: "nonce_reserved", reservation };
      return Effect.succeed(reservation);
    },
    prepare: (request) => {
      events.push("prepare");
      prepared = {
        ...request.reservation,
        state: "prepared",
        calldata: request.calldata,
        calldataHash: request.calldataHash,
        signedTransaction: request.signedTransaction,
        signedTransactionHash: request.signedTransactionHash,
        transactionHash: null,
      };
      progress = prepared;
      return Effect.void;
    },
    recordSubmission: (request) => {
      events.push(`submission:${request.outcome}`);
      if (prepared === null) throw new Error("purchase was not prepared");
      prepared = {
        ...prepared,
        state: request.outcome === "accepted" ? "broadcast_pending" : "reconciliation_required",
        transactionHash: request.transactionHash,
      };
      progress = prepared;
      return Effect.void;
    },
    requireReconciliation: (request) => {
      events.push(`reconciliation:${request.reason}`);
      if (prepared === null) throw new Error("purchase was not prepared");
      prepared = {
        ...prepared,
        state: "reconciliation_required",
        transactionHash: request.transactionHash,
      };
      progress = prepared;
      return Effect.void;
    },
    confirm: (request) => {
      events.push("confirm");
      progress = {
        state: "confirmed",
        effectId: request.effectId,
        poolLegId: candidate.poolLegId,
        drawingId: candidate.drawingId,
        transactionHash: request.transactionHash,
        ticketId: request.ticketId,
        blockNumber: request.blockNumber,
        blockHash: request.blockHash,
        confirmations: request.confirmations,
      };
      return Effect.void;
    },
  } satisfies MegapotPurchaseStore;
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: candidate.jackpotCodeHash,
      ticketNftCodeHash: candidate.ticketNftCodeHash,
      usdcCodeHash: candidate.usdcCodeHash,
    }),
    readTicketPurchasesAllowed: async () => true,
    readCurrentDrawing: async () => ({
      drawingId: input.currentDrawingId ?? 101n,
      state: {
        prizePool: 1_000_000n,
        ticketPrice: 10_000n,
        edgePerTicket: 1_000n,
        referralWinShare: 100_000_000_000_000_000n,
        referralFee: 100_000_000_000_000_000n,
        globalTicketsBought: 10n,
        lpEarnings: 900n,
        drawingTime: 2_000_000_000n,
        winningTicket: 0n,
        ballMax: 25,
        bonusballMax: 13,
        payoutCalculator: address("6"),
        jackpotLock: false,
      },
    }),
    readCurrentDrawingId: async () => 101n,
    readDrawing: async () => {
      throw new Error("unused");
    },
    readDrawingTierPayouts: async () => {
      throw new Error("unused");
    },
    readTicketTierIds: async () => {
      throw new Error("unused");
    },
    readReferralFees: async () => 0n,
    readUsdcBalance: async () => 1_000_000n,
    readNativeBalance: async () => 1_000_000_000_000_000n,
    readUsdcAllowance: async () => input.allowance ?? 1_000_000n,
    readTicketOwner: async () => CUSTODY,
    readPendingNonce: async () => 7n,
    estimateGas: async () => 200_000n,
    readFeeQuote: async () => ({
      baseFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
      maxFeePerGas: 22n,
      observedBlockNumber: 190n,
      observedBlockHash: hash("c"),
    }),
    sendRawTransaction: async () => {
      sendCalls += 1;
      events.push("send");
      if (input.uncertainSend) throw new Error("unknown");
      return SIGNED_TRANSACTION_HASH;
    },
    readReceipt: async () => (prepared === null ? null : receiptFor(prepared)),
    readHead: async () => ({ blockNumber: 202n, blockHash: hash("d") }),
    readBlock: async () => ({ blockNumber: 200n, blockHash: BLOCK }),
  } satisfies MegapotV2RpcClient;
  const signer = {
    address: CUSTODY,
    sign: async () => ({
      signedTransaction: SIGNED_TRANSACTION,
      signedTransactionHash: SIGNED_TRANSACTION_HASH,
    }),
  } satisfies MegapotV2TransactionSigner;
  const coordinator = makeMegapotPurchaseCoordinator({
    store,
    rpc,
    signer,
    options: {
      requiredConfirmations: 3,
      purchaseSafetyMarginSeconds: 60,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => 1_800_000_000_000,
    },
  });
  return { coordinator, events, getProgress: () => progress, getSendCalls: () => sendCalls };
}

describe("Megapot purchase coordinator", () => {
  test("persists exact bytes before submission and confirms the custodied NFT", async () => {
    const fixture = harness();
    const result = await Effect.runPromise(
      fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(result).toMatchObject({
      kind: "confirmed",
      effectId: deriveMegapotPurchaseEffectId(candidate.poolLegId, 101n),
      ticketId: 501n,
      confirmations: 3,
    });
    expect(fixture.events).toEqual([
      "reserve",
      "prepare",
      "send",
      "submission:accepted",
      "confirm",
    ]);
    expect(fixture.events.indexOf("prepare")).toBeLessThan(fixture.events.indexOf("send"));
  });

  test("fails before nonce reservation when USDC allowance is insufficient", async () => {
    const fixture = harness({ allowance: 9_999n });
    await expect(
      Effect.runPromise(
        fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).rejects.toMatchObject({ reason: "allowance_insufficient", phase: "preflight" });
    expect(fixture.events).toEqual([]);
  });

  test("closes a rolled-over drawing before reserving a nonce", async () => {
    const fixture = harness({ currentDrawingId: 102n });
    await expect(
      Effect.runPromise(
        fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
      ),
    ).resolves.toEqual({ kind: "closed", reason: "drawing_rolled_over" });
    expect(fixture.events).toEqual(["close:drawing_rolled_over"]);
  });

  test("an uncertain broadcast retains transaction identity and is never sent twice", async () => {
    const fixture = harness({ uncertainSend: true });
    const first = await Effect.runPromise(
      fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(first).toEqual({
      kind: "reconciliation_required",
      effectId: deriveMegapotPurchaseEffectId(candidate.poolLegId, 101n),
      transactionHash: SIGNED_TRANSACTION_HASH,
    });
    expect(fixture.getSendCalls()).toBe(1);
    const progress = fixture.getProgress();
    expect(progress).toMatchObject({
      state: "reconciliation_required",
      transactionHash: SIGNED_TRANSACTION_HASH,
    });
    await Effect.runPromise(
      fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    );
    expect(fixture.getSendCalls()).toBe(1);
  });
});
