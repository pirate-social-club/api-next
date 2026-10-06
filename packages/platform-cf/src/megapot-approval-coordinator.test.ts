import { describe, expect, test } from "bun:test";
import {
  type MegapotApprovalCandidate,
  type MegapotApprovalProgress,
  MegapotApprovalStorageFailed,
  type MegapotApprovalStore,
  type MegapotPreparedApproval,
  RewardOperationsPaused,
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
  deriveMegapotApprovalEffectId,
  makeMegapotApprovalCoordinator,
} from "./megapot-approval-coordinator.ts";
import type { MegapotReceiptLog, MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";

const address = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const JACKPOT = address("1");
const NFT = address("2");
const USDC = address("3");
const CUSTODY = address("4");
const REFERRER = address("5");
const BLOCK = hash("6");
const SIGNED_TRANSACTION = "0x0304" as Hex;
const SIGNED_TRANSACTION_HASH = keccak256(SIGNED_TRANSACTION);
const APPROVED_AMOUNT = 100_000n;

const approvalEvent = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

const candidate: MegapotApprovalCandidate = {
  attestationId: "base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  jackpotAddress: JACKPOT,
  usdcAddress: USDC,
  ticketNftAddress: NFT,
  custodyAddress: CUSTODY,
  referrerAddress: REFERRER,
  jackpotCodeHash: hash("7"),
  usdcCodeHash: hash("8"),
  ticketNftCodeHash: hash("9"),
};

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topics");
  return value as [Hex, ...Hex[]];
}

function approvalReceipt(approval: MegapotPreparedApproval): MegapotTransactionReceipt {
  const transactionHash = approval.transactionHash ?? approval.signedTransactionHash;
  const log: MegapotReceiptLog = {
    address: USDC,
    topics: topics(
      encodeEventTopics({
        abi: approvalEvent,
        eventName: "Approval",
        args: { owner: CUSTODY, spender: JACKPOT },
      }),
    ),
    data: encodeAbiParameters(parseAbiParameters("uint256 value"), [APPROVED_AMOUNT]),
    logIndex: 2,
    transactionHash,
    blockHash: BLOCK,
    blockNumber: 300n,
  };
  return {
    chainId: 84_532,
    status: "success",
    transactionHash,
    from: CUSTODY,
    to: USDC,
    blockHash: BLOCK,
    blockNumber: 300n,
    logs: [log],
  };
}

