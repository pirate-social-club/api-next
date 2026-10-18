/** Deterministic session-lifetime regression. The injected client never opens a
 * socket or executes SQL; real PG/persona/floor/ACL proof remains parent-held. */
import { expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { makeNotificationsVideoAdmissionStore } from "./notifications-video-admission.ts";
import { runVideoAdmissionFixture } from "./notifications-video-proof.pg-fixture.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const source = "-- deterministic session protocol fixture, not SQL execution\nSELECT 1";
const plan = {
  contract_sha256: "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
  plan_sha256: "a".repeat(64),
  alias_run_id: "00000000-0000-4000-8000-000000000001",
  paired_solid_sha256: "b".repeat(64),
  cutover_source_sha256: Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join(""),
};

function sessionFixture(failBatch = false) {
  const events: string[] = [];
  let closed = false;
  let receipt = false;
  const client: PostgresClientLike = {
    connect: async () => {
      events.push("connect");
    },
    end: async () => {
      closed = true;
      events.push("close");
    },
    query: async (statement: PostgresQueryConfig) => {
      events.push(statement.text);
      if (closed) throw new Error("Client was closed after layer release");
      if (statement.text.includes("process_video_alias_audit_batch_v1") && failBatch)
        throw Object.assign(new Error("fixture statement denied"), { code: "42501" });
      let rows: Record<string, unknown>[] = [];
      if (statement.text.includes("process_video_alias_audit_batch_v1")) rows = [{ examined: 1 }];
      if (statement.text.startsWith("SELECT plan_sha256,alias_run_id"))
        rows = receipt
          ? [
              {
                plan_sha256: plan.plan_sha256,
                alias_run_id: plan.alias_run_id,
                paired_solid_sha256: plan.paired_solid_sha256,
                cutover_source_sha256: plan.cutover_source_sha256,
              },
            ]
          : [];
      if (statement.text.includes("AS drained,"))
        rows = [{ drained: true, aliases_ready: true, producer_fenced: true }];
      if (statement.text.startsWith("INSERT INTO video_notification_cutovers_v1")) receipt = true;
      return { rows, rowCount: rows.length };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer(
    "postgres://protocol-fixture.invalid/unused",
    {
      clientFactory: () => client,
    },
  );
  return { events, runtime, closed: () => closed };
}

test("real adapter layer remains alive through async audit, drain, cutover and exact replay; closes once after the final action", async () => {
  const f = sessionFixture();
  const result = await runVideoAdmissionFixture(f.runtime, (store) =>
    Effect.gen(function* () {
      yield* store.startAudit({
        runId: plan.alias_run_id,
        planSha256: plan.plan_sha256,
        mode: "materialize",
      });
      yield* Effect.tryPromise(async () => {
        await Promise.resolve();
        expect(f.closed()).toBe(false);
      });
      const batch = yield* store.auditBatch({
        runId: plan.alias_run_id,
        planSha256: plan.plan_sha256,
      });
      const drain = yield* store.drain();
      const first = yield* store.cutover(plan, source);
      const replay = yield* store.cutover(plan, source);
      return { batch: batch.rows, drain, first, replay };
    }),
  );
  expect(result).toEqual({
    batch: [{ examined: 1 }],
    drain: { examined: 0, processed: 0, delivered: 0, suppressed: 0 },
    first: { alreadyCommitted: false },
    replay: { alreadyCommitted: true },
  });
  expect(f.events.filter((event) => event === "connect")).toHaveLength(1);
  expect(f.events.filter((event) => event === "COMMIT")).toHaveLength(5);
  expect(f.events.filter((event) => event === "close")).toHaveLength(1);
  expect(f.events.at(-1)).toBe("close");
});

test("audit failure preserves adapter error, rolls back, closes once and never proceeds to drain or cutover", async () => {
  const f = sessionFixture(true);
  await expect(
    runVideoAdmissionFixture(f.runtime, (store) =>
      Effect.gen(function* () {
        yield* store.startAudit({
          runId: plan.alias_run_id,
          planSha256: plan.plan_sha256,
          mode: "materialize",
        });
        yield* store.auditBatch({ runId: plan.alias_run_id, planSha256: plan.plan_sha256 });
        yield* store.drain();
        return yield* store.cutover(plan, source);
      }),
    ),
  ).rejects.toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "notifications.video.audit.batch",
    sqlState: "42501",
  });
  expect(
    f.events.filter((event) => event.includes("process_video_alias_audit_batch_v1")),
  ).toHaveLength(1);
  expect(f.events).toContain("ROLLBACK");
  expect(f.events.some((event) => event.includes("LOCK TABLE"))).toBe(false);
  expect(f.events.filter((event) => event === "close")).toHaveLength(1);
  expect(f.events.at(-1)).toBe("close");
});

test("the old escaped-service pattern reproduces transaction-begin failure after layer release", async () => {
  const f = sessionFixture();
  const escaped = await Effect.runPromise(ControlPlaneDb.pipe(Effect.provide(f.runtime)));
  expect(f.closed()).toBe(true);
  await expect(
    Effect.runPromise(
      makeNotificationsVideoAdmissionStore(escaped).startAudit({
        runId: plan.alias_run_id,
        planSha256: plan.plan_sha256,
        mode: "materialize",
      }),
    ),
  ).rejects.toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "control-plane.transaction.begin",
    sqlState: null,
    outcomeCertainty: "unknown",
  });
  expect(f.events.indexOf("close")).toBeLessThan(f.events.indexOf("BEGIN"));
});
