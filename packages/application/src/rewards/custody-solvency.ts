import { Data, type Effect } from "effect";

export class CustodySolvencyStorageFailed extends Data.TaggedError("CustodySolvencyStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class CustodySolvencyRejected extends Data.TaggedError("CustodySolvencyRejected")<{
  readonly reason: "attestation-not-found" | "observation-conflict";
}> {}

export type CustodySolvencyFailure = CustodySolvencyRejected | CustodySolvencyStorageFailed;

export type CustodySolvencyCandidate = Readonly<{
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

export type CustodySolvencyObservation = Readonly<{
  observationId: string;
  attestationId: string;
  balanceAtomic: bigint;
  reservedPurchaseAtomic: bigint;
  outstandingCreditAtomic: bigint;
  pendingRefundAtomic: bigint;
  sharedSponsorshipAtomic: bigint;
  solvent: boolean;
  blockNumber: bigint;
  blockHash: string;
  observedAt: string;
  expiresAt: string;
}>;

export interface CustodySolvencyStore {
  readonly loadCandidate: (
    attestationId: string,
  ) => Effect.Effect<CustodySolvencyCandidate, CustodySolvencyFailure>;
  readonly findObservation: (
    observationId: string,
  ) => Effect.Effect<CustodySolvencyObservation | null, CustodySolvencyStorageFailed>;
  readonly record: (input: {
    readonly candidate: CustodySolvencyCandidate;
    readonly observationId: string;
    readonly balanceAtomic: bigint;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly observedAt: string;
    readonly expiresAt: string;
  }) => Effect.Effect<CustodySolvencyObservation, CustodySolvencyFailure>;
}
