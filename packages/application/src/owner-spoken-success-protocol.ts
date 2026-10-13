// Additional INTERNAL application protocol. No frozen port/wire/client change.
import { Effect } from "effect";
import {
  type DurableParticipationOutcome,
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
  type LearningAccess,
  type ParticipationSource,
} from "./guest-participation-authority.ts";
import type {
  OwnerAwareStudyV2Store,
  OwnerSpokenSuccessfulCheckpoint,
  OwnerStudyAnswer,
  OwnerStudyAudioArchive,
} from "./guest-study-ports.ts";
import type { LearnerAudioStorageOutcomeUnknown } from "./learner-audio-io-outcome.ts";
import type { StudyAudioArchiveResult } from "./study-v2-service.ts";

export type OwnerSpokenSuccessFailure =
  | GuestParticipationStoreFailure
  | LearnerAudioStorageOutcomeUnknown;

export type OwnerSpokenPreArchiveSuccess = Omit<
  OwnerSpokenSuccessfulCheckpoint,
  "result" | "source"
> &
  Readonly<{
    source: Extract<ParticipationSource, { kind: "guest" }>;
    result: Omit<OwnerSpokenSuccessfulCheckpoint["result"], "archive">;
  }>;
export interface OwnerSpokenPreArchiveCheckpointStore {
  readonly persistBeforeArchive: (
    input: OwnerSpokenPreArchiveSuccess,
  ) => Effect.Effect<
    DurableParticipationOutcome<Readonly<{ checkpointId: string }>>,
    GuestParticipationStoreFailure
  >;
  readonly findBeforeArchive: (
    input: Pick<OwnerSpokenPreArchiveSuccess, "source" | "operation" | "commandId"> &
      Readonly<{ originalLeaseToken: string }>,
  ) => Effect.Effect<
    Readonly<{ checkpointId: string; success: OwnerSpokenPreArchiveSuccess }> | null,
    GuestParticipationStoreFailure
  >;
}
/** Additional internal failure channel preserves uncertain storage I/O. */
export interface OwnerSpokenFencedArchiveStage {
  readonly store: (
    input: Parameters<OwnerStudyAudioArchive["store"]>[0],
  ) => Effect.Effect<StudyAudioArchiveResult, OwnerSpokenSuccessFailure>;
}
const operationMatches = (
  a: OwnerSpokenPreArchiveSuccess["operation"],
  b: OwnerSpokenPreArchiveSuccess["operation"],
) =>
  a.sourceOwnerId === b.sourceOwnerId &&
  a.kind === b.kind &&
  a.idempotencyKey === b.idempotencyKey &&
  a.requestHash === b.requestHash;
const invalid = () => new GuestParticipationStoreRejected({ reason: "idempotency-conflict" });

/** Called by owner service after accepted provider response/shared grading.
 * No current cookie/proof/learning-lease verification is added after I/O.
 * Persist first; archive returns an actually observed fenced ledger outcome;
 * frozen method acknowledges an existing checkpoint and then finalizes it.
 */
export const makeOwnerSpokenSuccessProtocol = (
  preArchive: OwnerSpokenPreArchiveCheckpointStore,
  ownerStore: Pick<
    OwnerAwareStudyV2Store,
    "persistSuccessfulSpokenResult" | "completeSpokenAnswer"
  >,
  archive: OwnerSpokenFencedArchiveStage,
) => ({
  finish: Effect.fn("OwnerSpokenSuccessProtocol.finish")(function* (
    input: Readonly<{
      access: LearningAccess;
      success: OwnerSpokenPreArchiveSuccess;
      audio: Uint8Array;
    }>,
  ): Effect.fn.Return<DurableParticipationOutcome<OwnerStudyAnswer>, OwnerSpokenSuccessFailure> {
    const persisted = yield* preArchive.persistBeforeArchive(input.success);
    if (!operationMatches(persisted.operation, input.success.operation)) return yield* invalid();
    if (persisted.state !== "completed") return persisted;
    const checkpointId = persisted.result.checkpointId;
    if (checkpointId !== persisted.outcomeId) return yield* invalid();
    // Recover the durable original facts before archive. Same-key replay
    // cannot replace accepted IDs/times, regrade or invent a newer snapshot.
    const saved = yield* preArchive.findBeforeArchive({
      source: input.success.source,
      operation: input.success.operation,
      commandId: input.success.commandId,
      originalLeaseToken: input.success.result.leaseToken,
    });
    if (
      saved === null ||
      saved.checkpointId !== checkpointId ||
      !operationMatches(saved.success.operation, input.success.operation)
    )
      return yield* invalid();
    const success = saved.success;
    const actualArchive = yield* archive.store({
      source: success.source,
      operation: success.operation,
      artifactId: success.result.artifactId,
      resourceReservationId: success.resourceReservationId,
      deletionFenceRevision: success.deletionFenceRevision,
      audio: input.audio,
      contentType: success.result.audioContentType,
      contentDigest: success.result.audioDigest,
    });
    const ack = yield* ownerStore.persistSuccessfulSpokenResult({
      access: input.access,
      checkpoint: { ...success, result: { ...success.result, archive: actualArchive } },
    });
    if (!operationMatches(ack.operation, success.operation)) return yield* invalid();
    if (ack.state !== "completed") return ack;
    if (ack.result.checkpointId !== checkpointId || ack.outcomeId !== checkpointId)
      return yield* invalid();
    return yield* ownerStore.completeSpokenAnswer({
      access: input.access,
      checkpointId,
      source: success.source,
      operation: success.operation,
    });
  }),
});
