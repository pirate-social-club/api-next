import { expect, test } from "bun:test";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import { GuestEphemeralStorageOutcomeUnknown } from "@pirate/platform-cf/guest-ephemeral-cleanup";
import { Effect } from "effect";
import {
  runStudySourceRecoveryCycle,
  type StudySourceRecoveryStages,
} from "./study-source-recovery-cycle.ts";

const account = { claimed: 1, recovered: 1, storageFailures: 0, fenced: 0 };
const guest = { examined: 1, completed: 1, pending: 0, skipped: 0 };
const failedCommit = new ControlPlaneTransactionOutcomeUnknown({
  phase: "commit",
  label: "owned-cycle-test",
  limitMs: 1,
  elapsedMs: 1,
});
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

test("source stages await Account, Guest and each expiry release before original-key cleanup", async () => {
  const order: string[] = [];
  let releaseCalls = 0;
  const stages: StudySourceRecoveryStages = {
    account: Effect.sync(() => {
      order.push("account");
      return account;
    }),
    guest: {
      closed: Effect.sync(() => {
        order.push("guest");
        return guest;
      }),
      maximumReleases: 4,
      releaseNext: () =>
        Effect.sync(() => {
          order.push("expiry");
          releaseCalls++;
          return releaseCalls === 3
            ? { state: "idle" as const }
            : { state: "released" as const, terminalState: "expired" as const };
        }),
      ephemeralCleanup: Effect.sync(() => {
        order.push("cleanup");
      }),
    },
  };
  expect(await run(runStudySourceRecoveryCycle(stages))).toEqual({ account, guest, released: 2 });
  expect(order).toEqual(["account", "guest", "expiry", "expiry", "expiry", "cleanup"]);
});
test("unknown original Account commit stops Guest, expiry and cleanup without immediate retry", async () => {
  let accountCalls = 0,
    later = 0;
  const stages: StudySourceRecoveryStages = {
    account: Effect.sync(() => {
      accountCalls++;
    }).pipe(Effect.flatMap(() => Effect.fail(failedCommit))),
    guest: {
      closed: Effect.sync(() => {
        later++;
        return guest;
      }),
      releaseNext: () =>
        Effect.sync(() => {
          later++;
          return { state: "idle" as const };
        }),
      maximumReleases: 4,
      ephemeralCleanup: Effect.sync(() => {
        later++;
      }),
    },
  };
  expect(await run(Effect.flip(runStudySourceRecoveryCycle(stages)))).toBe(failedCommit);
  expect(accountCalls).toBe(1);
  expect(later).toBe(0);
});
test("unknown original Guest ACK or finalizer stops expiry and cleanup", async () => {
  let releases = 0,
    cleanups = 0;
  const stages: StudySourceRecoveryStages = {
    account: Effect.succeed(account),
    guest: {
      closed: Effect.fail(failedCommit),
      maximumReleases: 4,
      releaseNext: () =>
        Effect.sync(() => {
          releases++;
          return { state: "released" as const, terminalState: "completed" as const };
        }),
      ephemeralCleanup: Effect.sync(() => {
        cleanups++;
      }),
    },
  };
  expect(await run(Effect.flip(runStudySourceRecoveryCycle(stages)))).toBe(failedCommit);
  expect(releases).toBe(0);
  expect(cleanups).toBe(0);
});
test("bounded expiry reaches cleanup after its maximum, but first unknown prevents cleanup", async () => {
  let releases = 0,
    cleanups = 0;
  const stages: StudySourceRecoveryStages = {
    account: Effect.succeed(account),
    guest: {
      closed: Effect.succeed(guest),
      maximumReleases: 4,
      releaseNext: () =>
        Effect.sync(() => {
          releases++;
          return { state: "released" as const, terminalState: "expired" as const };
        }),
      ephemeralCleanup: Effect.sync(() => {
        cleanups++;
      }),
    },
  };
  expect((await run(runStudySourceRecoveryCycle(stages))).released).toBe(4);
  expect(releases).toBe(4);
  expect(cleanups).toBe(1);
  releases = 0;
  cleanups = 0;
  const uncertainty: StudySourceRecoveryStages = {
    account: stages.account,
    guest: {
      closed: Effect.succeed(guest),
      maximumReleases: 4,
      releaseNext: () =>
        Effect.sync(() => {
          releases++;
        }).pipe(Effect.flatMap(() => Effect.fail(failedCommit))),
      ephemeralCleanup: Effect.sync(() => {
        cleanups++;
      }),
    },
  };
  expect(await run(Effect.flip(runStudySourceRecoveryCycle(uncertainty)))).toBe(failedCommit);
  expect(releases).toBe(1);
  expect(cleanups).toBe(0);
});
test("cleanup storage or COMMIT uncertainty remains typed and is not retried within the cycle", async () => {
  const storageUnknown = new GuestEphemeralStorageOutcomeUnknown({ cleanupId: "cleanup-original" });
  for (const error of [storageUnknown, failedCommit]) {
    const order: string[] = [];
    const stages: StudySourceRecoveryStages = {
      account: Effect.sync(() => {
        order.push("account");
        return account;
      }),
      guest: {
        closed: Effect.sync(() => {
          order.push("guest");
          return guest;
        }),
        maximumReleases: 4,
        releaseNext: () =>
          Effect.sync(() => {
            order.push("expiry");
            return { state: "idle" as const };
          }),
        ephemeralCleanup: Effect.sync(() => {
          order.push("cleanup");
        }).pipe(Effect.flatMap(() => Effect.fail(error))),
      },
    };
    expect(await run(Effect.flip(runStudySourceRecoveryCycle(stages)))).toBe(error);
    expect(order).toEqual(["account", "guest", "expiry", "cleanup"]);
  }
});
test("absent explicit Guest composition executes Account only with the existing summary", async () => {
  expect(await run(runStudySourceRecoveryCycle({ account: Effect.succeed(account) }))).toEqual({
    account,
    guest: null,
    released: 0,
  });
});
