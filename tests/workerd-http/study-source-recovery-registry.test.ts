import { expect, test } from "vitest";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Layer } from "effect";
import { runStudySourceRecoveryCycle } from "../../apps/jobs-worker/src/study-source-recovery-cycle.ts";
import { makeGuestStudyRecoveryComposition } from "../../apps/jobs-worker/src/study-source-recovery-composition.ts";
import { makeStudySpokenAnswerRecoveryJob } from "../../apps/jobs-worker/src/study-spoken-answer-recovery.ts";
import { makeGuestStudyResourceExpiryJob } from "../../apps/jobs-worker/src/guest-study-resource-expiry-job.ts";
import { buildJobRegistry } from "../../apps/jobs-worker/src/registry.ts";
import { makeJobsWorkerDeclarations } from "../../apps/jobs-worker/src/index.ts";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const account = { claimed: 1, recovered: 1, storageFailures: 0, fenced: 0 };
const inertGuestRuntime = Layer.effect(ControlPlaneDb)(
  Effect.die("unexpected private Guest runtime"),
);
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
  expect(
    await run(
      Effect.flip(
        buildJobRegistry([
          selected,
          { ...selected, name: expiry.name, reads: expiry.reads, writes: expiry.writes },
        ]),
      ),
    ),
  ).toMatchObject({
    reason: "duplicate-table-writer",
    key: "postgres:guest_resource_session_reservations",
  });
  expect(deletes).toBe(0);
  expect(heads).toBe(0);
});
