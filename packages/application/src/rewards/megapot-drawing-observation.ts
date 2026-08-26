import { Data, type Effect } from "effect";

export type MegapotDrawingObservationStorageReason =
  | "conflict"
  | "constraint"
  | "invalid-row"
  | "outcome-unknown"
  | "unavailable";

export class MegapotDrawingObservationStorageFailed extends Data.TaggedError(
  "MegapotDrawingObservationStorageFailed",
)<{ readonly reason: MegapotDrawingObservationStorageReason }> {}

export class MegapotDrawingObservationRejected extends Data.TaggedError(
  "MegapotDrawingObservationRejected",
)<{
  readonly reason:
    | "attestation-not-found"
    | "deployment-attestation-mismatch"
    | "drawing-closed"
    | "invalid-block-time"
    | "production-disabled";
}> {}

export type MegapotDrawingObservationFailure =
  | MegapotDrawingObservationRejected
  | MegapotDrawingObservationStorageFailed;

export type MegapotDrawingObserverCandidate = Readonly<{
  attestationId: string;
  environment: "test" | "staging" | "production";
  chainId: number;
  jackpotAddress: string;
  usdcAddress: string;
  ticketNftAddress: string;
  custodyAddress: string;
  referrerAddress: string;
  sourceTag: string;
  jackpotCodeHash: string;
  usdcCodeHash: string;
  ticketNftCodeHash: string;
  attestationBlockNumber: bigint;
  attestationBlockHash: string;
  verifiedAt: string;
}>;

export type MegapotDrawingObservationRecord = Readonly<{
  observationId: string;
  attestationId: string;
  chainId: number;
  drawingId: bigint;
  ticketPriceAtomic: bigint;
  drawingTime: string;
  ballMax: number;
  bonusballMax: number;
  drawingLocked: boolean;
  referralFeeWei: bigint;
  referralWinShareWei: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: string;
  confirmations: number;
  observedAt: string;
  expiresAt: string;
  rawStateHash: string;
}>;

export type MegapotDrawingObservationResult = MegapotDrawingObservationRecord &
  Readonly<{ openedPoolLegIds: readonly string[] }>;

export interface MegapotDrawingObservationStore {
  readonly loadCandidate: (
    attestationId: string,
  ) => Effect.Effect<MegapotDrawingObserverCandidate, MegapotDrawingObservationFailure>;
  readonly recordAndOpen: (
    observation: MegapotDrawingObservationRecord,
  ) => Effect.Effect<MegapotDrawingObservationResult, MegapotDrawingObservationFailure>;
}
