import { Data, type Effect } from "effect";

export class MegapotApprovalStorageFailed extends Data.TaggedError("MegapotApprovalStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class MegapotApprovalRejected extends Data.TaggedError("MegapotApprovalRejected")<{
  readonly reason: "effect-conflict" | "not-found" | "nonce-observation-stale";
}> {}

export type MegapotApprovalFailure = MegapotApprovalRejected | MegapotApprovalStorageFailed;

export type MegapotApprovalCandidate = Readonly<{
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

export type MegapotReservedApproval = MegapotApprovalCandidate &
  Readonly<{
    effectId: string;
    nonce: bigint;
    effectVersion: number;
    allowanceBeforeAtomic: bigint;
    minimumAllowanceAtomic: bigint;
    approvedAmountAtomic: bigint;
  }>;

export type MegapotPreparedApproval = MegapotReservedApproval &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    calldata: string;
    calldataHash: string;
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;

export type MegapotConfirmedApproval = Readonly<{
  state: "confirmed";
  effectId: string;
  attestationId: string;
  transactionHash: string;
  approvedAmountAtomic: bigint;
  allowanceAfterAtomic: bigint;
  blockNumber: bigint;
  blockHash: string;
  confirmations: number;
}>;

export type MegapotApprovalProgress =
  | Readonly<{ state: "nonce_reserved"; reservation: MegapotReservedApproval }>
  | MegapotPreparedApproval
  | MegapotConfirmedApproval;

export interface MegapotApprovalStore {
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<MegapotApprovalProgress | null, MegapotApprovalStorageFailed>;
  readonly loadCandidate: (
    attestationId: string,
  ) => Effect.Effect<MegapotApprovalCandidate, MegapotApprovalFailure>;
  readonly reserveNonce: (input: {
    readonly candidate: MegapotApprovalCandidate;
    readonly effectId: string;
    readonly allowanceBeforeAtomic: bigint;
    readonly minimumAllowanceAtomic: bigint;
    readonly approvedAmountAtomic: bigint;
    readonly observedPendingNonce: bigint;
    readonly observedBlockNumber: bigint;
    readonly observedBlockHash: string;
    readonly observedAt: string;
  }) => Effect.Effect<MegapotReservedApproval, MegapotApprovalFailure>;
  readonly prepare: (input: {
    readonly reservation: MegapotReservedApproval;
    readonly calldata: string;
    readonly calldataHash: string;
    readonly signedTransaction: string;
    readonly signedTransactionHash: string;
    readonly preparedAt: string;
  }) => Effect.Effect<void, MegapotApprovalFailure>;
  readonly recordSubmission: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly submittedAt: string;
    readonly outcome: "accepted" | "uncertain";
    readonly failureReason?: string;
  }) => Effect.Effect<void, MegapotApprovalFailure>;
  readonly requireReconciliation: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, MegapotApprovalFailure>;
  readonly confirm: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly approvalLogIndex: number;
    readonly approvedAmountAtomic: bigint;
    readonly allowanceAfterAtomic: bigint;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly receiptHash: string;
    readonly confirmations: number;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, MegapotApprovalFailure>;
}
