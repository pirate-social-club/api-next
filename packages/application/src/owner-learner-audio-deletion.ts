import type { GuestLearnerAudioDeletionV1 } from "@pirate/contracts";
import type { Effect } from "effect";
import type {
  DurableParticipationOutcome,
  GuestParticipationStoreFailure,
  ParticipationOperationIdentity,
  ParticipationSource,
  RecoveryAccess,
} from "./guest-participation-authority.ts";

export type OwnerLearnerAudioDeletionBatch = Readonly<{
  operation: ParticipationOperationIdentity;
  batchId: string;
  fenceRevision: number;
  sourceOwnerIds: readonly string[];
  artifacts: readonly Readonly<{
    artifactId: string;
    source: ParticipationSource;
    objectRef: string;
  }>[];
  providerDisposition: GuestLearnerAudioDeletionV1["provider_disposition"];
}>;
type Result<A> = Effect.Effect<A, GuestParticipationStoreFailure>;
export interface OwnerLearnerAudioDeletionStore {
  /** Short SQL transaction, stable owner-group fence, at most1000 artifacts. No R2 call. */
  readonly prepareBatch: (
    input: Readonly<{
      access: RecoveryAccess;
      operation: ParticipationOperationIdentity;
      maximumArtifacts: number;
    }>,
  ) => Result<DurableParticipationOutcome<OwnerLearnerAudioDeletionBatch>>;
  /** External exact-batch deletion has completed; short idempotent finalization follows. */
  readonly confirmBatch: (
    input: Readonly<{
      batch: OwnerLearnerAudioDeletionBatch;
      storageDisposition: "deleted" | "absent";
      deletedAt: string;
    }>,
  ) => Result<DurableParticipationOutcome<GuestLearnerAudioDeletionV1>>;
  readonly failBatch: (
    input: Readonly<{
      batch: OwnerLearnerAudioDeletionBatch;
      storageDisposition: "failed" | "unknown";
    }>,
  ) => Result<DurableParticipationOutcome<GuestLearnerAudioDeletionV1>>;
  readonly findOperation: (
    input: Readonly<{ access: RecoveryAccess; sourceOwnerId: string; idempotencyKey: string }>,
  ) => Result<GuestLearnerAudioDeletionV1>;
}
