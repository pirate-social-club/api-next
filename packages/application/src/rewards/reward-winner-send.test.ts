import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  computeRewardWinnerSendStatus,
  encodeRewardWinnerSendCalldata,
  makeRewardWinnerSendService,
  matchesRewardWinnerSendCancellation,
  matchesRewardWinnerSendTransaction,
  type RewardWinnerSendChain,
  type RewardWinnerSendChainTransaction,
  type RewardWinnerSendObservation,
  type RewardWinnerSendReceipt,
  type RewardWinnerSendRecord,
  RewardWinnerSendRejected,
  type RewardWinnerSendStore,
} from "./reward-winner-send.ts";

const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const SENDER = address("a1");
const RECIPIENT = address("d1");
const TOKEN = address("0a");

const record: RewardWinnerSendRecord = {
  sendId: "winner-send_1",
  creditId: "credit-1",
  accountId: "account-1",
  status: "retryable",
  chainId: 84_532,
  senderAddress: SENDER,
  recipientAddress: RECIPIENT,
  tokenAddress: TOKEN,
  amountAtomic: 400_000n,
  nonce: 5n,
  attempt: 1,
  transactionHashes: [],
  cancellationHashes: [],
};

const receipt = (overrides: Partial<RewardWinnerSendReceipt> = {}): RewardWinnerSendReceipt => ({
  transactionHash: hash("f1"),
  status: "success",
  blockNumber: 100n,
  blockHash: hash("b0"),
  transfers: [{ tokenAddress: TOKEN, from: SENDER, to: RECIPIENT, amountAtomic: 400_000n }],
  ...overrides,
});

const observation = (
  overrides: Partial<RewardWinnerSendObservation> = {},
): RewardWinnerSendObservation => ({
  headBlockNumber: 102n,
  finalizedBlockNumber: 102n,
  latestNonce: 5n,
  confirmedNonce: 5n,
  receipts: [],
  reorganizedHashes: [],
  knownHashes: [],
  ...overrides,
});

const compute = (
  current: Partial<RewardWinnerSendRecord>,
  observed: Partial<RewardWinnerSendObservation>,
) =>
  computeRewardWinnerSendStatus({
    record: { ...record, ...current },
    requiredConfirmations: 3,
    observation: observation(observed),
  });

