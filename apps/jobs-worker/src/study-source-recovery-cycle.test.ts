import { expect, test } from "bun:test";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
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

test("source stages are serial and expiry commits one release at a time", async () => {
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
    },
  };
  expect(await run(runStudySourceRecoveryCycle(stages))).toEqual({ account, guest, released: 2 });
  expect(order).toEqual(["account", "guest", "expiry", "expiry", "expiry"]);
});
test("unknown original Account commit stops Guest/expiry and is not retried within cycle", async () => {
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
    },
  };
  expect(await run(Effect.flip(runStudySourceRecoveryCycle(stages)))).toBe(failedCommit);
  expect(accountCalls).toBe(1);
  expect(later).toBe(0);
});
test("unknown captured Guest ACK/finalizer stops release instead of inventing terminal work", async () => {
  let releases = 0;
  const stages: StudySourceRecoveryStages = {
    account: Effect.succeed(account),
    guest: {
      closed: Effect.fail(failedCommit),
      releaseNext: () =>
        Effect.sync(() => {
          releases++;
          return { state: "released" as const, terminalState: "completed" as const };
        }),
      maximumReleases: 4,
    },
  };
  expect(await run(Effect.flip(runStudySourceRecoveryCycle(stages)))).toBe(failedCommit);
  expect(releases).toBe(0);
});
test("bounded expiry stops on first unknown and never exceeds reviewed maximum", async () => {
  let releases = 0;
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
    },
  };
  expect((await run(runStudySourceRecoveryCycle(stages))).released).toBe(4);
  expect(releases).toBe(4);
  releases = 0;
  const uncertainty: StudySourceRecoveryStages = {
    account: stages.account,
    guest: {
      closed: Effect.succeed(guest),
      maximumReleases: 4,
      releaseNext: () =>
        Effect.sync(() => {
          releases++;
        }).pipe(Effect.flatMap(() => Effect.fail(failedCommit))),
    },
  };
  expect(await run(Effect.flip(runStudySourceRecoveryCycle(uncertainty)))).toBe(failedCommit);
  expect(releases).toBe(1);
});
