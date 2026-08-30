import { Data, type Effect } from "effect";

export class RewardRefundStorageFailed extends Data.TaggedError("RewardRefundStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class RewardRefundRejected extends Data.TaggedError("RewardRefundRejected")<{
  readonly reason:
    | "contribution-not-refundable"
    | "effect-conflict"
    | "not-found"
    | "solvency-stale"
    | "solvency-insufficient";
}> {}

export type RewardRefundFailure = RewardRefundRejected | RewardRefundStorageFailed;

export type RewardRefundCandidate = Readonly<{
  fundingEffectId: string;
  legId: string;
  funderAccountId: string;
  amountAtomic: bigint;
  destinationAddress: string;
  proRataNumeratorAtomic: bigint;
  proRataDenominatorAtomic: bigint;
  solvencyObservationId: string;
  custodyBalanceBeforeAtomic: bigint;
  solvencyExpiresAt: string;
  attestationId: string;
  environment: "test" | "staging" | "production";
  chainId: number;
  tokenAddress: string;
  usdcAddress: string;
  custodyAddress: string;
  jackpotAddress: string;
  ticketNftAddress: string;
  referrerAddress: string;
  jackpotCodeHash: string;
  usdcCodeHash: string;
  ticketNftCodeHash: string;
}>;

export type RewardRefundReservation = RewardRefundCandidate &
  Readonly<{
    effectId: string;
    nonce: bigint;
    effectVersion: number;
  }>;

export type RewardPreparedRefund = RewardRefundReservation &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    calldata: string;
    calldataHash: string;
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;

export type RewardConfirmedRefund = Readonly<{
  state: "confirmed";
  effectId: string;
  fundingEffectId: string;
  legId: string;
  transactionHash: string;
  destinationAddress: string;
  amountAtomic: bigint;
  blockNumber: bigint;
  blockHash: string;
  confirmations: number;
}>;

export type RewardRefundProgress =
  | Readonly<{ state: "nonce_reserved"; reservation: RewardRefundReservation }>
  | RewardPreparedRefund
  | RewardConfirmedRefund;

export interface RewardRefundStore {
  readonly loadCandidate: (
    fundingEffectId: string,
  ) => Effect.Effect<RewardRefundCandidate, RewardRefundFailure>;
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<RewardRefundProgress | null, RewardRefundStorageFailed>;
  readonly reserveNonce: (input: {
    readonly candidate: RewardRefundCandidate;
    readonly effectId: string;
    readonly observedPendingNonce: bigint;
    readonly observedBlockNumber: bigint;
    readonly observedBlockHash: string;
    readonly observedAt: string;
  }) => Effect.Effect<RewardRefundReservation, RewardRefundFailure>;
  readonly prepare: (input: {
    readonly reservation: RewardRefundReservation;
    readonly calldata: string;
    readonly calldataHash: string;
    readonly signedTransaction: string;
    readonly signedTransactionHash: string;
    readonly preparedAt: string;
  }) => Effect.Effect<void, RewardRefundFailure>;
  readonly recordSubmission: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly submittedAt: string;
    readonly outcome: "accepted" | "uncertain";
    readonly failureReason?: string;
  }) => Effect.Effect<void, RewardRefundFailure>;
  readonly requireReconciliation: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, RewardRefundFailure>;
  readonly confirm: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly transferLogIndex: number;
    readonly amountAtomic: bigint;
    readonly custodyBalanceAfterAtomic: bigint;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly receiptHash: string;
    readonly confirmations: number;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, RewardRefundFailure>;
}
