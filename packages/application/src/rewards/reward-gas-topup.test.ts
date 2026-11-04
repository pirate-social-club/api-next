import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  makeRewardGasTopupRequester,
  type RewardGasTopupRequestStore,
  type RewardGasTopupView,
} from "./reward-gas-topup.ts";

const limits = {
  targetBalanceWei: 50_000n,
  maxTopupWei: 30_000n,
  accountDailyCount: 3,
  platformDailyWei: 1_000_000n,
};

function fixture(balance: bigint, existing: RewardGasTopupView | null = null) {
  const reserved: bigint[] = [];
  const store: RewardGasTopupRequestStore = {
    findByIdempotencyKey: () => Effect.succeed(existing),
    loadRequestContext: ({ accountId, creditId }) =>
      Effect.succeed({
        creditId,
        accountId,
        personaId: "persona-1",
        walletAssignmentId: "assignment-1",
        recipientAddress: `0x${"a1".repeat(20)}`,
        chainId: 84_532,
      }),
    reserve: (input) =>
      Effect.sync(() => {
        reserved.push(input.amountWei);
        return {
          kind: "reserved" as const,
          topup: {
            topupId: input.topupId,
            creditId: input.context.creditId,
            status: "requested" as const,
            amountWei: input.amountWei,
            transactionHash: null,
          },
        };
      }),
    get: () => Effect.succeed(null),
  };
  const requester = makeRewardGasTopupRequester({
    store,
    readNativeBalance: () => Effect.succeed(balance),
    limits,
    ids: { next: Effect.succeed("1") },
  });
  const request = (creditId = "credit-1") =>
    requester.request({ accountId: "winner", creditId, idempotencyKey: "key-1" });
  return { requester, request, reserved };
}

describe("reward gas top-up requester", () => {
  test("tops up only the shortfall, capped per transfer", async () => {
    const small = fixture(40_000n);
    expect(await Effect.runPromise(small.request())).toEqual({
      status: "pending",
      topupId: "gas-topup_1",
      amountWei: 10_000n,
    });
    const empty = fixture(0n);
    expect((await Effect.runPromise(empty.request())).amountWei).toBe(30_000n);
  });

  test("reserves nothing when the balance already meets the target", async () => {
    const full = fixture(50_000n);
    expect(await Effect.runPromise(full.request())).toEqual({
      status: "not_needed",
      topupId: null,
      amountWei: null,
    });
    expect(full.reserved).toEqual([]);
  });

  test("replays an idempotency key only for the same credit", async () => {
    const existing = {
      topupId: "gas-topup_old",
      creditId: "credit-1",
      status: "confirmed" as const,
      amountWei: 7n,
      transactionHash: null,
    };
    const replay = fixture(0n, existing);
    expect(await Effect.runPromise(replay.request())).toEqual({
      status: "pending",
      topupId: "gas-topup_old",
      amountWei: 7n,
    });
    expect(await Effect.runPromise(Effect.flip(replay.request("credit-2")))).toMatchObject({
      reason: "idempotency-conflict",
    });
    expect(replay.reserved).toEqual([]);
  });

  test("returns not-found for another account's or an unknown top-up", async () => {
    expect(
      await Effect.runPromise(
        Effect.flip(fixture(0n).requester.get({ accountId: "winner", topupId: "missing" })),
      ),
    ).toMatchObject({ reason: "not-found" });
  });

  test("rejects inconsistent limits", () => {
    expect(() =>
      makeRewardGasTopupRequester({
        store: {} as RewardGasTopupRequestStore,
        readNativeBalance: () => Effect.succeed(0n),
        limits: { ...limits, maxTopupWei: 60_000n },
        ids: { next: Effect.succeed("1") },
      }),
    ).toThrow("invalid reward gas top-up limits");
  });
});