describe("winner send status rules", () => {
  test("retryable only while nothing is mined for the nonce and no hash was accepted", () => {
    expect(compute({}, {})).toEqual({ status: "retryable" });
    expect(compute({ transactionHashes: [hash("f1")] }, { knownHashes: [hash("f1")] })).toEqual({
      status: "pending",
    });
    // The nonce mined above the depth: wait.
    expect(compute({}, { latestNonce: 6n })).toEqual({ status: "pending" });
  });

  test("pending only while the node still knows an accepted hash; a dropped one is retryable", () => {
    const hashes = { transactionHashes: [hash("f1"), hash("f2")] };
    expect(compute(hashes, { knownHashes: [hash("f2")] })).toEqual({ status: "pending" });
    // Every accepted hash dropped and the nonce unmined: re-sign the same nonce.
    expect(compute(hashes, {})).toEqual({ status: "retryable" });
    // A hash the server never accepted keeps nothing pending.
    expect(compute(hashes, { knownHashes: [hash("f3")] })).toEqual({ status: "retryable" });
  });

  test("settled_unverified when the nonce is consumed at depth without a known receipt", () => {
    expect(compute({}, { latestNonce: 6n, confirmedNonce: 6n })).toMatchObject({
      outcome: "settled_unverified",
      observedConfirmedNonce: 6n,
    });
    expect(
      compute({ transactionHashes: [hash("f1")] }, { latestNonce: 6n, confirmedNonce: 6n }),
    ).toMatchObject({ outcome: "settled_unverified" });
  });

  test("confirmed only at depth with exactly the transfer log", () => {
    const hashes = { transactionHashes: [hash("f1")] };
    const mined = { latestNonce: 6n, confirmedNonce: 6n };
    expect(compute(hashes, { ...mined, receipts: [receipt()], headBlockNumber: 101n })).toEqual({
      status: "pending",
    });
    expect(compute(hashes, { ...mined, receipts: [receipt()] })).toEqual({
      outcome: "confirmed",
      transactionHash: hash("f1"),
      blockNumber: 100n,
      blockHash: hash("b0"),
      observedHeadBlockNumber: 102n,
      observedConfirmedNonce: 6n,
      confirmations: 3,
    });
    for (const transfers of [
      [],
      [{ tokenAddress: TOKEN, from: SENDER, to: RECIPIENT, amountAtomic: 1n }],
      [{ tokenAddress: address("0b"), from: SENDER, to: RECIPIENT, amountAtomic: 400_000n }],
      [
        { tokenAddress: TOKEN, from: SENDER, to: RECIPIENT, amountAtomic: 400_000n },
        { tokenAddress: TOKEN, from: SENDER, to: RECIPIENT, amountAtomic: 400_000n },
      ],
    ]) {
      expect(compute(hashes, { ...mined, receipts: [receipt({ transfers })] })).toMatchObject({
        outcome: "settled_unverified",
      });
    }
  });

  test("reverted only at depth, and an unaccepted or reorganized receipt never settles", () => {
    const hashes = { transactionHashes: [hash("f1")] };
    const reverted = receipt({ status: "reverted", transfers: [] });
    expect(
      compute(hashes, { latestNonce: 6n, receipts: [reverted], headBlockNumber: 100n }),
    ).toEqual({ status: "pending" });
    expect(
      compute(hashes, { latestNonce: 6n, confirmedNonce: 6n, receipts: [reverted] }),
    ).toMatchObject({ outcome: "reverted", transactionHash: hash("f1") });
    // A receipt for a hash the server never accepted is ignored.
    expect(compute({}, { receipts: [receipt()] })).toEqual({ status: "retryable" });
    expect(
      compute(hashes, {
        latestNonce: 6n,
        confirmedNonce: 6n,
        reorganizedHashes: [hash("f1")],
      }),
    ).toEqual({ status: "pending" });
    expect(
      compute(
        { transactionHashes: [hash("f1"), hash("f2")] },
        { receipts: [receipt(), receipt({ transactionHash: hash("f2") })] },
      ),
    ).toEqual({ status: "pending" });
    expect(
      compute(
        { transactionHashes: [hash("f1"), hash("f2")] },
        {
          latestNonce: 6n,
          confirmedNonce: 6n,
          reorganizedHashes: [hash("f1")],
          receipts: [receipt({ transactionHash: hash("f2") })],
        },
      ),
    ).toMatchObject({ outcome: "confirmed", transactionHash: hash("f2") });
  });

  test("no terminal outcome is recorded before the receipt or nonce is finalized", () => {
    const hashes = { transactionHashes: [hash("f1")] };
    const unfinalized = {
      headBlockNumber: 120n,
      finalizedBlockNumber: 99n,
      latestNonce: 6n,
      confirmedNonce: 5n,
    };
    expect(compute(hashes, { ...unfinalized, receipts: [receipt()] })).toEqual({
      status: "pending",
    });
    expect(
      compute(hashes, {
        ...unfinalized,
        receipts: [receipt({ status: "reverted", transfers: [] })],
      }),
    ).toEqual({ status: "pending" });
    expect(compute({}, unfinalized)).toEqual({ status: "pending" });
    expect(
      compute(hashes, {
        ...unfinalized,
        finalizedBlockNumber: 100n,
        confirmedNonce: 6n,
        receipts: [receipt()],
      }),
    ).toMatchObject({ outcome: "confirmed" });
  });
});

describe("winner send cancellation", () => {
  const cancellation = receipt({ transactionHash: hash("c1"), transfers: [] });
  const both = { transactionHashes: [hash("f1")], cancellationHashes: [hash("c1")] };
  const mined = { latestNonce: 6n, confirmedNonce: 6n };

  test("a cancellation receipt at depth cancels; the transfer receipt confirms instead", () => {
    expect(compute(both, { ...mined, receipts: [cancellation] })).toMatchObject({
      outcome: "cancelled",
      transactionHash: hash("c1"),
    });
    expect(compute(both, { ...mined, receipts: [cancellation], headBlockNumber: 101n })).toEqual({
      status: "pending",
    });
    expect(compute(both, { ...mined, receipts: [receipt()] })).toMatchObject({
      outcome: "confirmed",
      transactionHash: hash("f1"),
    });
    // A reverted cancellation moved nothing and still consumed the nonce.
    expect(
      compute(both, { ...mined, receipts: [{ ...cancellation, status: "reverted" }] }),
    ).toMatchObject({ outcome: "cancelled" });
    // A "cancellation" whose receipt moved the token is never a cancel.
    expect(
      compute(both, {
        ...mined,
        receipts: [
          receipt({
            transactionHash: hash("c1"),
            transfers: [{ tokenAddress: TOKEN, from: SENDER, to: address("e1"), amountAtomic: 1n }],
          }),
        ],
      }),
    ).toMatchObject({ outcome: "settled_unverified" });
    // An unmined cancellation still known to the node keeps the send pending.
    expect(compute({ cancellationHashes: [hash("c1")] }, { knownHashes: [hash("c1")] })).toEqual({
      status: "pending",
    });
  });

  test("accepts only a zero-value, empty-calldata self-transaction at the nonce", () => {
    const transaction: RewardWinnerSendChainTransaction = {
      transactionHash: hash("c1"),
      chainId: 84_532,
      from: SENDER,
      to: SENDER,
      nonce: 5n,
      valueWei: 0n,
      input: "0x",
    };
    expect(matchesRewardWinnerSendCancellation(transaction, record)).toBe(true);
    for (const change of [
      { to: RECIPIENT },
      { to: TOKEN },
      { to: null },
      { valueWei: 1n },
      { input: "0x00" },
      { input: encodeRewardWinnerSendCalldata(RECIPIENT, 1n) },
      { nonce: 6n },
      { from: address("a2") },
      { chainId: 8_453 },
    ]) {
      expect(matchesRewardWinnerSendCancellation({ ...transaction, ...change }, record)).toBe(
        false,
      );
    }
  });
});

