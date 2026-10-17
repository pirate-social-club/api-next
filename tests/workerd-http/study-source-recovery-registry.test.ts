import { ControlPlaneDb } from "@pirate/application";
import { makeGuestEphemeralCleanupStage } from "@pirate/platform-cf/guest-ephemeral-cleanup";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
} from "@pirate/platform-cf/postgres";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { makeGuestStudyResourceExpiryJob } from "../../apps/jobs-worker/src/guest-study-resource-expiry-job.ts";
import { makeJobsWorkerDeclarations } from "../../apps/jobs-worker/src/index.ts";
import { buildJobRegistry } from "../../apps/jobs-worker/src/registry.ts";
import { makeGuestStudyRecoveryComposition } from "../../apps/jobs-worker/src/study-source-recovery-composition.ts";
import { runStudySourceRecoveryCycle } from "../../apps/jobs-worker/src/study-source-recovery-cycle.ts";
import { makeStudySpokenAnswerRecoveryJob } from "../../apps/jobs-worker/src/study-spoken-answer-recovery.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const account = { claimed: 1, recovered: 1, storageFailures: 0, fenced: 0 };
const inertGuestRuntime = Layer.effect(ControlPlaneDb)(
  Effect.die("unexpected private Guest runtime"),
);
const inertGuestDeleteBucket = {
  delete: async (_key: string): Promise<void> => {
    throw new Error("unexpected private Guest DELETE");
  },
};
test("private Guest stages are absent unless a reviewed composition is supplied", async () => {
  expect(await run(runStudySourceRecoveryCycle({ account: Effect.succeed(account) }))).toEqual({
    account,
    guest: null,
    released: 0,
  });
  let guestCompositionCalls = 0;
  const guestComposition = makeGuestStudyRecoveryComposition(
    inertGuestRuntime,
    inertGuestDeleteBucket,
  );
  const declarations = makeJobsWorkerDeclarations(
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
    () => {
      guestCompositionCalls++;
      return guestComposition();
    },
  );
  expect(declarations.map(({ name, lane, writes }) => ({ name, lane, writes }))).toEqual([
    {
      name: "notifications.recover-publications",
      lane: "notification-delivery",
      writes: [
        "postgres:notification_inbox",
        "postgres:notification_publication_deliveries",
        "postgres:content_publication_outbox",
      ],
    },
  ]);
  expect(
    declarations
      .flatMap(({ reads, writes }) => [...reads, ...writes])
      .filter(
        (resource) =>
          resource.startsWith("postgres:guest_") ||
          resource.startsWith("postgres:learner_audio_") ||
          !resource.startsWith("postgres:"),
      ),
  ).toEqual([]);
  expect(guestCompositionCalls).toBe(0);
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
    makeGuestStudyRecoveryComposition(inertGuestRuntime, inertGuestDeleteBucket),
  );
  expect(plain.name).toBe(selected.name);
  expect(plain.schedule).toBe("* * * * *");
  expect(plain.timeout).toBe("45 seconds");
  expect(plain.writes).not.toContain("postgres:guest_resource_session_reservations");
  expect(selected.writes).toContain("postgres:guest_resource_session_reservations");
  expect(selected.writes).toContain("postgres:guest_resource_edge_locks");
  for (const table of [
    "postgres:learner_audio_upload_cleanup_commands",
    "postgres:learner_audio_delete_batches",
    "postgres:learner_audio_delete_commands",
    "postgres:learner_audio_delete_sources",
    "postgres:learner_audio_delete_batch_items",
  ])
    expect(selected.reads).toContain(table);
  expect(plain.writes).not.toContain("postgres:learner_audio_upload_attempts");
  expect(plain.writes).not.toContain("postgres:learner_audio_upload_cleanup_commands");
  expect(selected.writes).toContain("postgres:learner_audio_upload_attempts");
  expect(selected.writes).toContain("postgres:learner_audio_upload_cleanup_commands");
  expect(selected.writes).toContain("postgres:learner_audio_artifacts");
  expect(new Set(selected.writes).size).toBe(selected.writes.length);
  expect(new Set(selected.reads).size).toBe(selected.reads.length);
  expect(selected.expectedFailures).toContain("GuestEphemeralStorageOutcomeUnknown");
  expect(selected.severity.expectedFailure.GuestEphemeralStorageOutcomeUnknown).toBe("high");
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

// Finite driver boundary test, not native SQL/producer acceptance. Exercise the
// actual SDK stage through the real PostgreSQL adapter; no fake store outcome,
// grant, provider, remote bucket or module substitute is introduced.
function cleanupDriverFixture(failure: "delete" | "confirm-commit") {
  const order: string[] = [];
  let inTransaction = false,
    commits = 0,
    prepares = 0,
    confirms = 0,
    deletes = 0;
  const cleanup = {
    cleanupId: "cleanup-original",
    uploadAttemptId: "upload-original",
    attemptId: "attempt-original",
    contentDigest: "a".repeat(64),
    objectRef: `learner-audio/study/attempt-original/${"a".repeat(64)}`,
  };
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {
      inTransaction = false;
    },
    query: async ({ text }) => {
      if (text.startsWith("BEGIN")) inTransaction = true;
      if (text === "COMMIT") {
        inTransaction = false;
        commits++;
        if (failure === "confirm-commit" && commits === 2)
          throw new Error("controlled lost confirmation COMMIT acknowledgement");
      }
      if (text === "ROLLBACK") inTransaction = false;
      if (text.startsWith("SELECT current_setting"))
        return {
          rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }],
          rowCount: 1,
        };
      if (text.includes("prepare_next_guest_ephemeral_audio_cleanup_private_v1")) {
        prepares++;
        order.push("prepare");
        return { rows: [{ result: { state: "prepared", cleanup } }], rowCount: 1 };
      }
      if (text.includes("confirm_guest_ephemeral_audio_cleanup_private_v1")) {
        confirms++;
        order.push("confirm");
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/ephemeral", {
    clientFactory: () => client,
    logger: { info: () => {}, error: () => {} },
  });
  const cleanupEffect = makeGuestEphemeralCleanupStage({
    runtime,
    maximumDeletes: 4,
    bucket: {
      delete: async (key) => {
        expect(inTransaction).toBe(false);
        expect(key).toBe(cleanup.objectRef);
        deletes++;
        order.push("delete");
        if (failure === "delete") throw new Error("controlled DELETE outcome unknown");
      },
    },
  })();
  const effect = runStudySourceRecoveryCycle({
    account: Effect.sync(() => {
      order.push("account");
      return account;
    }),
    guest: {
      closed: Effect.sync(() => {
        order.push("guest");
        return { examined: 0, completed: 0, pending: 0, skipped: 0 };
      }),
      maximumReleases: 4,
      releaseNext: () =>
        Effect.sync(() => {
          order.push("expiry");
          return { state: "idle" as const };
        }),
      ephemeralCleanup: cleanupEffect,
    },
  });
  return { effect, order, counts: () => ({ prepares, confirms, deletes, commits, inTransaction }) };
}

test("actual cleanup SDK rejected DELETE stops the serial tick before confirm or next candidate", async () => {
  const f = cleanupDriverFixture("delete");
  const error = await run(Effect.flip(f.effect));
  expect(error).toMatchObject({
    _tag: "GuestEphemeralStorageOutcomeUnknown",
    cleanupId: "cleanup-original",
  });
  expect(f.order).toEqual(["account", "guest", "expiry", "prepare", "delete"]);
  expect(f.counts()).toEqual({
    prepares: 1,
    confirms: 0,
    deletes: 1,
    commits: 1,
    inTransaction: false,
  });
});
test("actual cleanup SDK confirmation COMMIT loss stops before a second exact-key candidate", async () => {
  const f = cleanupDriverFixture("confirm-commit");
  const error = await run(Effect.flip(f.effect));
  expect(error).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
  expect(f.order).toEqual(["account", "guest", "expiry", "prepare", "delete", "confirm"]);
  expect(f.counts()).toEqual({
    prepares: 1,
    confirms: 1,
    deletes: 1,
    commits: 2,
    inTransaction: false,
  });
});
