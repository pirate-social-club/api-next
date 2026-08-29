import type { LearnerAudioDeletionResult } from "@pirate/contracts";
import { Data, Effect } from "effect";
import { Clock } from "./ports.ts";

export class LearnerAudioDeletionFailed extends Data.TaggedError("LearnerAudioDeletionFailed")<{
  readonly reason: "in-flight" | "storage-unavailable" | "store-unavailable";
}> {}

export interface LearnerAudioDeletionStore {
  readonly deleteBatch: (input: {
    readonly accountId: string;
    readonly deletedAt: string;
  }) => Effect.Effect<LearnerAudioDeletionResult, LearnerAudioDeletionFailed>;
}

export const makeLearnerAudioDeletionService = (store: LearnerAudioDeletionStore) => ({
  deleteMine: (accountId: string) =>
    Effect.gen(function* () {
      const clock = yield* Clock;
      return yield* store.deleteBatch({
        accountId,
        deletedAt: new Date(yield* clock.now).toISOString(),
      });
    }),
});