describe("winner send transaction match", () => {
  const transaction: RewardWinnerSendChainTransaction = {
    transactionHash: hash("f1"),
    chainId: 84_532,
    from: SENDER.toUpperCase().replace("0X", "0x"),
    to: TOKEN,
    nonce: 5n,
    valueWei: 0n,
    input: encodeRewardWinnerSendCalldata(RECIPIENT, 400_000n),
  };

  test("encodes transfer(recipient, amount)", () => {
    expect(encodeRewardWinnerSendCalldata(RECIPIENT, 400_000n)).toBe(
      `0xa9059cbb${"0".repeat(24)}${"d1".repeat(20)}${(400_000).toString(16).padStart(64, "0")}`,
    );
    expect(() => encodeRewardWinnerSendCalldata(RECIPIENT, 0n)).toThrow();
  });

  test("accepts only the exact transfer at the record's nonce", () => {
    expect(matchesRewardWinnerSendTransaction(transaction, record)).toBe(true);
    for (const change of [
      { nonce: 6n },
      { chainId: 8_453 },
      { chainId: null },
      { from: address("a2") },
      { to: null },
      { to: address("0b") },
      { valueWei: 1n },
      { input: encodeRewardWinnerSendCalldata(address("d2"), 400_000n) },
      { input: encodeRewardWinnerSendCalldata(RECIPIENT, 400_001n) },
      { input: `${encodeRewardWinnerSendCalldata(RECIPIENT, 400_000n)}00` },
    ]) {
      expect(matchesRewardWinnerSendTransaction({ ...transaction, ...change }, record)).toBe(false);
    }
  });
});

function fixture(options: { existing?: RewardWinnerSendRecord; pendingNonce?: bigint } = {}) {
  const calls: string[] = [];
  let stored: RewardWinnerSendRecord | null = options.existing ?? null;
  const store: RewardWinnerSendStore = {
    findByKey: () => Effect.succeed(null),
    findByCredit: () => Effect.succeed(stored),
    get: () => Effect.succeed(stored),
    loadContext: ({ accountId, creditId }) =>
      Effect.succeed({
        creditId,
        accountId,
        personaId: "persona-1",
        walletAssignmentId: "assignment-1",
        senderAddress: SENDER,
        tokenAddress: TOKEN,
        chainId: 84_532,
        paidAtomic: 1_000_000n,
      }),
    create: (input) =>
      Effect.gen(function* () {
        const nonce = yield* input.readNonce;
        calls.push(`create:${nonce}`);
        stored = {
          ...record,
          sendId: input.sendId,
          recipientAddress: input.recipientAddress,
          amountAtomic: input.amountAtomic,
          nonce,
        };
        return stored;
      }),
    startAttempt: (input) =>
      Effect.gen(function* () {
        const previous = stored as RewardWinnerSendRecord;
        const nonce = yield* input.readNonce;
        if (nonce <= previous.nonce) {
          return yield* new RewardWinnerSendRejected({ reason: "nonce-not-consumed" });
        }
        calls.push(`attempt:${input.previousAttempt + 1}:${nonce}`);
        stored = {
          ...previous,
          status: "retryable",
          attempt: input.previousAttempt + 1,
          nonce,
          recipientAddress: input.recipientAddress,
          amountAtomic: input.amountAtomic,
          transactionHashes: [],
        };
        return stored;
      }),
    attachTransaction: () => Effect.die("unexpected"),
    recordStatus: (input) =>
      Effect.sync(() => {
        calls.push(`status:${input.status}`);
      }),
    recordOutcome: (input) =>
      Effect.sync(() => {
        calls.push(`outcome:${input.outcome}`);
        return "recorded" as const;
      }),
    recoverOutcome: () => Effect.die("unexpected"),
  };
  const chain: RewardWinnerSendChain = {
    readPendingNonce: () => Effect.succeed(options.pendingNonce ?? 5n),
    readTransaction: () => Effect.succeed(null),
    readHead: () => Effect.succeed(102n),
    readFinalizedHead: () => Effect.succeed(102n),
    readTransactionCount: () => Effect.succeed(5n),
    readReceipt: () => Effect.succeed(null),
  };
  const service = makeRewardWinnerSendService({
    store,
    chain,
    requiredConfirmations: 3,
    ids: { next: Effect.succeed("id") },
  });
  const request = (overrides: { recipient?: string; amount?: bigint } = {}) =>
    service.request({
      accountId: "account-1",
      creditId: "credit-1",
      recipientAddress: overrides.recipient ?? RECIPIENT,
      amountAtomic: overrides.amount ?? 400_000n,
      idempotencyKey: "key-1",
    });
  return { calls, service, request };
}

