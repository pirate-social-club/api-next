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
test("read metadata covers the real SQL video invoker closure and inbox reconciliation without claiming private evidence", async () => {
  const destination = await Bun.file(
    new URL(
      "../../../db/postgres/migrations/0272_notifications_video_destination.sql",
      import.meta.url,
    ),
  ).text();
  const access = destination.match(
    /CREATE FUNCTION video_detail_access_v1\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/u,
  )?.[1];
  if (!access) throw new Error("Actual video access function required for metadata review");
  const relations = new Set(
    Array.from(access.matchAll(/\b(?:FROM|JOIN)\s+(media_[a-z0-9_]+)/giu), (match) => match[1]),
  );
  expect(relations.size).toBe(13);
  const job = makeNotificationDeliveryJob(sink);
  for (const relation of relations) {
    if (!relation) throw new Error("Actual video relation name required");
    expect(job.reads).toContain(`postgres:${relation}`);
    expect(job.writes).not.toContain(`postgres:${relation}`);
  }
  const inbox = await Bun.file(
    new URL("../../../db/postgres/migrations/0271_notifications_inbox.sql", import.meta.url),
  ).text();
  const delivery = inbox.match(
    /CREATE FUNCTION deliver_comment_notification_v1\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/u,
  )?.[1];
  if (!delivery) throw new Error("Actual delivery function required for metadata review");
  expect(delivery).toMatch(/SELECT notification_id INTO inbox_id FROM notification_inbox/u);
  expect(job.reads).toContain("postgres:notification_inbox");
  expect(new Set(job.reads).size).toBe(job.reads.length);
  const privateAudit = await Bun.file(
    new URL(
      "../../../db/postgres/migrations/0273_notifications_video_alias_audit.sql",
      import.meta.url,
    ),
  ).text();
  const privateTables = Array.from(
    privateAudit.matchAll(/CREATE TABLE (video_[a-z0-9_]+)/gu),
    (match) => match[1],
  );
  expect(privateTables).toHaveLength(3);
  for (const table of privateTables) {
    if (!table) throw new Error("Actual private evidence table required");
    expect(job.reads).not.toContain(`postgres:${table}`);
    expect(job.writes).not.toContain(`postgres:${table}`);
  }
});
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
