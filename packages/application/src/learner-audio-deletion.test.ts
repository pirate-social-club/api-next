import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeLearnerAudioDeletionService } from "./learner-audio-deletion.ts";
import { Clock } from "./ports.ts";

describe("learner audio deletion service", () => {
  test("uses the authenticated account and a server-stamped deletion instant", async () => {
    const calls: unknown[] = [];
    const service = makeLearnerAudioDeletionService({
      deleteBatch: (input) => {
        calls.push(input);
        return Effect.succeed({
          object: "learner_audio_deletion" as const,
          deleted_count: 2,
          remaining_count: 0,
          last_deleted_at: input.deletedAt,
        });
      },
    });

    const result = await Effect.runPromise(
      service
        .deleteMine("account-1")
        .pipe(Effect.provideService(Clock, { now: Effect.succeed(1_788_000_000_000) })),
    );

    expect(calls).toEqual([{ accountId: "account-1", deletedAt: "2026-08-29T10:40:00.000Z" }]);
    expect(result.deleted_count).toBe(2);
  });
});
