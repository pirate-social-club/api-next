import { Data, type Effect } from "effect";

export class RewardPayoutStorageFailed extends Data.TaggedError("RewardPayoutStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class RewardPayoutRejected extends Data.TaggedError("RewardPayoutRejected")<{
  readonly reason:
    | "credit-not-payable"
    | "effect-conflict"
    | "not-found"
    | "recipient-pending"
    | "solvency-stale"
    | "solvency-insufficient";
}> {}

export type RewardPayoutFailure = RewardPayoutRejected | RewardPayoutStorageFailed;

export type RewardPayoutCandidate = Readonly<{
  creditId: string;
  accountId: string;
  payoutPersonaId: string;
  amountAtomic: bigint;
  walletAssignmentId: string;
  destinationAddress: string;
  solvencyObservationId: string;
  custodyBalanceBeforeAtomic: bigint;
  solvencyExpiresAt: string;
  attestationId: string;
  environment: "test" | "staging" | "production";
  chainId: number;
  usdcAddress: string;
  custodyAddress: string;
  jackpotAddress: string;
  ticketNftAddress: string;
  referrerAddress: string;
  jackpotCodeHash: string;
  usdcCodeHash: string;
  ticketNftCodeHash: string;
}>;

export type RewardPayoutReservation = RewardPayoutCandidate &
  Readonly<{
    effectId: string;
    nonce: bigint;
    effectVersion: number;
  }>;

export type RewardPreparedPayout = RewardPayoutReservation &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    calldata: string;
    calldataHash: string;
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;

export type RewardConfirmedPayout = Readonly<{
  state: "confirmed";
  effectId: string;
  creditId: string;
  transactionHash: string;
  destinationAddress: string;
  amountAtomic: bigint;
  blockNumber: bigint;
  blockHash: string;
  confirmations: number;
}>;

export type RewardPayoutProgress =
  | Readonly<{ state: "nonce_reserved"; reservation: RewardPayoutReservation }>
  | RewardPreparedPayout
  | RewardConfirmedPayout;

export interface RewardPayoutStore {
  readonly loadCandidate: (
    creditId: string,
  ) => Effect.Effect<RewardPayoutCandidate, RewardPayoutFailure>;
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<RewardPayoutProgress | null, RewardPayoutStorageFailed>;
  readonly reserveNonce: (input: {
    readonly candidate: RewardPayoutCandidate;
    readonly effectId: string;
    readonly observedPendingNonce: bigint;
    readonly observedBlockNumber: bigint;
    readonly observedBlockHash: string;
    readonly observedAt: string;
  }) => Effect.Effect<RewardPayoutReservation, RewardPayoutFailure>;
  readonly prepare: (input: {
    readonly reservation: RewardPayoutReservation;
    readonly calldata: string;
    readonly calldataHash: string;
    readonly signedTransaction: string;
    readonly signedTransactionHash: string;
    readonly preparedAt: string;
  }) => Effect.Effect<void, RewardPayoutFailure>;
  readonly recordSubmission: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly submittedAt: string;
    readonly outcome: "accepted" | "uncertain";
    readonly failureReason?: string;
  }) => Effect.Effect<void, RewardPayoutFailure>;
  readonly requireReconciliation: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, RewardPayoutFailure>;
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
  }) => Effect.Effect<void, RewardPayoutFailure>;
}
