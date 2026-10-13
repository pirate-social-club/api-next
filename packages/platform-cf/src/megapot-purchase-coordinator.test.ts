import { describe, expect, test } from "bun:test";
import {
  type MegapotPreparedPurchase,
  type MegapotPurchaseCandidate,
  type MegapotPurchaseProgress,
  MegapotPurchaseStorageFailed,
  type MegapotPurchaseStore,
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
    /** A run lease the test can let lapse, optionally right after a store step. */
    lease?: { live: boolean; lapseAfter?: "reserve" | "prepare" | undefined };
    /** Makes the record of a submission fail, as a lost database write would. */
    record?: { fail: boolean };
    originalWindow?: { open: boolean; lapseAfter?: "reserve" | "prepare" };
    reserveFailure?: "constraint" | "outcome-unknown";
    pendingAdmission?: boolean;
    monotonic?: { now: number };
    beforeWindowRead?: (progress: MegapotPurchaseProgress | null) => Promise<void>;
    beforeAuthority?: (progress: MegapotPurchaseProgress | null) => Promise<void>;
  }> = {},
) {
  let progress: MegapotPurchaseProgress | null = null;
  let prepared: MegapotPreparedPurchase | null = null;
  let sendCalls = 0;
  let signCalls = 0;
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
      if (input.originalWindow?.lapseAfter === "reserve") input.originalWindow.open = false;
      if (input.reserveFailure !== undefined) {
        if (input.originalWindow !== undefined) input.originalWindow.open = false;
        return Effect.fail(new MegapotPurchaseStorageFailed({ reason: input.reserveFailure }));
      }
      if (input.lease?.lapseAfter === "reserve") input.lease.live = false;

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
      if (input.originalWindow?.lapseAfter === "prepare") input.originalWindow.open = false;
      if (input.lease?.lapseAfter === "prepare") input.lease.live = false;

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
      if (input.record?.fail)
        return Effect.fail(new MegapotPurchaseStorageFailed({ reason: "outcome-unknown" }));
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
    // A receipt exists only for a transaction that was sent.
    readReceipt: async () => (prepared === null || sendCalls === 0 ? null : receiptFor(prepared)),
    readHead: async () => ({ blockNumber: 202n, blockHash: hash("d") }),
    readBlock: async () => ({ blockNumber: 200n, blockHash: BLOCK }),
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
  const coordinator = makeMegapotPurchaseCoordinator({
    authority: {
      ensure: () =>
        Effect.gen(function* () {
          if (input.beforeAuthority !== undefined)
            yield* Effect.tryPromise({
              try: () => input.beforeAuthority?.(progress) ?? Promise.resolve(),
              catch: () => new RewardOperationsPaused({ reason: "paused" }),
            });
          if (input.lease !== undefined && !input.lease.live)
            return yield* new RewardOperationsPaused({ reason: "paused" });
        }),
    },
    store,
    readOriginalWindow: () =>
      Effect.gen(function* () {
        if (input.beforeWindowRead !== undefined)
          yield* Effect.tryPromise({
            try: () => input.beforeWindowRead?.(progress) ?? Promise.resolve(),
            catch: () => new MegapotPurchaseStorageFailed({ reason: "constraint" }),
          });
        if (input.pendingAdmission)
          return yield* new MegapotPurchaseStorageFailed({ reason: "constraint" });
        return { open: input.originalWindow?.open ?? true, remainingMilliseconds: 1_000 };
      }),
    rpc,
    signer,
    options: {
      requiredConfirmations: 3,
      purchaseSafetyMarginSeconds: 60,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => 1_800_000_000_000,
      monotonicNow: () => input.monotonic?.now ?? 0,
    },
  });
  return {
    coordinator,
    events,
    getProgress: () => progress,
    getSendCalls: () => sendCalls,
    getSignCalls: () => signCalls,
  };
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

test("pause cleanup closes an unsent expired window without requiring allowance or reserving a nonce", async () => {
  const fixture = harness({ currentDrawingId: 102n, allowance: 0n });
  expect(
    await Effect.runPromise(
      fixture.coordinator.closeUnavailable({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    ),
  ).toEqual({ kind: "closed", reason: "drawing_rolled_over" });
  expect(fixture.events).toEqual(["close:drawing_rolled_over"]);
  expect(fixture.getSendCalls()).toBe(0);
});

test("pause cleanup preserves any already-admitted purchase and never resumes it", async () => {
  const fixture = harness();
  await Effect.runPromise(
    fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
  );
  const events = [...fixture.events];
  expect(
    await Effect.runPromise(
      fixture.coordinator.closeUnavailable({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    ),
  ).toBeNull();
  expect(fixture.events).toEqual(events);
  expect(fixture.getSendCalls()).toBe(1);
});

describe("Megapot purchase under a run lease", () => {
  const command = { poolLegId: candidate.poolLegId, drawingId: 101n };
  const attempt = (fixture: ReturnType<typeof harness>) =>
    Effect.runPromise(
      fixture.coordinator.purchase(command).pipe(
        Effect.map((value) => value.kind as string),
        Effect.catch((error) => Effect.succeed(`failed:${(error as { _tag: string })._tag}`)),
      ),
    );

  test("a reservation made before expiry is not signed after it", async () => {
    const lease: { live: boolean; lapseAfter?: "reserve" | "prepare" | undefined } = {
      live: true,
      lapseAfter: "reserve",
    };
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
    const lease: { live: boolean; lapseAfter?: "reserve" | "prepare" | undefined } = {
      live: true,
      lapseAfter: "prepare",
    };
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
    const lease = { live: true };
    const record = { fail: true };
    const fixture = harness({ lease, record });
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseStorageFailed");
    expect(fixture.getSendCalls()).toBe(1);
    expect(fixture.getProgress()?.state).toBe("prepared");
    record.fail = false;
    lease.live = false;
    expect(await attempt(fixture)).toBe("confirmed");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(1);
    expect(fixture.events.filter((event) => event.startsWith("submission:"))).toEqual([
      "submission:accepted",
    ]);
  });
});

describe("original drawing purchase window", () => {
  const command = { poolLegId: candidate.poolLegId, drawingId: 101n };
  const attempt = (fixture: ReturnType<typeof harness>) =>
    Effect.runPromise(
      fixture.coordinator.purchase(command).pipe(
        Effect.map((value) => value.kind as string),
        Effect.catch((error) => Effect.succeed(`failed:${error._tag}`)),
      ),
    );

  test("a resolved original deadline closes only the original proven-unsent drawing", async () => {
    const fixture = harness({ originalWindow: { open: false } });
    expect(await attempt(fixture)).toBe("closed");
    expect(fixture.events).toEqual(["close:cutoff_safety_margin"]);
    expect(fixture.getProgress()).toBeNull();
    expect(fixture.getSignCalls()).toBe(0);
    expect(fixture.getSendCalls()).toBe(0);
  });

  test("an unresolved admission holds both purchase and no-purchase closure", async () => {
    const fixture = harness({ originalWindow: { open: false }, pendingAdmission: true });
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseStorageFailed");
    await expect(
      Effect.runPromise(fixture.coordinator.closeUnavailable(command)),
    ).rejects.toThrow();
    expect(fixture.events).toEqual([]);
    expect(fixture.getProgress()).toBeNull();
  });

  test("a deadline crossed during nonce locking closes after definite rollback only", async () => {
    const fixture = harness({ originalWindow: { open: true }, reserveFailure: "constraint" });
    expect(await attempt(fixture)).toBe("closed");
    expect(fixture.events).toEqual(["reserve", "close:cutoff_safety_margin"]);
    expect(fixture.getSignCalls()).toBe(0);
    expect(fixture.getSendCalls()).toBe(0);
  });

  test("unknown reserve COMMIT never closes or releases an original drawing", async () => {
    const fixture = harness({ originalWindow: { open: true }, reserveFailure: "outcome-unknown" });
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseStorageFailed");
    expect(fixture.events).toEqual(["reserve"]);
    expect(fixture.getSignCalls()).toBe(0);
    expect(fixture.getSendCalls()).toBe(0);
  });

  test("a retained nonce reservation cannot be signed after its original deadline", async () => {
    const fixture = harness({ originalWindow: { open: true, lapseAfter: "reserve" } });
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseCoordinatorFailed");
    expect(fixture.getProgress()?.state).toBe("nonce_reserved");
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseCoordinatorFailed");
    expect(fixture.events).toEqual(["reserve"]);
    expect(fixture.getSignCalls()).toBe(0);
    expect(fixture.getSendCalls()).toBe(0);
  });

  test("a retained signature cannot be sent after its original deadline", async () => {
    const fixture = harness({ originalWindow: { open: true, lapseAfter: "prepare" } });
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseCoordinatorFailed");
    expect(fixture.getProgress()?.state).toBe("prepared");
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseCoordinatorFailed");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(0);
    expect(fixture.events).toEqual(["reserve", "prepare"]);
  });

  test("original landed transaction recovery bypasses later window/config rejection", async () => {
    const originalWindow = { open: true };
    const record = { fail: true };
    const fixture = harness({ originalWindow, record });
    expect(await attempt(fixture)).toBe("failed:MegapotPurchaseStorageFailed");
    expect(fixture.getProgress()?.state).toBe("prepared");
    expect(fixture.getSendCalls()).toBe(1);
    record.fail = false;
    originalWindow.open = false;
    expect(await attempt(fixture)).toBe("confirmed");
    expect(fixture.getSignCalls()).toBe(1);
    expect(fixture.getSendCalls()).toBe(1);
    expect(fixture.events).not.toContain("close:cutoff_safety_margin");
  });
});

// Deferred query and authority boundaries exercise the two different waits:
// pause must be sampled AFTER the window, while the original deadline must
// still be checked synchronously AFTER the final authority response.
const purchaseBoundaryGate = () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let used = false;
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => {
      if (used) return;
      used = true;
      entered.resolve();
      await released.promise;
    },
  };
};
const finitePurchaseBoundary = async <A>(promise: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("owned purchase boundary did not settle")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

for (const phase of ["sign", "send"] as const) {
  const state = phase === "sign" ? "nonce_reserved" : "prepared";
  test(`pause during original-window wait refuses ${phase} before external IO`, async () => {
    const gate = purchaseBoundaryGate();
    const lease = { live: true };
    const fixture = harness({
      lease,
      beforeWindowRead: (progress) => (progress?.state === state ? gate.wait() : Promise.resolve()),
    });
    const original = Effect.runPromise(
      fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    ).then(
      (value) => ({ kind: "completed" as const, value }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    try {
      await finitePurchaseBoundary(gate.entered);
      lease.live = false;
      gate.release();
      const result = await finitePurchaseBoundary(original);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("pause unexpectedly admitted external IO");
      expect(result.error).toBeInstanceOf(RewardOperationsPaused);
      expect(fixture.getProgress()?.state).toBe(state);
      expect(fixture.getSignCalls()).toBe(phase === "sign" ? 0 : 1);
      expect(fixture.getSendCalls()).toBe(0);
      expect(fixture.events.some((event) => event.startsWith("submission:"))).toBe(false);
    } finally {
      gate.release();
      await finitePurchaseBoundary(original);
    }
  });

  test(`original deadline passing during final authority wait refuses ${phase}`, async () => {
    const gate = purchaseBoundaryGate();
    const monotonic = { now: 0 };
    const fixture = harness({
      monotonic,
      beforeAuthority: (progress) => (progress?.state === state ? gate.wait() : Promise.resolve()),
    });
    const original = Effect.runPromise(
      fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    ).then(
      (value) => ({ kind: "completed" as const, value }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    try {
      await finitePurchaseBoundary(gate.entered);
      monotonic.now = 1_000;
      gate.release();
      const result = await finitePurchaseBoundary(original);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed")
        throw new Error("expired original deadline admitted external IO");
      expect(result.error).toMatchObject({
        _tag: "MegapotPurchaseCoordinatorFailed",
        reason: "cutoff_safety_margin",
      });
      expect(fixture.getProgress()?.state).toBe(state);
      expect(fixture.getSignCalls()).toBe(phase === "sign" ? 0 : 1);
      expect(fixture.getSendCalls()).toBe(0);
      expect(fixture.events.some((event) => event.startsWith("submission:"))).toBe(false);
    } finally {
      gate.release();
      await finitePurchaseBoundary(original);
    }
  });
}

test("original-window round trip consumes the native deadline budget", async () => {
  const monotonic = { now: 0 };
  const fixture = harness({
    monotonic,
    beforeWindowRead: (progress) => {
      if (progress?.state === "nonce_reserved") monotonic.now = 1_001;
      return Promise.resolve();
    },
  });
  await expect(
    Effect.runPromise(
      fixture.coordinator.purchase({ poolLegId: candidate.poolLegId, drawingId: 101n }),
    ),
  ).rejects.toMatchObject({
    _tag: "MegapotPurchaseCoordinatorFailed",
    reason: "cutoff_safety_margin",
  });
  expect(fixture.getProgress()?.state).toBe("nonce_reserved");
  expect(fixture.getSignCalls()).toBe(0);
  expect(fixture.getSendCalls()).toBe(0);
});