describe("winner send service", () => {
  test("records a new send with the sender's pending nonce", async () => {
    const { calls, request } = fixture({ pendingNonce: 7n });
    expect(await Effect.runPromise(request())).toMatchObject({
      sendId: "winner-send_id",
      nonce: 7n,
      status: "retryable",
    });
    expect(calls).toEqual(["create:7"]);
  });

  test("refuses invalid recipients and amounts before any chain read", async () => {
    const { calls, request } = fixture();
    for (const recipient of [`0x${"00".repeat(20)}`, SENDER, TOKEN, "0x12"]) {
      expect(await Effect.runPromise(Effect.flip(request({ recipient })))).toEqual(
        new RewardWinnerSendRejected({ reason: "invalid-recipient" }),
      );
    }
    for (const amount of [0n, 1_000_001n]) {
      expect(await Effect.runPromise(Effect.flip(request({ amount })))).toEqual(
        new RewardWinnerSendRejected({ reason: "invalid-amount" }),
      );
    }
    expect(calls).toEqual([]);
  });

  test("a different body for an open record is a conflict, a reverted one starts an attempt", async () => {
    const open = fixture({ existing: record });
    expect(await Effect.runPromise(Effect.flip(open.request({ amount: 1n })))).toMatchObject({
      reason: "send-conflict",
    });
    expect(await Effect.runPromise(open.request())).toMatchObject({ status: "retryable" });

    const reverted = fixture({ existing: { ...record, status: "reverted" }, pendingNonce: 5n });
    expect(await Effect.runPromise(Effect.flip(reverted.request({ amount: 1n })))).toMatchObject({
      reason: "nonce-not-consumed",
    });
    const retried = fixture({ existing: { ...record, status: "reverted" }, pendingNonce: 6n });
    expect(await Effect.runPromise(retried.request({ amount: 1n }))).toMatchObject({
      attempt: 2,
      nonce: 6n,
      amountAtomic: 1n,
    });
    expect(retried.calls).toEqual(["attempt:2:6"]);
  });

  test("terminal records are returned without chain reads or new attempts", async () => {
    for (const status of ["confirmed", "settled_unverified"] as const) {
      const { calls, service } = fixture({ existing: { ...record, status } });
      expect(
        await Effect.runPromise(service.get({ accountId: "account-1", sendId: record.sendId })),
      ).toMatchObject({ status });
      expect(calls).toEqual([]);
    }
  });

  test("attaching refuses an unknown transaction and a confirmed or reverted record", async () => {
    const open = fixture({ existing: record });
    expect(
      await Effect.runPromise(
        Effect.flip(
          open.service.attachTransaction({
            accountId: "account-1",
            sendId: record.sendId,
            transactionHash: hash("f1"),
          }),
        ),
      ),
    ).toMatchObject({ reason: "transaction-not-found" });
    for (const status of ["confirmed", "reverted"] as const) {
      const settled = fixture({ existing: { ...record, status } });
      expect(
        await Effect.runPromise(
          Effect.flip(
            settled.service.attachTransaction({
              accountId: "account-1",
              sendId: record.sendId,
              transactionHash: hash("f1"),
            }),
          ),
        ),
      ).toMatchObject({ reason: "send-conflict" });
    }
    // settled_unverified still verifies a late hash: unknown to the node here.
    const unverified = fixture({ existing: { ...record, status: "settled_unverified" } });
    expect(
      await Effect.runPromise(
        Effect.flip(
          unverified.service.attachTransaction({
            accountId: "account-1",
            sendId: record.sendId,
            transactionHash: hash("f1"),
          }),
        ),
      ),
    ).toMatchObject({ reason: "transaction-not-found" });
  });
});
