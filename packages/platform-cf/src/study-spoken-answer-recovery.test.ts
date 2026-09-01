import { describe, expect, test } from "bun:test";
import { ControlPlaneOperationTimedOut } from "@pirate/application";
import { Effect } from "effect";
import {
  recoverExpiredStudySpokenAnswers,
  type StudySpokenAnswerRecoveryClaim,
  type StudySpokenAnswerRecoveryStore,
} from "./study-spoken-answer-recovery.ts";

const claim: StudySpokenAnswerRecoveryClaim = {
  commandId: "command-1",
  accountId: "account-1",
  artifactId: "artifact-1",
  expectedObjectRef: "learner-audio/study/attempt-1/digest-1",
  leaseToken: "sweeper-lease",
};

const finalizationTimeout = () =>
  new ControlPlaneOperationTimedOut({
    label: "study-spoken-answer-recovery.finalize",
    limitMs: 1_000,
    elapsedMs: 1_000,
    outcomeCertainty: "aborted",
  });

const store = (
  options: {
    readonly finalize?: () => Effect.Effect<boolean, never>;
    readonly claims?: readonly StudySpokenAnswerRecoveryClaim[];
  } = {},
): StudySpokenAnswerRecoveryStore => ({
  claimExpired: () => Effect.succeed(options.claims ?? [claim]),
  finalizeFailed: () => options.finalize?.() ?? Effect.succeed(true),
});

describe("Study spoken-answer expiry recovery", () => {
  test("deletes and confirms the deterministic object before finalizing", async () => {
    const order: string[] = [];
    const result = await Effect.runPromise(
      recoverExpiredStudySpokenAnswers({
        store: store({
          finalize: () => Effect.sync(() => order.push("finalize")).pipe(Effect.as(true)),
        }),
        bucket: {
          delete: async () => {
            order.push("delete");
          },
          head: async () => {
            order.push("head");
            return null;
          },
        },
        leaseToken: claim.leaseToken,
        failedAt: "2026-09-01T00:00:00.000Z",
      }),
    );

    expect(order).toEqual(["delete", "head", "finalize"]);
    expect(result).toEqual({ claimed: 1, recovered: 1, storageFailures: 0, fenced: 0 });
  });

  test("treats an already-missing object as an idempotent recovery", async () => {
    let finalized = 0;
    const result = await Effect.runPromise(
      recoverExpiredStudySpokenAnswers({
        store: store({
          finalize: () => Effect.sync(() => (finalized += 1)).pipe(Effect.as(true)),
        }),
        bucket: { delete: async () => undefined, head: async () => null },
        leaseToken: claim.leaseToken,
        failedAt: "2026-09-01T00:00:00.000Z",
      }),
    );

    expect(finalized).toBe(1);
    expect(result.recovered).toBe(1);
  });

  test("leaves the claimed command reserved when storage fails or remains present", async () => {
    let finalized = 0;
    for (const bucket of [
      { delete: async () => Promise.reject(new Error("unavailable")), head: async () => null },
      { delete: async () => undefined, head: async () => ({ key: claim.expectedObjectRef }) },
    ]) {
      const result = await Effect.runPromise(
        recoverExpiredStudySpokenAnswers({
          store: store({
            finalize: () => Effect.sync(() => (finalized += 1)).pipe(Effect.as(true)),
          }),
          bucket,
          leaseToken: claim.leaseToken,
          failedAt: "2026-09-01T00:00:00.000Z",
        }),
      );
      expect(result.storageFailures).toBe(1);
      expect(result.recovered).toBe(0);
    }
    expect(finalized).toBe(0);
  });

  test("reports a lost finalization fence without claiming recovery", async () => {
    const result = await Effect.runPromise(
      recoverExpiredStudySpokenAnswers({
        store: store({ finalize: () => Effect.succeed(false) }),
        bucket: { delete: async () => undefined, head: async () => null },
        leaseToken: claim.leaseToken,
        failedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    expect(result).toEqual({ claimed: 1, recovered: 0, storageFailures: 0, fenced: 1 });
  });

  test("propagates database finalization failure so the claimed row is re-driven later", async () => {
    const failure = finalizationTimeout();
    const exit = await Effect.runPromise(
      Effect.exit(
        recoverExpiredStudySpokenAnswers({
          store: {
            claimExpired: () => Effect.succeed([claim]),
            finalizeFailed: () => Effect.fail(failure),
          },
          bucket: { delete: async () => undefined, head: async () => null },
          leaseToken: claim.leaseToken,
          failedAt: "2026-09-01T00:00:00.000Z",
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("re-drives a claim after a database finalization failure", async () => {
    let attempts = 0;
    const recoveryStore: StudySpokenAnswerRecoveryStore = {
      claimExpired: () => Effect.succeed([claim]),
      finalizeFailed: () => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(finalizationTimeout()) : Effect.succeed(true);
      },
    };
    const input = {
      store: recoveryStore,
      bucket: { delete: async () => undefined, head: async () => null },
      leaseToken: claim.leaseToken,
      failedAt: "2026-09-01T00:00:00.000Z",
    };

    const first = await Effect.runPromise(Effect.exit(recoverExpiredStudySpokenAnswers(input)));
    expect(first._tag).toBe("Failure");
    await expect(Effect.runPromise(recoverExpiredStudySpokenAnswers(input))).resolves.toEqual({
      claimed: 1,
      recovered: 1,
      storageFailures: 0,
      fenced: 0,
    });
  });
});
