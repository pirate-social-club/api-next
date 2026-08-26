import type { MegapotBeneficiarySnapshot } from "@pirate/domain";
import { Data, type Effect } from "effect";

export type MegapotCutoffStatus =
  | "cutoff_frozen"
  | "closed_no_entries"
  | "closed_unfunded"
  | "closed_fallback_ineligible"
  | "closed_fallback_unavailable"
  | "closed_fallback_ceiling";

export class MegapotCutoffStorageFailed extends Data.TaggedError("MegapotCutoffStorageFailed")<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class MegapotCutoffRejected extends Data.TaggedError("MegapotCutoffRejected")<{
  readonly reason: "cutoff-conflict" | "invalid-config" | "snapshot-required" | "too-early";
}> {}

export type MegapotCutoffFailure = MegapotCutoffRejected | MegapotCutoffStorageFailed;

export type MegapotCutoffBeneficiary = Readonly<{
  accountId: string;
  personaId: string;
}>;

export type MegapotCutoffCandidate = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  version: number;
  entryCutoffAt: string;
  termsHash: string;
  emptyPoolPolicy: "no_purchase" | "funder_fallback";
  fundingSource: "leg_budget" | "shared_sponsor_budget";
  fallbackBeneficiary: MegapotCutoffBeneficiary | null;
  shares: readonly MegapotCutoffBeneficiary[];
}>;

export type MegapotCutoffResult = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  version: number;
  status: MegapotCutoffStatus;
  frozenShareCount: number;
  fallback: boolean;
  reservedTicketCostAtomic: bigint;
  snapshotId: string | null;
  snapshotHash: string | null;
  terminalReason: string | null;
}>;

export interface MegapotCutoffStore {
  readonly loadDue: (input: {
    readonly cutoffAtOrBefore: string;
    readonly limit: number;
  }) => Effect.Effect<readonly MegapotCutoffCandidate[], MegapotCutoffFailure>;
  readonly freeze: (input: {
    readonly candidate: MegapotCutoffCandidate;
    readonly snapshot: MegapotBeneficiarySnapshot | null;
    readonly frozenAt: string;
    readonly externalSponsorDailyTicketCeiling: number;
    readonly externalSponsorDailySpendCeilingAtomic: bigint;
    readonly sharedSponsorDailyTicketCeiling: number;
    readonly sharedSponsorDailySpendCeilingAtomic: bigint;
  }) => Effect.Effect<MegapotCutoffResult, MegapotCutoffFailure>;
}
