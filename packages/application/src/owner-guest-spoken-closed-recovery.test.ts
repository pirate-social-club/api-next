import { expect, test } from "bun:test";
import { Effect } from "effect";
import { success } from "./guest-spoken-recovery.test-fixture.ts";
import type { OwnerGuestSpokenClosedRecoveryStore } from "./owner-guest-spoken-checkpoint-recovery.ts";
import { makeOwnerGuestSpokenClosedRecovery } from "./owner-guest-spoken-closed-recovery.ts";
import type { OwnerSpokenCapturedContinuationStore } from "./owner-spoken-captured-continuation.ts";
import { ControlPlaneTransactionOutcomeUnknown } from "./ports.ts";

const retained = (
  read: OwnerGuestSpokenClosedRecoveryStore["read"],
): OwnerGuestSpokenClosedRecoveryStore => ({
  list: (maximum) => Effect.succeed(maximum ? [{ checkpointId: "checkpoint-original" }] : []),
  read,
});
const acknowledged = {
  state: "completed" as const,
  operation: success.operation,
  outcomeId: "checkpoint-original",
  result: { checkpointId: "checkpoint-original" },
};
// Completion body is not needed for these ordering/refusal tests; a pending
// original operation exercises the real result union without an opaque answer.
const pending = {
  state: "pending_confirmation" as const,
  operation: success.operation,
  outcomeId: "operation-original",
};
const original = {
  checkpointId: "checkpoint-original",
  success,
  archive: { state: "failed" as const, objectRef: null },
};
test("closed captured continuation uses actual archive and original lease with no browser access", async () => {
  const calls: string[] = [];
  const continuation: OwnerSpokenCapturedContinuationStore = {
    acknowledgeCapturedSpokenResult: ({ checkpoint }) => {
      calls.push("ack");
      expect(checkpoint.result.archive).toEqual(original.archive);
      expect(checkpoint.result.leaseToken).toBe(success.result.leaseToken);
      return Effect.succeed(acknowledged);
    },
    completeCapturedSpokenAnswer: (input) => {
      calls.push("complete");
      expect(Object.keys(input).sort()).toEqual(["checkpointId", "operation", "source"]);
      return Effect.succeed(pending);
    },
  };
  expect(
    await Effect.runPromise(
      makeOwnerGuestSpokenClosedRecovery(
        retained(() => Effect.succeed(original)),
        continuation,
      ).run(20),
    ),
  ).toEqual({ examined: 1, completed: 0, pending: 1, skipped: 0 });
  expect(calls).toEqual(["ack", "complete"]);
});
test("absent or no-longer-eligible actual checkpoint cannot invoke continuation", async () => {
  let called = 0;
  const continuation: OwnerSpokenCapturedContinuationStore = {
    acknowledgeCapturedSpokenResult: () => {
      called++;
      return Effect.succeed(acknowledged);
    },
    completeCapturedSpokenAnswer: () => {
      called++;
      return Effect.succeed(pending);
    },
  };
  expect(
    await Effect.runPromise(
      makeOwnerGuestSpokenClosedRecovery(
        retained(() => Effect.succeed(null)),
        continuation,
      ).run(20),
    ),
  ).toMatchObject({ skipped: 1 });
  expect(called).toBe(0);
});
test("uncertain actual ACK leaves finalization untouched", async () => {
  let completes = 0;
  const failure = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "original-ack",
    limitMs: 1,
    elapsedMs: 1,
  });
  const continuation: OwnerSpokenCapturedContinuationStore = {
    acknowledgeCapturedSpokenResult: () => Effect.fail(failure),
    completeCapturedSpokenAnswer: () => {
      completes++;
      return Effect.succeed(pending);
    },
  };
  const result = await Effect.runPromise(
    Effect.result(
      makeOwnerGuestSpokenClosedRecovery(
        retained(() => Effect.succeed(original)),
        continuation,
      ).run(20),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBe(failure);
  expect(completes).toBe(0);
});
test("foreign checkpoint acknowledgment refuses without completing another command", async () => {
  let completes = 0;
  const continuation: OwnerSpokenCapturedContinuationStore = {
    acknowledgeCapturedSpokenResult: () =>
      Effect.succeed({ ...acknowledged, outcomeId: "foreign-checkpoint" }),
    completeCapturedSpokenAnswer: () => {
      completes++;
      return Effect.succeed(pending);
    },
  };
  const result = await Effect.runPromise(
    Effect.result(
      makeOwnerGuestSpokenClosedRecovery(
        retained(() => Effect.succeed(original)),
        continuation,
      ).run(20),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure._tag).toBe("GuestParticipationStoreRejected");
  expect(completes).toBe(0);
});
