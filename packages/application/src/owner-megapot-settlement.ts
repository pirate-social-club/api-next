// Private server-only source contract. Existing frozen application ports/wire stay unchanged.
import type { MegapotOwnerPublishedSnapshot } from "@pirate/domain";
import type { Effect } from "effect";
import type { ControlPlaneError } from "./ports.ts";

export type OwnerMegapotDrawingKey = Readonly<{ poolLegId: string; drawingId: string }>;
export type OwnerMegapotCutoffCeilings = Readonly<{
  externalTickets: number;
  externalSpendAtomic: string;
  sharedTickets: number;
  sharedSpendAtomic: string;
}>;
export type OwnerMegapotCutoffResult = OwnerMegapotDrawingKey &
  Readonly<{
    version: number;
    status:
      | "cutoff_frozen"
      | "closed_no_entries"
      | "closed_unfunded"
      | "closed_fallback_ineligible"
      | "closed_fallback_unavailable"
      | "closed_fallback_ceiling";
    frozenShareCount: number;
    fallback: boolean;
    reservedTicketCostAtomic: string;
    snapshotId: string | null;
    snapshotHash: string | null;
    terminalReason: string | null;
  }>;
export type OwnerMegapotCommitmentProgress = Readonly<{
  commitmentEffectId: string;
  payloadHash: string;
  signingKeyId: string;
  signature: string;
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
  publicReference: string | null;
}>;
export type OwnerMegapotCommitmentRead = OwnerMegapotDrawingKey &
  Readonly<{
    drawingVersion: number;
    canPrepare: boolean;
    snapshotId: string;
    snapshot: MegapotOwnerPublishedSnapshot;
    progress: OwnerMegapotCommitmentProgress | null;
  }>;
export type OwnerMegapotAllocationResult = Readonly<{
  allocationBatchId: string;
  state: "credited";
}>;
export interface OwnerMegapotSettlementStore {
  readonly freeze: (
    key: OwnerMegapotDrawingKey,
    ceilings: OwnerMegapotCutoffCeilings | null,
  ) => Effect.Effect<OwnerMegapotCutoffResult, ControlPlaneError>;
  readonly readCommitment: (
    key: OwnerMegapotDrawingKey,
  ) => Effect.Effect<OwnerMegapotCommitmentRead, ControlPlaneError>;
  readonly prepareCommitment: (
    input: OwnerMegapotDrawingKey &
      Readonly<{
        snapshotId: string;
        payload: string;
        payloadHash: string;
        signingKeyId: string;
        signature: string;
      }>,
  ) => Effect.Effect<OwnerMegapotCommitmentRead, ControlPlaneError>;
  readonly confirmPublished: (
    input: OwnerMegapotDrawingKey &
      Readonly<{
        commitmentEffectId: string;
        payloadHash: string;
        publicReference: string;
        publishedAt: string;
      }>,
  ) => Effect.Effect<OwnerMegapotCommitmentRead, ControlPlaneError>;
  readonly allocate: (
    key: OwnerMegapotDrawingKey,
  ) => Effect.Effect<OwnerMegapotAllocationResult, ControlPlaneError>;
}
