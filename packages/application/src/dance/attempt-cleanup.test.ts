import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type DanceAttemptCleanupBinding,
  DanceAttemptCleanupInvalid,
  type DanceAttemptCleanupStore,
  runDanceAttemptCleanup,
} from "./attempt-cleanup.ts";

const binding: DanceAttemptCleanupBinding = {
  version: "dance-attempt-cleanup-binding-v1",
  cleanupOperationId: "cleanup-1",
  sessionId: "session-1",
  artifactKind: "raw_video",
  privateArtifactRef: "private/random/session-1",
  attemptNumber: 1,
  claimOwner: "worker-1",
  claimFence: 1,
};

const unexpected = () => Effect.die(new Error("unexpected cleanup store call"));

function store(overrides: Partial<DanceAttemptCleanupStore>): DanceAttemptCleanupStore {
  return {
    claim: unexpected,
    complete: unexpected,
    fail: unexpected,
    ...overrides,
  };
}

describe("Dance attempt cleanup interpreter", () => {
  test("is inert before an explicit private-artifact deleter is installed", async () => {
    let claims = 0;
    const result = await Effect.runPromise(
      runDanceAttemptCleanup(
        {
          cleanupOperationId: "cleanup-1",
          workerId: "worker-1",
          leaseSeconds: 60,
          retryAfterSeconds: 30,
        },
        {
          store: store({
            claim: () => {
              claims += 1;
              return Effect.succeed({ kind: "claimed", binding });
            },
          }),
          deleter: null,
        },
      ),
    );
    expect(result).toEqual({ kind: "inert" });
    expect(claims).toBe(0);
  });

  test("deletes outside the claim transaction and completes with the exact fence", async () => {
    const events: string[] = [];
    const result = await Effect.runPromise(
      runDanceAttemptCleanup(
        {
          cleanupOperationId: "cleanup-1",
          workerId: "worker-1",
          leaseSeconds: 60,
          retryAfterSeconds: 30,
        },
        {
          store: store({
            claim: () => {
              events.push("claim");
              return Effect.succeed({ kind: "claimed", binding });
            },
            complete: (completed) => {
              events.push(`complete:${completed.claimFence}`);
              return Effect.succeed("committed");
            },
          }),
          deleter: {
            deletePrivateArtifact: () => {
              events.push("delete");
              return Effect.succeed("deleted");
            },
          },
        },
      ),
    );
    expect(events).toEqual(["claim", "delete", "complete:1"]);
    expect(result).toEqual({ kind: "committed", status: "completed" });
  });

  test("records bounded retry authority after a deletion failure", async () => {
    const result = await Effect.runPromise(
      runDanceAttemptCleanup(
        {
          cleanupOperationId: "cleanup-1",
          workerId: "worker-1",
          leaseSeconds: 60,
          retryAfterSeconds: 30,
        },
        {
          store: store({
            claim: () => Effect.succeed({ kind: "claimed", binding }),
            fail: ({ failureCode }) => {
              expect(failureCode).toBe("private_artifact_delete_failed");
              return Effect.succeed("retryable");
            },
          }),
          deleter: {
            deletePrivateArtifact: () =>
              Effect.fail(new DanceAttemptCleanupInvalid({ phase: "delete" })),
          },
        },
      ),
    );
    expect(result).toEqual({ kind: "retryable", status: "failed" });
  });
});
