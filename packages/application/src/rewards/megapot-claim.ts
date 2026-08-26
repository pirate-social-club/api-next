import { Data, type Effect } from "effect";

export class MegapotClaimStorageFailed extends Data.TaggedError("MegapotClaimStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class MegapotClaimRejected extends Data.TaggedError("MegapotClaimRejected")<{
  readonly reason:
    | "effect-conflict"
    | "nonce-observation-stale"
    | "not-found"
    | "ticket-not-claimable";
}> {}

export type MegapotClaimFailure = MegapotClaimRejected | MegapotClaimStorageFailed;

export type MegapotClaimCandidate = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  drawingVersion: number;
  snapshotId: string;
  sweepId: string;
  ticketId: bigint;
  expectedGrossWinningsAtomic: bigint;
  expectedReferralAccrualAtomic: bigint;
  expectedNetWinningsAtomic: bigint;
  referralAllocationVersion: string;
  attestationId: string;
  environment: "test" | "staging" | "production";
  chainId: number;
  jackpotAddress: string;
  usdcAddress: string;
  ticketNftAddress: string;
  custodyAddress: string;
  referrerAddress: string;
  jackpotCodeHash: string;
  usdcCodeHash: string;
  ticketNftCodeHash: string;
}>;

export type MegapotReservedClaim = MegapotClaimCandidate &
  Readonly<{
    effectId: string;
    nonce: bigint;
    effectVersion: number;
    custodyBalanceBeforeAtomic: bigint;
    referralBalanceBeforeAtomic: bigint;
    preflightBlockNumber: bigint;
    preflightBlockHash: string;
  }>;

export type MegapotPreparedClaim = MegapotReservedClaim &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    calldata: string;
    calldataHash: string;
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;

export type MegapotConfirmedClaim = Readonly<{
  state: "confirmed";
  effectId: string;
  poolLegId: string;
  drawingId: bigint;
  ticketId: bigint;
  transactionHash: string;
  grossWinningsAtomic: bigint;
  referralAccrualAtomic: bigint;
  netWinningsAtomic: bigint;
  blockNumber: bigint;
  blockHash: string;
  confirmations: number;
}>;

export type MegapotClaimProgress =
  | Readonly<{ state: "nonce_reserved"; reservation: MegapotReservedClaim }>
  | MegapotPreparedClaim
  | MegapotConfirmedClaim;

export interface MegapotClaimStore {
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<MegapotClaimProgress | null, MegapotClaimStorageFailed>;
  readonly loadCandidate: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<MegapotClaimCandidate, MegapotClaimFailure>;
  readonly reserveNonce: (input: {
    readonly candidate: MegapotClaimCandidate;
    readonly effectId: string;
    readonly custodyBalanceBeforeAtomic: bigint;
    readonly referralBalanceBeforeAtomic: bigint;
    readonly observedPendingNonce: bigint;
    readonly observedBlockNumber: bigint;
    readonly observedBlockHash: string;
    readonly observedAt: string;
  }) => Effect.Effect<MegapotReservedClaim, MegapotClaimFailure>;
  readonly prepare: (input: {
    readonly reservation: MegapotReservedClaim;
    readonly calldata: string;
    readonly calldataHash: string;
    readonly signedTransaction: string;
    readonly signedTransactionHash: string;
    readonly preparedAt: string;
  }) => Effect.Effect<void, MegapotClaimFailure>;
  readonly recordSubmission: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly submittedAt: string;
    readonly outcome: "accepted" | "uncertain";
    readonly failureReason?: string;
  }) => Effect.Effect<void, MegapotClaimFailure>;
  readonly requireReconciliation: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, MegapotClaimFailure>;
  readonly confirm: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly claimLogIndex: number;
    readonly burnLogIndex: number;
    readonly referralLogIndex: number;
    readonly transferLogIndex: number;
    readonly grossWinningsAtomic: bigint;
    readonly referralAccrualAtomic: bigint;
    readonly netWinningsAtomic: bigint;
    readonly custodyBalanceAfterAtomic: bigint;
    readonly referralBalanceAfterAtomic: bigint;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly receiptHash: string;
    readonly confirmations: number;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, MegapotClaimFailure>;
}
