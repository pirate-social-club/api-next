import { describe, expect, test } from "bun:test";
import { LearnerAudioDeletionFailed } from "@pirate/application/use-cases/learner-audio-deletion";
import { Conflict, ProviderUnavailable } from "@pirate/contracts";
import { Effect } from "effect";
import { makeLearnerAudioHandlers } from "./learner-audio-handlers.ts";

const request = {
  principal: { kind: "user" as const, subject: "account-1" },
  params: {},
  query: {},
  headers: {},
  body: undefined,
};

describe("learner audio handlers", () => {
  test("returns the account-scoped deletion result", async () => {
    const handlers = makeLearnerAudioHandlers({
      clock: { now: Effect.succeed(1_788_000_000_000) },
      store: {
        deleteBatch: (input) =>
          Effect.succeed({
            object: "learner_audio_deletion" as const,
            deleted_count: input.accountId === "account-1" ? 1 : 0,
            remaining_count: 0,
            last_deleted_at: input.deletedAt,
          }),
      },
    });
    await expect(handlers.DeleteMyLearnerAudio(request)).resolves.toMatchObject({
      deleted_count: 1,
      remaining_count: 0,
    });
  });

  test("maps in-flight and storage failures to stable wire errors", async () => {
    const make = (reason: LearnerAudioDeletionFailed["reason"]) =>
      makeLearnerAudioHandlers({
        clock: { now: Effect.succeed(1_788_000_000_000) },
        store: { deleteBatch: () => Effect.fail(new LearnerAudioDeletionFailed({ reason })) },
      }).DeleteMyLearnerAudio(request);

    await expect(make("in-flight")).rejects.toBeInstanceOf(Conflict);
    await expect(make("storage-unavailable")).rejects.toBeInstanceOf(ProviderUnavailable);
  });
});