function harness(
  options: Readonly<{
    initialAllowance?: bigint;
    uncertainSend?: boolean;
    /** A run lease the test can let lapse, optionally right after a store step. */
    lease?: { live: boolean; lapseAfter?: "reserve" | "prepare" | undefined };
    /** Makes the record of a submission fail, as a lost database write would. */
    record?: { fail: boolean };
  }> = {},
) {
  let progress: MegapotApprovalProgress | null = null;
  let prepared: MegapotPreparedApproval | null = null;
  let sendCalls = 0;
  let signCalls = 0;
  let allowanceCalls = 0;
  const events: string[] = [];
  const store = {
    findProgress: () => Effect.succeed(progress),
    loadCandidate: () => Effect.succeed(candidate),
    reserveNonce: (request) => {
      events.push("reserve");
      const reservation = {
        ...request.candidate,
        effectId: request.effectId,
        nonce: request.observedPendingNonce,
        effectVersion: 2,
        allowanceBeforeAtomic: request.allowanceBeforeAtomic,
        minimumAllowanceAtomic: request.minimumAllowanceAtomic,
        approvedAmountAtomic: request.approvedAmountAtomic,
      } as const;
      if (options.lease?.lapseAfter === "reserve") options.lease.live = false;
      progress = { state: "nonce_reserved", reservation };
      return Effect.succeed(reservation);
    },
    prepare: (request) => {
      events.push("prepare");
      if (options.lease?.lapseAfter === "prepare") options.lease.live = false;
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
      if (options.record?.fail)
        return Effect.fail(new MegapotApprovalStorageFailed({ reason: "outcome-unknown" }));
      events.push(`submission:${request.outcome}`);
      if (prepared === null) throw new Error("approval was not prepared");
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
      if (prepared === null) throw new Error("approval was not prepared");
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
        attestationId: candidate.attestationId,
        transactionHash: request.transactionHash,
        approvedAmountAtomic: request.approvedAmountAtomic,
        allowanceAfterAtomic: request.allowanceAfterAtomic,
        blockNumber: request.blockNumber,
        blockHash: request.blockHash,
        confirmations: request.confirmations,
      };
      return Effect.void;
    },
  } satisfies MegapotApprovalStore;
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
    readCurrentDrawingId: async () => {
      throw new Error("unused");
    },
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
    readUsdcAllowance: async () => {
      allowanceCalls += 1;
      return allowanceCalls === 1 ? (options.initialAllowance ?? 0n) : APPROVED_AMOUNT;
    },
    readTicketOwner: async () => CUSTODY,
    readPendingNonce: async () => 11n,
    estimateGas: async () => 50_000n,
    readFeeQuote: async () => ({
      baseFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
      maxFeePerGas: 22n,
      observedBlockNumber: 290n,
      observedBlockHash: hash("a"),
    }),
    sendRawTransaction: async () => {
      sendCalls += 1;
      events.push("send");
      if (options.uncertainSend) throw new Error("unknown");
      return SIGNED_TRANSACTION_HASH;
    },
    // A receipt exists only for a transaction that was sent.
    readReceipt: async () =>
      prepared === null || sendCalls === 0 ? null : approvalReceipt(prepared),
    readHead: async () => ({ blockNumber: 302n, blockHash: hash("b") }),
    readBlock: async () => ({ blockNumber: 300n, blockHash: BLOCK }),
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
  const coordinator = makeMegapotApprovalCoordinator({
    authority: {
      ensure: () =>
        Effect.suspend(() =>
          options.lease === undefined || options.lease.live
            ? Effect.void
            : Effect.fail(new RewardOperationsPaused({ reason: "paused" })),
        ),
    },
    store,
    rpc,
    signer,
    requiredConfirmations: 3,
    gasLimitMultiplierBps: 12_000,
    nativeGasReserveFloorWei: 1_000n,
    now: () => 1_800_000_000_000,
  });
  return {
    coordinator,
    events,
    getProgress: () => progress,
    getSendCalls: () => sendCalls,
    getSignCalls: () => signCalls,
  };
}

describe("Megapot USDC approval coordinator", () => {
  test("confirms the exact approval only after allowance and receipt evidence agree", async () => {
    const fixture = harness();
    const result = await Effect.runPromise(
      fixture.coordinator.approve({
        attestationId: candidate.attestationId,
        minimumAllowanceAtomic: 10_000n,
        approvedAmountAtomic: APPROVED_AMOUNT,
      }),
    );
    expect(result).toMatchObject({
      kind: "confirmed",
      effectId: deriveMegapotApprovalEffectId(candidate.attestationId, APPROVED_AMOUNT),
      approvedAmountAtomic: APPROVED_AMOUNT,
      allowanceAfterAtomic: APPROVED_AMOUNT,
    });
    expect(fixture.events).toEqual([
      "reserve",
      "prepare",
      "send",
      "submission:accepted",
      "confirm",
    ]);
  });

  test("does not create an effect when the existing allowance is sufficient", async () => {
    const fixture = harness({ initialAllowance: APPROVED_AMOUNT });
    await expect(
      Effect.runPromise(
        fixture.coordinator.approve({
          attestationId: candidate.attestationId,
          minimumAllowanceAtomic: 10_000n,
          approvedAmountAtomic: APPROVED_AMOUNT,
        }),
      ),
    ).resolves.toEqual({
      kind: "not_required",
      attestationId: candidate.attestationId,
      allowanceAtomic: APPROVED_AMOUNT,
    });
    expect(fixture.events).toEqual([]);
  });

  test("never broadcasts a second approval after an uncertain submission", async () => {
    const fixture = harness({ uncertainSend: true });
    const first = await Effect.runPromise(
      fixture.coordinator.approve({
        attestationId: candidate.attestationId,
        minimumAllowanceAtomic: 10_000n,
        approvedAmountAtomic: APPROVED_AMOUNT,
      }),
    );
    expect(first).toMatchObject({ kind: "reconciliation_required" });
    expect(fixture.getSendCalls()).toBe(1);
    await Effect.runPromise(
      fixture.coordinator.approve({
        attestationId: candidate.attestationId,
        minimumAllowanceAtomic: 10_000n,
        approvedAmountAtomic: APPROVED_AMOUNT,
      }),
    );
    expect(fixture.getSendCalls()).toBe(1);
  });
});

