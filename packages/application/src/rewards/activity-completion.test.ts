import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Clock } from "../ports.ts";
import {
  type ActivityCompletionStore,
  makeActivityCompletionService,
} from "./activity-completion.ts";
import {
  type ActivityQualificationFailure,
  ActivityQualificationRejected,
} from "./activity-qualification.ts";

test("current reads bind identity and the injected observation time without retrying or mutating attempts", async () => {
  const seen: unknown[] = [];
  const fail = (input: unknown) => {
    seen.push(input);
    return Effect.fail(new ActivityQualificationRejected({ reason: "not-found" }));
  };
  const store: ActivityCompletionStore = {
    getCompletion: fail,
    getProgress: fail,
    getPresentation: fail,
  };
  const service = makeActivityCompletionService(store);
  const identity = { accountId: "authenticated-account", communityId: "community" };
  const readAt = "2026-10-16T02:00:00.000Z";
  const reads: ReadonlyArray<Effect.Effect<unknown, ActivityQualificationFailure, Clock>> = [
    service.getCompletion({
      ...identity,
      activity: "karaoke",
      sessionId: "session",
      attemptId: "attempt",
    }),
    service.getProgress({ ...identity, postId: null }),
    service.getPresentation(identity),
  ];
  for (const read of reads) {
    await expect(
      Effect.runPromise(
        read.pipe(Effect.provideService(Clock, { now: Effect.succeed(Date.parse(readAt)) })),
      ),
    ).rejects.toMatchObject({ reason: "not-found" });
  }
  expect(seen).toEqual([
    { ...identity, activity: "karaoke", sessionId: "session", attemptId: "attempt", readAt },
    { ...identity, postId: null, readAt },
    { ...identity, readAt },
  ]);
});
