import { afterAll, describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Fiber } from "effect";
import { Client } from "pg";

import {
  makeDirectPostgresControlPlaneLayer,
  makeReadOnlyPostgresControlPlaneLayer,
} from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-adapter-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-adapter-suite-complete\n";

if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
let completedTestCount = 0;

type ProbeRow = { readonly run_id: string; readonly phase: string };

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return check();
}

async function queryProbe(admin: Client, runId: string): Promise<readonly ProbeRow[]> {
  const result = await admin.query<ProbeRow>({
    text: "SELECT run_id, phase FROM api_next_pg17_abort_probe WHERE run_id = $1",
    values: [runId],
  });
  return result.rows;
}

function runId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

suite("Postgres 17 control-plane harness", () => {
  test("proves backend termination, rollback, commit, and ordinary rollback", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const admin = new Client({ connectionString });
    const abortedId = runId("aborted");
    const committedId = runId("committed");
    const rolledBackId = runId("rolled_back");
    let backendPid: number | undefined;

    const runAdapter = <A, E>(use: (db: ControlPlaneDb["Service"]) => Effect.Effect<A, E>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* use(db);
        }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connectionString))),
      );

    try {
      await admin.connect();
      await admin.query(`
        CREATE TABLE IF NOT EXISTS api_next_pg17_abort_probe (
          run_id TEXT PRIMARY KEY,
          phase TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      const abortedProgram = runAdapter((db) =>
        db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "harness.insert-aborted",
              text: "INSERT INTO api_next_pg17_abort_probe (run_id, phase) VALUES ($1, $2)",
              values: [abortedId, "aborted"],
              readonly: false,
            });
            const pid = yield* transaction.execute<{ pid: number }>({
              label: "harness.backend-pid",
              text: "SELECT pg_backend_pid() AS pid",
              values: [],
              readonly: true,
            });
            backendPid = Number(pid.rows[0]?.pid);
            yield* Effect.timeout(
              transaction.execute({
                label: "harness.pg-sleep",
                text: "SELECT pg_sleep(10)",
                values: [],
                readonly: true,
              }),
              250,
            );
          }),
        ),
      );
      const abortedFiber = Effect.runFork(Effect.flip(abortedProgram));
      expect(await waitFor(async () => backendPid !== undefined, 2_000)).toBe(true);
      if (backendPid === undefined) throw new Error("adapter never returned a backend pid");

      const backendTerminated = await waitFor(async () => {
        const activity = await admin.query<{ pid: number }>({
          text: "SELECT pid FROM pg_stat_activity WHERE pid = $1",
          values: [backendPid],
        });
        return activity.rows.length === 0;
      }, 15_000);
      expect(backendTerminated).toBe(true);
      const abortedError = await Effect.runPromise(Fiber.join(abortedFiber));
      expect(abortedError).toMatchObject({ _tag: "TimeoutError" });
      expect(await queryProbe(admin, abortedId)).toEqual([]);

      await Effect.runPromise(
        runAdapter((db) =>
          db.withTransaction((transaction) =>
            transaction.execute({
              label: "harness.insert-committed",
              text: "INSERT INTO api_next_pg17_abort_probe (run_id, phase) VALUES ($1, $2)",
              values: [committedId, "committed"],
              readonly: false,
            }),
          ),
        ),
      );
      expect(await queryProbe(admin, committedId)).toEqual([
        { run_id: committedId, phase: "committed" },
      ]);

      const rollbackProgram = runAdapter((db) =>
        db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "harness.insert-rolled-back",
              text: "INSERT INTO api_next_pg17_abort_probe (run_id, phase) VALUES ($1, $2)",
              values: [rolledBackId, "rolled-back"],
              readonly: false,
            });
            return yield* Effect.fail("expected body failure");
          }),
        ),
      );
      await expect(Effect.runPromise(rollbackProgram)).rejects.toBe("expected body failure");
      expect(await queryProbe(admin, rolledBackId)).toEqual([]);
    } finally {
      await admin.query({
        text: "DELETE FROM api_next_pg17_abort_probe WHERE run_id = ANY($1)",
        values: [[abortedId, committedId, rolledBackId]],
      });
      await admin.end();
    }
    completedTestCount += 1;
  }, 20_000);

  test("enforces the gateway authority adapter as read-only in PostgreSQL", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const admin = new Client({ connectionString });
    const rejectedId = runId("gateway_readonly");
    try {
      await admin.connect();
      await admin.query(`
        CREATE TABLE IF NOT EXISTS api_next_pg17_abort_probe (
          run_id TEXT PRIMARY KEY,
          phase TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const program = Effect.scoped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const mode = yield* db.execute<{ transaction_read_only: string }>({
            label: "gateway.readonly-mode",
            text: "SHOW transaction_read_only",
            values: [],
            readonly: true,
          });
          const insertion = yield* Effect.flip(
            db.execute({
              label: "gateway.mislabeled-write",
              text: "INSERT INTO api_next_pg17_abort_probe (run_id, phase) VALUES ($1, $2)",
              values: [rejectedId, "must-not-write"],
              readonly: true,
            }),
          );
          return { mode, insertion };
        }).pipe(Effect.provide(makeReadOnlyPostgresControlPlaneLayer(connectionString))),
      );
      const result = await Effect.runPromise(program);
      expect(result.mode.rows).toEqual([{ transaction_read_only: "on" }]);
      expect(result.insertion).toMatchObject({
        _tag: "ControlPlaneStatementFailed",
        outcomeCertainty: "completed",
      });
      expect(await queryProbe(admin, rejectedId)).toEqual([]);
    } finally {
      await admin.query({
        text: "DELETE FROM api_next_pg17_abort_probe WHERE run_id = $1",
        values: [rejectedId],
      });
      await admin.end();
    }
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 2) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
