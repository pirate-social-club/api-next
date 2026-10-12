// Concrete external-I/O adapter; no SQL/HTTP/provider activation in this file.
import type { ControlPlaneError } from "@pirate/application";
import type { OwnerLearnerAudioDeletionStore } from "@pirate/application/owner-learner-audio-deletion";
import {
  LearnerAudioDeletionFailed,
  type LearnerAudioDeletionStore,
} from "@pirate/application/use-cases/learner-audio-deletion";
import type { GuestLearnerAudioDeletionV1, LearnerAudioDeletionResult } from "@pirate/contracts";
import { Effect } from "effect";
export interface ExactLearnerAudioDeletionBucket {
  readonly delete: (keys: string[]) => Promise<void>;
}
/** One exact durable batch; operation lookup follows uncertain SQL COMMIT.
 * The store's own prepared outcome has already committed before external delete.
 * Failed promises are classified unknown: a remote delete may have completed.
 */
export const makeOwnerLearnerAudioDeletionIo = (
  store: OwnerLearnerAudioDeletionStore,
  bucket: ExactLearnerAudioDeletionBucket,
) => ({
  executeBatch: Effect.fn("OwnerLearnerAudioDeletionIo.executeBatch")(function* (
    input: Parameters<OwnerLearnerAudioDeletionStore["prepareBatch"]>[0],
  ) {
    const prepared = yield* store.prepareBatch(input);
    if (prepared.state !== "completed") return prepared;
    const batch = prepared.result;
    if (
      batch.artifacts.length > 1000 ||
      batch.fenceRevision < 1 ||
      !Number.isSafeInteger(batch.fenceRevision)
    )
      throw new Error("Invalid private prepared batch");
    const keys = [...new Set(batch.artifacts.map((item) => item.objectRef))];
    // Source arrays and keys are internal store outputs, never browser inputs.
    const known = yield* Effect.tryPromise({
      try: async () => {
        if (keys.length) await bucket.delete(keys);
        return true;
      },
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!known) return yield* store.failBatch({ batch, storageDisposition: "unknown" });
    return yield* store.confirmBatch({
      batch,
      storageDisposition: "deleted",
      deletedAt: new Date().toISOString(),
    });
  }),
});
export interface AccountLearnerAudioDeletePreparation {
  readonly batchId: string;
  readonly objectRefs: readonly string[];
  readonly fenceRevision: number;
}
/** Private SQL bridge is implemented by source-owned deletion wrappers. prepare
 * finds an existing active account-group command under topology locks before
 * minting a fresh key. No R2 dependency is accepted by any SQL method.
 */
export interface AccountLearnerAudioDeleteProtocol {
  readonly prepare: (
    accountId: string,
    maximum: 1000,
  ) => Effect.Effect<
    AccountLearnerAudioDeletePreparation,
    ControlPlaneError | LearnerAudioDeletionFailed
  >;
  readonly unknown: (
    batch: AccountLearnerAudioDeletePreparation,
  ) => Effect.Effect<void, ControlPlaneError>;
  readonly confirm: (
    batch: AccountLearnerAudioDeletePreparation,
    deletedAt: string,
  ) => Effect.Effect<LearnerAudioDeletionResult, ControlPlaneError | LearnerAudioDeletionFailed>;
}
/** Maintains the ordinary account result/error contract. Unresolved producer
 * returns existing in-flight, and a completed first bounded batch may retain a
 * positive remaining count. It never silently emits guest pending/202 JSON.
 */
export const makeAccountLearnerAudioDeletionIo = (
  protocol: AccountLearnerAudioDeleteProtocol,
  bucket: ExactLearnerAudioDeletionBucket,
): LearnerAudioDeletionStore => ({
  deleteBatch: Effect.fn("AccountLearnerAudioDeletionIo.deleteBatch")(
    function* ({ accountId, deletedAt }: Parameters<LearnerAudioDeletionStore["deleteBatch"]>[0]) {
      const batch = yield* protocol.prepare(accountId, 1000);
      if (batch.objectRefs.length > 1000)
        return yield* new LearnerAudioDeletionFailed({ reason: "store-unavailable" });
      const known = yield* Effect.tryPromise({
        try: async () => {
          if (batch.objectRefs.length) await bucket.delete([...batch.objectRefs]);
          return true;
        },
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!known) {
        yield* protocol.unknown(batch);
        return yield* new LearnerAudioDeletionFailed({ reason: "storage-unavailable" });
      }
      return yield* protocol.confirm(batch, deletedAt);
    },
    Effect.mapError((error) =>
      error instanceof LearnerAudioDeletionFailed
        ? error
        : new LearnerAudioDeletionFailed({ reason: "store-unavailable" }),
    ),
  ),
});
/** Erasure owner must not call an ambiguous/zero-progress drain terminal. */
export const audioErasureDisposition = (result: GuestLearnerAudioDeletionV1) =>
  result.state === "completed"
    ? ({ outcome: "terminal", disposition: "deleted" } as const)
    : ({ outcome: "paused", status: "action_required" } as const);