describe("Megapot USDC approval under a run lease", () => {
  const command = {
    attestationId: candidate.attestationId,
    minimumAllowanceAtomic: 10_000n,
    approvedAmountAtomic: APPROVED_AMOUNT,
  };
  const attempt = (fixture: ReturnType<typeof harness>) =>
    Effect.runPromise(
      fixture.coordinator.approve(command).pipe(
        Effect.map((value) => value.kind as string),
        Effect.catch((error) => Effect.succeed(`failed:${(error as { _tag: string })._tag}`)),
      ),
    );
  type Lease = { live: boolean; lapseAfter?: "reserve" | "prepare" | undefined };

  test("a reservation made before expiry is not signed after it", async () => {
    const lease: Lease = { live: true, lapseAfter: "reserve" };
    const fixture = harness({ lease });
    expect(await attempt(fixture)).toBe("failed:RewardOperationsPaused");
    expect(fixture.getProgress()?.state).toBe("nonce_reserved");
    // Resumed after expiry: still neither signed nor sent.
    expect(await attempt(fixture)).toBe("failed:RewardOperationsPaused");
    expect(fixture.getSignCalls()).toBe(0);
    expect(fixture.getSendCalls()).toBe(0);
    lease.lapseAfter = undefined;
    lease.live = true;
    expect(await attempt(fixture)).toBe("confirmed");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(1);
  });

  test("a signature stored before expiry is not sent after it, and is not recorded as uncertain", async () => {
    const lease: Lease = { live: true, lapseAfter: "prepare" };
    const fixture = harness({ lease });
    expect(await attempt(fixture)).toBe("failed:RewardOperationsPaused");
    expect(await attempt(fixture)).toBe("failed:RewardOperationsPaused");
    expect(fixture.getProgress()?.state).toBe("prepared");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(0);
    expect(fixture.events.filter((event) => event.startsWith("submission:"))).toEqual([]);
    lease.lapseAfter = undefined;
    lease.live = true;
    expect(await attempt(fixture)).toBe("confirmed");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(1);
  });

  test("a send that succeeded but was never recorded is recovered after expiry with no signature or send", async () => {
    const lease: Lease = { live: true };
    const record = { fail: true };
    const fixture = harness({ lease, record });
    expect(await attempt(fixture)).toBe("failed:MegapotApprovalStorageFailed");
    expect(fixture.getSendCalls()).toBe(1);
    expect(fixture.getProgress()?.state).toBe("prepared");
    record.fail = false;
    lease.live = false;
    expect(await attempt(fixture)).toBe("confirmed");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(1);
    expect(fixture.events.filter((event) => event.startsWith("submission:"))).toHaveLength(1);
  });

  test("both signing branches ask: a new reservation and a resumed one", async () => {
    // The first attempt reserves and reaches the signature on the new-reservation
    // branch; later attempts find the reservation and reach it on the resumed branch.
    const lease: Lease = { live: true, lapseAfter: "reserve" };
    const fixture = harness({ lease });
    expect(await attempt(fixture)).toBe("failed:RewardOperationsPaused");
    expect(fixture.events).toEqual(["reserve"]);
    expect(await attempt(fixture)).toBe("failed:RewardOperationsPaused");
    // No second reservation was made: the second refusal came from the resumed branch.
    expect(fixture.events).toEqual(["reserve"]);
    expect(fixture.getSignCalls()).toBe(0);
    lease.lapseAfter = undefined;
    lease.live = true;
    expect(await attempt(fixture)).toBe("confirmed");
    expect(fixture.events).toEqual([
      "reserve",
      "prepare",
      "send",
      "submission:accepted",
      "confirm",
    ]);
  });
});
