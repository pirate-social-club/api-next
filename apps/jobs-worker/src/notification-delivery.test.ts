import { expect, mock, test } from "bun:test";
import {
  AlertCollector,
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect } from "effect";
import { makeNotificationDeliveryJob } from "./notification-delivery.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeJobsWorkerDeclarations } = await import("./index.ts");

import { buildJobRegistry, JobContext } from "./registry.ts";

const context: JobContext["Service"] = {
  owner: "notifications-test",
  attemptId: "attempt",
  lease: () => {
    throw new Error("unused lease");
  },
  adapterSafety: { markAbortedOrFenced: () => undefined, isProven: () => true },
};
const sink = { environment: "development" as const };
test("production composition registers recovery and its run executes bounded persisted source selection and delivery", async () => {
  const declarations = makeJobsWorkerDeclarations(
    sink,
    "https://unused.invalid",
    { enabled: false },
    "development",
  );
  const registry = await Effect.runPromise(buildJobRegistry(declarations));
  const job = registry.byName.get("notifications.recover-publications");
  if (!job) throw new Error("production job missing");
  const statements: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    statements.push(statement);
    const rows = statement.readonly
      ? [{ outbox_event_id: "fact" }]
      : [{ result: { processed: true, delivered: true } }];
    return Effect.succeed({ rows: rows as never, rowCount: 1 });
  };
  await Effect.runPromise(
    job.run.pipe(
      Effect.provideService(ControlPlaneDb, {
        execute,
        withTransaction: (use) => use({ execute }),
      }),
      Effect.provideService(JobContext, context),
      Effect.provideService(AlertCollector, { emit: () => Effect.void }),
    ),
  );
  expect(statements.map((statement) => statement.label)).toEqual([
    "notifications.recover.facts",
    "notifications.deliver",
  ]);
  expect(statements[0]?.text).toContain("LIMIT 50");
  expect(job.writes).toContain("postgres:notification_inbox");
});
test("unknown transaction outcome escapes the job unchanged so the kernel stops ordinary retries", async () => {
  const unknown = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "notifications.deliver",
    limitMs: 1,
    elapsedMs: 1,
  });
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) =>
    statement.readonly
      ? Effect.succeed({ rows: [{ outbox_event_id: "fact" }] as never, rowCount: 1 })
      : Effect.fail(unknown);
  const error = await Effect.runPromise(
    makeNotificationDeliveryJob(sink).run.pipe(
      Effect.provideService(ControlPlaneDb, {
        execute,
        withTransaction: (use) => use({ execute }),
      }),
      Effect.provideService(JobContext, context),
      Effect.provideService(AlertCollector, { emit: () => Effect.void }),
      Effect.flip,
    ),
  );
  expect(error).toBe(unknown);
});
