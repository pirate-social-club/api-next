import { Data, Effect } from "effect";

/**
 * Owner decision 2026-09-25: a Megapot winner whose claimed USDC was paid to
 * their persona's embedded EOA may receive a bounded, platform-funded native
 * gas top-up from a platform gas wallet that is never Megapot custody.
 */

export class RewardGasTopupStorageFailed extends Data.TaggedError("RewardGasTopupStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class RewardGasTopupRejected extends Data.TaggedError("RewardGasTopupRejected")<{
  readonly reason:
    | "credit-not-eligible"
    | "effect-conflict"
    | "gas-wallet-unavailable"
    | "idempotency-conflict"
    | "not-found"
    | "recipient-pending";
}> {}

export class RewardGasTopupBalanceUnavailable extends Data.TaggedError(
  "RewardGasTopupBalanceUnavailable",
)<{
  readonly reason: "rpc-unavailable";
}> {}

export type RewardGasTopupFailure = RewardGasTopupRejected | RewardGasTopupStorageFailed;

export type RewardGasTopupStatus = "requested" | "broadcast" | "confirmed" | "released";

export type RewardGasTopupLimits = Readonly<{
  targetBalanceWei: bigint;
  maxTopupWei: bigint;
  accountDailyCount: number;
  platformDailyWei: bigint;
}>;

/** A paid, claimed credit and the wallet a top-up would fund. */
export type RewardGasTopupRequestContext = Readonly<{
  creditId: string;
  accountId: string;
  personaId: string;
  walletAssignmentId: string;
  recipientAddress: string;
  chainId: number;
}>;

export type RewardGasTopupView = Readonly<{
  topupId: string;
  creditId: string;
  status: RewardGasTopupStatus;
  amountWei: bigint;
  transactionHash: string | null;
}>;

export type RewardGasTopupReservation =
  | Readonly<{ kind: "reserved" | "replayed" | "open"; topup: RewardGasTopupView }>
  | Readonly<{ kind: "limit_reached" }>;

