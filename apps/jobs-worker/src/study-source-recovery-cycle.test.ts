import { expect, test } from "bun:test";
import { ControlPlaneDb, ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  runStudySourceRecoveryCycle,
  type StudySourceRecoveryStages,
} from "./study-source-recovery-cycle.ts";
import { makeGuestStudyRecoveryComposition } from "./study-source-recovery-composition.ts";
import { makeStudySpokenAnswerRecoveryJob } from "./study-spoken-answer-recovery.ts";
import { makeGuestStudyResourceExpiryJob } from "./guest-study-resource-expiry-job.ts";
import { buildJobRegistry } from "./registry.ts";
import { makeJobsWorkerDeclarations } from "./index.ts";
const inertGuestRuntime = Layer.effect(ControlPlaneDb)(
  Effect.die("unexpected private Guest runtime"),
);
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
test("private Guest stages are absent unless a reviewed composition is supplied", async () => {
  expect(await run(runStudySourceRecoveryCycle({ account: Effect.succeed(account) }))).toEqual({
    account,
    guest: null,
    released: 0,
  });
  expect(
    makeJobsWorkerDeclarations(
      {},
      "https://rpc.example",
      { enabled: false },
      "development",
      null,
      false,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      makeGuestStudyRecoveryComposition(inertGuestRuntime),
    ),
  ).toEqual([]);
});
test("one real combined registry declaration owns shared tables and raw storage is unused", async () => {
  let deletes = 0,
    heads = 0;
  const bucket = {
    delete: async () => {
      deletes++;
    },
    head: async () => {
      heads++;
      return null;
    },
  };
  const plain = makeStudySpokenAnswerRecoveryJob({}, bucket);
  const selected = makeStudySpokenAnswerRecoveryJob(
    {},
    bucket,
    makeGuestStudyRecoveryComposition(inertGuestRuntime),
  );
  expect(plain.name).toBe(selected.name);
  expect(plain.schedule).toBe("* * * * *");
  expect(plain.timeout).toBe("45 seconds");
  expect(plain.writes).not.toContain("postgres:guest_resource_session_reservations");
  expect(selected.writes).toContain("postgres:guest_resource_session_reservations");
  expect(selected.writes).toContain("postgres:guest_resource_edge_locks");
  expect((await run(buildJobRegistry([selected]))).declarations).toHaveLength(1);
  const expiry = makeGuestStudyResourceExpiryJob({
    alertSink: {},
    schedule: "* * * * *",
    timeout: "45 seconds",
    maximumReleases: 4,
  });
  expect(await run(Effect.flip(buildJobRegistry([selected, expiry])))).toMatchObject({
    reason: "duplicate-table-writer",
    key: "postgres:guest_resource_session_reservations",
  });
  expect(deletes).toBe(0);
  expect(heads).toBe(0);
});
