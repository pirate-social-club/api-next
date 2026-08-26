import type { MegapotPublishedSnapshot } from "@pirate/domain";
import { Data, type Effect } from "effect";

export class MegapotCommitmentStorageFailed extends Data.TaggedError(
  "MegapotCommitmentStorageFailed",
)<{
  readonly reason: "conflict" | "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class MegapotCommitmentRejected extends Data.TaggedError("MegapotCommitmentRejected")<{
  readonly reason:
    | "commitment-conflict"
    | "drawing-not-frozen"
    | "invalid-time"
    | "payload-conflict"
    | "publication-unavailable"
    | "signer-unavailable";
}> {}

export type MegapotCommitmentFailure = MegapotCommitmentRejected | MegapotCommitmentStorageFailed;

export type MegapotCommitmentCandidate = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  drawingVersion: number;
  canPrepare: boolean;
  snapshotId: string;
  snapshot: MegapotPublishedSnapshot;
}>;

export type MegapotCommitmentProgress = Readonly<{
  commitmentEffectId: string;
  poolLegId: string;
  drawingId: bigint;
  drawingVersion: number;
  snapshotId: string;
  snapshot: MegapotPublishedSnapshot;
  payloadHash: string;
  signingKeyId: string;
  signature: string;
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
  publicReference: string | null;
}>;

export interface MegapotCommitmentStore {
  readonly loadCandidate: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<MegapotCommitmentCandidate, MegapotCommitmentFailure>;
  readonly findProgress: (
    commitmentEffectId: string,
  ) => Effect.Effect<MegapotCommitmentProgress | null, MegapotCommitmentStorageFailed>;
  readonly prepare: (input: {
    readonly candidate: MegapotCommitmentCandidate;
    readonly commitmentEffectId: string;
    readonly payloadHash: string;
    readonly signingKeyId: string;
    readonly signature: string;
    readonly preparedAt: string;
  }) => Effect.Effect<MegapotCommitmentProgress, MegapotCommitmentFailure>;
  readonly confirmPublished: (input: {
    readonly commitmentEffectId: string;
    readonly payloadHash: string;
    readonly publicReference: string;
    readonly publishedAt: string;
  }) => Effect.Effect<MegapotCommitmentProgress, MegapotCommitmentFailure>;
}