export interface RewardGasTopupRequestStore {
  readonly findByIdempotencyKey: (input: {
    readonly accountId: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<RewardGasTopupView | null, RewardGasTopupFailure>;
  readonly loadRequestContext: (input: {
    readonly accountId: string;
    readonly creditId: string;
  }) => Effect.Effect<RewardGasTopupRequestContext, RewardGasTopupFailure>;
  /**
   * In one transaction: replay by idempotency key, reuse an open top-up for
   * the same recipient, enforce the per-account daily count and the platform
   * daily budget for the current UTC day, then insert a requested row.
   */
  readonly reserve: (input: {
    readonly context: RewardGasTopupRequestContext;
    readonly topupId: string;
    readonly idempotencyKey: string;
    readonly balanceBeforeWei: bigint;
    readonly targetBalanceWei: bigint;
    readonly amountWei: bigint;
    readonly accountDailyCount: number;
    readonly platformDailyWei: bigint;
  }) => Effect.Effect<RewardGasTopupReservation, RewardGasTopupFailure>;
  readonly get: (input: {
    readonly accountId: string;
    readonly topupId: string;
  }) => Effect.Effect<RewardGasTopupView | null, RewardGasTopupFailure>;
}

export type RewardGasTopupRequestResult = Readonly<{
  status: "not_needed" | "pending" | "limit_reached";
  topupId: string | null;
  amountWei: bigint | null;
}>;

export interface RewardGasTopupRequester {
  readonly request: (input: {
    readonly accountId: string;
    readonly creditId: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<
    RewardGasTopupRequestResult,
    RewardGasTopupFailure | RewardGasTopupBalanceUnavailable
  >;
  readonly get: (input: {
    readonly accountId: string;
    readonly topupId: string;
  }) => Effect.Effect<RewardGasTopupView, RewardGasTopupFailure>;
}

export function validRewardGasTopupLimits(limits: RewardGasTopupLimits): boolean {
  return (
    limits.targetBalanceWei > 0n &&
    limits.maxTopupWei > 0n &&
    limits.maxTopupWei <= limits.targetBalanceWei &&
    Number.isSafeInteger(limits.accountDailyCount) &&
    limits.accountDailyCount >= 1 &&
    limits.platformDailyWei >= limits.maxTopupWei
  );
}

const pending = (topup: RewardGasTopupView): RewardGasTopupRequestResult => ({
  status: "pending",
  topupId: topup.topupId,
  amountWei: topup.amountWei,
});

/**
 * The account and credit always come from the authenticated session and the
 * path; the wallet is the credit's payout persona's active EVM assignment.
 */
export function makeRewardGasTopupRequester(input: {
  readonly store: RewardGasTopupRequestStore;
  readonly readNativeBalance: (
    address: string,
  ) => Effect.Effect<bigint, RewardGasTopupBalanceUnavailable>;
  readonly limits: RewardGasTopupLimits;
  readonly ids: Readonly<{ next: Effect.Effect<string> }>;
}): RewardGasTopupRequester {
  if (!validRewardGasTopupLimits(input.limits)) {
    throw new Error("invalid reward gas top-up limits");
  }
  const { limits } = input;
  const request = Effect.fn("RewardGasTopupRequester.request")(function* (request: {
    readonly accountId: string;
    readonly creditId: string;
    readonly idempotencyKey: string;
  }) {
    const replay = yield* input.store.findByIdempotencyKey(request);
    if (replay !== null) {
      if (replay.creditId !== request.creditId) {
        return yield* new RewardGasTopupRejected({ reason: "idempotency-conflict" });
      }
      return pending(replay);
    }
    const context = yield* input.store.loadRequestContext(request);
    const balance = yield* input.readNativeBalance(context.recipientAddress);
    if (balance < 0n)
      return yield* new RewardGasTopupBalanceUnavailable({ reason: "rpc-unavailable" });
    const shortfall = limits.targetBalanceWei - balance;
    if (shortfall <= 0n) {
      return { status: "not_needed", topupId: null, amountWei: null } as const;
    }
    const amountWei = shortfall < limits.maxTopupWei ? shortfall : limits.maxTopupWei;
    const topupId = `gas-topup_${yield* input.ids.next}`;
    const reservation = yield* input.store.reserve({
      context,
      topupId,
      idempotencyKey: request.idempotencyKey,
      balanceBeforeWei: balance,
      targetBalanceWei: limits.targetBalanceWei,
      amountWei,
      accountDailyCount: limits.accountDailyCount,
      platformDailyWei: limits.platformDailyWei,
    });
    if (reservation.kind === "limit_reached") {
      return { status: "limit_reached", topupId: null, amountWei: null } as const;
    }
    if (reservation.kind === "replayed" && reservation.topup.creditId !== request.creditId) {
      return yield* new RewardGasTopupRejected({ reason: "idempotency-conflict" });
    }
    return pending(reservation.topup);
  });
  const get = Effect.fn("RewardGasTopupRequester.get")(function* (request: {
    readonly accountId: string;
    readonly topupId: string;
  }) {
    const topup = yield* input.store.get(request);
    if (topup === null) return yield* new RewardGasTopupRejected({ reason: "not-found" });
    return topup;
  });
  return { request, get };
}

/* Send side: the jobs cycle sends requested top-ups from the gas wallet. */

export type RewardGasTopupCandidate = Readonly<{
  topupId: string;
  accountId: string;
  creditId: string;
  recipientAddress: string;
  chainId: number;
  amountWei: bigint;
  targetBalanceWei: bigint;
  signerAddress: string;
}>;

export type RewardGasTopupReservedEffect = RewardGasTopupCandidate &
  Readonly<{ effectId: string; nonce: bigint; effectVersion: number }>;

export type RewardGasTopupPreparedEffect = RewardGasTopupReservedEffect &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;

export type RewardGasTopupProgress =
  | Readonly<{ state: "nonce_reserved"; reservation: RewardGasTopupReservedEffect }>
  | RewardGasTopupPreparedEffect
  | Readonly<{
      state: "confirmed";
      effectId: string;
      topupId: string;
      transactionHash: string | null;
    }>
  | Readonly<{
      /** Covers a reverted receipt and any terminal failure. */
      state: "released";
      effectId: string;
      topupId: string;
      transactionHash: string | null;
    }>;

export interface RewardGasTopupSendStore {
  /** The chain's active gas wallet signer address, or null when none is registered. */
  readonly loadActiveSigner: (
    chainId: number,
  ) => Effect.Effect<string | null, RewardGasTopupFailure>;
  readonly listOpen: (limit: number) => Effect.Effect<readonly string[], RewardGasTopupFailure>;
  readonly loadCandidate: (
    topupId: string,
  ) => Effect.Effect<RewardGasTopupCandidate, RewardGasTopupFailure>;
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<RewardGasTopupProgress | null, RewardGasTopupFailure>;
  /** Releases a requested top-up that never reserved a nonce, returning its budget. */
  readonly releaseUnsent: (input: {
    readonly topupId: string;
    readonly reason: string;
  }) => Effect.Effect<void, RewardGasTopupFailure>;
  readonly reserveNonce: (input: {
    readonly candidate: RewardGasTopupCandidate;
    readonly effectId: string;
    readonly observedPendingNonce: bigint;
    readonly observedBlockNumber: bigint;
    readonly observedBlockHash: string;
    readonly observedAt: string;
  }) => Effect.Effect<RewardGasTopupReservedEffect, RewardGasTopupFailure>;
  readonly prepare: (input: {
    readonly reservation: RewardGasTopupReservedEffect;
    readonly calldataHash: string;
    readonly signedTransaction: string;
    readonly signedTransactionHash: string;
    readonly preparedAt: string;
  }) => Effect.Effect<void, RewardGasTopupFailure>;
  readonly recordSubmission: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly submittedAt: string;
    readonly outcome: "accepted" | "uncertain";
    readonly failureReason?: string;
  }) => Effect.Effect<void, RewardGasTopupFailure>;
  readonly requireReconciliation: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, RewardGasTopupFailure>;
  readonly confirm: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly receiptHash: string;
    readonly confirmations: number;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, RewardGasTopupFailure>;
  /** A confirmed reverted receipt: terminal failure, top-up released and budget returned. */
  readonly recordReverted: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly receiptHash: string;
    readonly confirmations: number;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, RewardGasTopupFailure>;
}
