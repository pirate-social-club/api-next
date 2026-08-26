import { Data, type Effect } from "effect";

export class MegapotAllocationStorageFailed extends Data.TaggedError(
  "MegapotAllocationStorageFailed",
)<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class MegapotAllocationRejected extends Data.TaggedError("MegapotAllocationRejected")<{
  readonly reason:
    | "allocation-invalid"
    | "effect-conflict"
    | "not-found"
    | "winnings-not-claimable";
}> {}

export type MegapotAllocationFailure = MegapotAllocationRejected | MegapotAllocationStorageFailed;

export type MegapotAllocationLeaf = Readonly<{
  ordinal: number;
  accountId: string;
  personaId: string;
}>;

export type MegapotAllocationCandidate = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  drawingVersion: number;
  drawingStatus: "claimed" | "allocated" | "credited";
  snapshotId: string;
  claimEffectId: string;
  algorithmVersion: "equal_v1";
  netWinningsAtomic: bigint;
  chainId: number;
  tokenAddress: string;
  fallback: boolean;
  fundingSource: "leg_budget" | "shared_sponsor_budget";
  fallbackBeneficiaryAccountId: string | null;
  fallbackPayoutPersonaId: string | null;
  leaves: readonly MegapotAllocationLeaf[];
}>;

export type MegapotPreparedAllocation = Readonly<{
  ordinal: number;
  accountId: string;
  personaId: string;
  amountAtomic: bigint;
  allocationKind: "participant" | "external_fallback" | "platform_sponsorship";
  creditId: string | null;
  creditSourceReference: string | null;
}>;

export type MegapotAllocationResult = Readonly<{
  allocationBatchId: string;
  poolLegId: string;
  drawingId: bigint;
  snapshotId: string;
  claimEffectId: string;
  netWinningsAtomic: bigint;
  allocationHash: string;
  allocations: readonly MegapotPreparedAllocation[];
  state: "credited";
}>;

export interface MegapotAllocationStore {
  readonly loadCandidate: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<MegapotAllocationCandidate, MegapotAllocationFailure>;
  readonly findResult: (
    allocationBatchId: string,
  ) => Effect.Effect<MegapotAllocationResult | null, MegapotAllocationStorageFailed>;
  readonly credit: (input: {
    readonly candidate: MegapotAllocationCandidate;
    readonly allocationBatchId: string;
    readonly allocationHash: string;
    readonly allocations: readonly MegapotPreparedAllocation[];
    readonly creditedAt: string;
  }) => Effect.Effect<MegapotAllocationResult, MegapotAllocationFailure>;
}
