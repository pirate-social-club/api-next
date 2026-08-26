import { Data, type Effect } from "effect";

export class MegapotSweepStorageFailed extends Data.TaggedError("MegapotSweepStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class MegapotSweepRejected extends Data.TaggedError("MegapotSweepRejected")<{
  readonly reason: "effect-conflict" | "not-found" | "ticket-not-custodied";
}> {}

export type MegapotSweepFailure = MegapotSweepRejected | MegapotSweepStorageFailed;

export type MegapotSweepReviewReason = "ticket_owner_mismatch";

export type MegapotSweepCandidate = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  drawingVersion: number;
  drawingStatus: "tickets_confirmed" | "drawing_pending";
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
  ticketId: bigint;
}>;

export type MegapotSweepResult = Readonly<{
  sweepId: string;
  poolLegId: string;
  drawingId: bigint;
  ticketId: bigint;
  outcome: "no_win" | "winnings_detected";
  tierId: number;
  grossWinningsAtomic: bigint;
  referralAccrualAtomic: bigint;
  netWinningsAtomic: bigint;
  observationBlockNumber: bigint;
  observationBlockHash: string;
}>;

export interface MegapotSweepStore {
  readonly loadCandidate: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<MegapotSweepCandidate, MegapotSweepFailure>;
  readonly findResult: (
    sweepId: string,
  ) => Effect.Effect<MegapotSweepResult | null, MegapotSweepStorageFailed>;
  readonly markDrawingPending: (
    candidate: MegapotSweepCandidate,
  ) => Effect.Effect<void, MegapotSweepFailure>;
  readonly requireReview: (input: {
    readonly candidate: MegapotSweepCandidate;
    readonly sweepId: string;
    readonly reason: MegapotSweepReviewReason;
    readonly observationBlockNumber: bigint;
    readonly observationBlockHash: string;
    readonly observedOwnerAddress: string;
    readonly observedAt: string;
  }) => Effect.Effect<void, MegapotSweepFailure>;
  readonly complete: (input: {
    readonly candidate: MegapotSweepCandidate;
    readonly sweepId: string;
    readonly observationBlockNumber: bigint;
    readonly observationBlockHash: string;
    readonly drawingStateHash: string;
    readonly tierId: number;
    readonly custodyOwnerAddress: string;
    readonly grossWinningsAtomic: bigint;
    readonly referralWinShareAtomic: bigint;
    readonly referralAccrualAtomic: bigint;
    readonly netWinningsAtomic: bigint;
    readonly observedAt: string;
  }) => Effect.Effect<MegapotSweepResult, MegapotSweepFailure>;
}
