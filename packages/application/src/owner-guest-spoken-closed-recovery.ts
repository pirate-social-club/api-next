// Internal process-loss continuation. No browser authority fabrication, provider,
// archive write, billing, transcript grading or public lease exposure.
import { Effect } from "effect";
import {
  type GuestParticipationStoreFailure,
  GuestParticipationStoreRejected,
} from "./guest-participation-authority.ts";
import type { OwnerGuestSpokenClosedRecoveryStore } from "./owner-guest-spoken-checkpoint-recovery.ts";
import type { OwnerSpokenCapturedContinuationStore } from "./owner-spoken-captured-continuation.ts";

const invalid = () => new GuestParticipationStoreRejected({ reason: "idempotency-conflict" });
const sameOperation = (
  a: { sourceOwnerId: string; kind: string; idempotencyKey: string; requestHash: string },
  b: typeof a,
) =>
  a.sourceOwnerId === b.sourceOwnerId &&
  a.kind === b.kind &&
  a.idempotencyKey === b.idempotencyKey &&
  a.requestHash === b.requestHash;
export const makeOwnerGuestSpokenClosedRecovery = (
  retained: OwnerGuestSpokenClosedRecoveryStore,
  continuation: OwnerSpokenCapturedContinuationStore,
) => ({
  run: Effect.fn("OwnerGuestSpokenClosedRecovery.run")(function* (
    maximum: number,
  ): Effect.fn.Return<
    Readonly<{ examined: number; completed: number; pending: number; skipped: number }>,
    GuestParticipationStoreFailure
  > {
    const candidates = yield* retained.list(maximum);
    let completed = 0,
      pending = 0,
      skipped = 0;
    for (const candidate of candidates) {
      const saved = yield* retained.read(candidate.checkpointId);
      if (saved === null) {
        skipped++;
        continue;
      }
      if (saved.checkpointId !== candidate.checkpointId) return yield* invalid();
      const success = saved.success;
      const acknowledged = yield* continuation.acknowledgeCapturedSpokenResult({
        checkpoint: { ...success, result: { ...success.result, archive: saved.archive } },
      });
      if (
        !sameOperation(acknowledged.operation, success.operation) ||
        acknowledged.state === "known_aborted"
      )
        return yield* invalid();
      if (acknowledged.state !== "completed") {
        pending++;
        continue;
      }
      if (
        acknowledged.outcomeId !== candidate.checkpointId ||
        acknowledged.result.checkpointId !== candidate.checkpointId
      )
        return yield* invalid();
      const result = yield* continuation.completeCapturedSpokenAnswer({
        source: success.source,
        operation: success.operation,
        checkpointId: candidate.checkpointId,
      });
      if (!sameOperation(result.operation, success.operation) || result.state === "known_aborted")
        return yield* invalid();
      if (result.state === "completed") {
        if (
          result.result.source.kind !== "guest" ||
          result.result.source.ownerId !== success.source.ownerId
        )
          return yield* invalid();
        completed++;
      } else pending++;
    }
    return { examined: candidates.length, completed, pending, skipped };
  }),
});
