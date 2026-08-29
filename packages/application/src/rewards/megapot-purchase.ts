import type { MegapotTicket } from "@pirate/domain";
import { Data, type Effect } from "effect";

export type MegapotPurchaseStorageReason =
  | "conflict"
  | "constraint"
  | "invalid-row"
  | "outcome-unknown"
  | "unavailable";

export class MegapotPurchaseStorageFailed extends Data.TaggedError("MegapotPurchaseStorageFailed")<{
  readonly reason: MegapotPurchaseStorageReason;
}> {}

export class MegapotPurchaseRejected extends Data.TaggedError("MegapotPurchaseRejected")<{
  readonly reason:
    | "drawing-not-committed"
    | "effect-conflict"
    | "insufficient-budget"
    | "nonce-observation-stale"
    | "not-found";
}> {}

export type MegapotPurchaseFailure = MegapotPurchaseRejected | MegapotPurchaseStorageFailed;

export type MegapotPreBroadcastCloseReason =
  | "cutoff_safety_margin"
  | "drawing_locked"
  | "drawing_rolled_over";

export type MegapotPurchaseCandidate = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  drawingVersion: number;
  observationId: string;
  snapshotId: string;
  commitmentEffectId: string;
  ticketPriceAtomic: bigint;
  ballMax: number;
  bonusballMax: number;
  sourceTag: string;
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

export type MegapotReservedPurchase = MegapotPurchaseCandidate &
  Readonly<{
    effectId: string;
    nonce: bigint;
    effectVersion: number;
    ticket: MegapotTicket;
  }>;

export type MegapotPreparedPurchase = MegapotReservedPurchase &
  Readonly<{
    state: "prepared" | "broadcast_pending" | "confirming" | "reconciliation_required";
    calldata: string;
    calldataHash: string;
    signedTransaction: string;
    signedTransactionHash: string;
    transactionHash: string | null;
  }>;

export type MegapotConfirmedPurchase = Readonly<{
  state: "confirmed";
  effectId: string;
  poolLegId: string;
  drawingId: bigint;
  transactionHash: string;
  ticketId: bigint;
  blockNumber: bigint;
  blockHash: string;
  confirmations: number;
}>;

export type MegapotPurchaseProgress =
  | Readonly<{ state: "nonce_reserved"; reservation: MegapotReservedPurchase }>
  | MegapotPreparedPurchase
  | MegapotConfirmedPurchase;

export interface MegapotPurchaseStore {
  readonly findProgress: (
    effectId: string,
  ) => Effect.Effect<MegapotPurchaseProgress | null, MegapotPurchaseStorageFailed>;
  readonly loadCandidate: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<MegapotPurchaseCandidate, MegapotPurchaseFailure>;
  readonly closePreBroadcast: (input: {
    readonly candidate: MegapotPurchaseCandidate;
    readonly reason: MegapotPreBroadcastCloseReason;
    readonly failedAt: string;
  }) => Effect.Effect<void, MegapotPurchaseFailure>;
  readonly reserveNonce: (input: {
    readonly candidate: MegapotPurchaseCandidate;
    readonly effectId: string;
    readonly ticket: MegapotTicket;
    readonly observedPendingNonce: bigint;
    readonly observedBlockNumber: bigint;
    readonly observedBlockHash: string;
    readonly observedAt: string;
  }) => Effect.Effect<MegapotReservedPurchase, MegapotPurchaseFailure>;
  readonly prepare: (input: {
    readonly reservation: MegapotReservedPurchase;
    readonly ticket: MegapotTicket;
    readonly calldata: string;
    readonly calldataHash: string;
    readonly signedTransaction: string;
    readonly signedTransactionHash: string;
    readonly preparedAt: string;
  }) => Effect.Effect<void, MegapotPurchaseFailure>;
  readonly recordSubmission: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly submittedAt: string;
    readonly outcome: "accepted" | "uncertain";
    readonly failureReason?: string;
  }) => Effect.Effect<void, MegapotPurchaseFailure>;
  readonly requireReconciliation: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly reason: string;
  }) => Effect.Effect<void, MegapotPurchaseFailure>;
  readonly confirm: (input: {
    readonly effectId: string;
    readonly transactionHash: string;
    readonly ticketId: bigint;
    readonly purchaseLogIndex: number;
    readonly mintLogIndex: number;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly receiptHash: string;
    readonly confirmations: number;
    readonly referralFeesAtomic: bigint;
    readonly lpEarningsAtomic: bigint;
    readonly confirmedAt: string;
  }) => Effect.Effect<void, MegapotPurchaseFailure>;
}
