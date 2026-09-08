import { describe, expect, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { applyPostgresMigrationsInTransaction } from "../packages/platform-cf/src/postgres-migrations.ts";
import { runPostgresMigrations } from "./postgres-migrations";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = connectionString ? describe : describe.skip;
const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());

async function isolated(use: (admin: Client, scoped: string, schema: string) => Promise<void>) {
  if (!connectionString) throw new Error("test URL required");
  const schema = `reset_replay_${crypto.randomUUID().replaceAll("-", "")}`;
  const outside = `${schema}_outside`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    const version = await admin.query("SHOW server_version_num");
    expect(Number(version.rows[0].server_version_num)).toBeGreaterThanOrEqual(170000);
    expect(Number(version.rows[0].server_version_num)).toBeLessThan(180000);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE SCHEMA "${outside}"`);
    await admin.query(`CREATE TABLE "${outside}".sentinel (value text PRIMARY KEY)`);
    await admin.query(`INSERT INTO "${outside}".sentinel VALUES ('retained')`);
    await admin.query(`SET search_path TO "${schema}"`);
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema}`);
    await use(admin, url.toString(), schema);
    expect((await admin.query(`SELECT value FROM "${outside}".sentinel`)).rows).toEqual([
      { value: "retained" },
    ]);
  } finally {
    // Only UUID-named schemas created by this test are removed.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${outside}" CASCADE`);
    await admin.end();
  }
}

suite("pinned staging reset replay on PostgreSQL 17", () => {
  test("removal and full replay share the caller transaction and roll back on failed verification", async () => {
    await isolated(async (admin, scoped, schema) => {
      await admin.query("CREATE TABLE before_rebuild (value text PRIMARY KEY)");
      await admin.query("INSERT INTO before_rebuild VALUES ('original populated state')");
      const originalSchema = (await admin.query("SELECT $1::regnamespace::oid AS id", [schema]))
        .rows;
      let sameConnection = false;
      const rebuild = Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const before = yield* transaction.execute<{ pid: number }>({
              label: "reset.test.pid-before",
              text: "SELECT pg_backend_pid() AS pid",
              values: [],
              readonly: true,
            });
            yield* transaction.execute({
              label: "reset.test.remove",
              text: "DROP TABLE before_rebuild",
              values: [],
              readonly: false,
            });
            const result = yield* applyPostgresMigrationsInTransaction(
              transaction,
              plan.migrations,
            );
            expect(result.applied).toEqual(plan.migrations.map((migration) => migration.version));
            const after = yield* transaction.execute<{ pid: number }>({
              label: "reset.test.pid-after",
              text: "SELECT pg_backend_pid() AS pid",
              values: [],
              readonly: true,
            });
            sameConnection = before.rows[0]?.pid === after.rows[0]?.pid;
            const rows = yield* transaction.execute({
              label: "reset.test.ledger",
              text: "SELECT version, checksum FROM schema_migrations ORDER BY version",
              values: [],
              readonly: true,
            });
            expect(rows.rows).toEqual(
              plan.migrations.map(({ version, checksum }) => ({ version, checksum })),
            );
            return yield* Effect.fail(new Error("injected_post_replay_verification_failure"));
          }),
        );
      });
      await expect(
        Effect.runPromise(
          Effect.scoped(rebuild.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(scoped)))),
        ),
      ).rejects.toThrow("injected_post_replay_verification_failure");
      expect(sameConnection).toBe(true);
      expect((await admin.query("SELECT value FROM before_rebuild")).rows).toEqual([
        { value: "original populated state" },
      ]);
      expect((await admin.query("SELECT to_regclass('schema_migrations') AS ledger")).rows).toEqual(
        [{ ledger: null }],
      );
      expect((await admin.query("SELECT $1::regnamespace::oid AS id", [schema])).rows).toEqual(
        originalSchema,
      );
    });
  }, 60_000);

  test("replays exactly 0001–0119 once without touching an unrelated schema", async () => {
    await isolated(async (admin, scoped) => {
      const result = await runPostgresMigrations({
        connectionString: scoped,
        migrations: plan.migrations,
      });
      expect(result).toMatchObject({
        dryRun: false,
        result: { applied: plan.migrations.map((item) => item.version) },
      });
      expect(
        (await admin.query("SELECT version, checksum FROM schema_migrations ORDER BY version"))
          .rows,
      ).toEqual(plan.migrations.map(({ version, checksum }) => ({ version, checksum })));
      expect((await admin.query("SELECT count(*)::int AS count FROM personas")).rows).toEqual([
        { count: 0 },
      ]);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM persona_community_bindings")).rows,
      ).toEqual([{ count: 0 }]);
    });
  }, 60_000);

  test("rolls back earlier migration effects when replay fails midway", async () => {
    await isolated(async (admin, scoped, schema) => {
      // Failure injection is test-only; the release planner never accepts this SQL.
      const migrations = plan.migrations.map((item, index) =>
        index === 60
          ? { ...item, sql: "DO $$ BEGIN RAISE EXCEPTION 'test_replay_failure'; END $$;" }
          : item,
      );
      await expect(
        runPostgresMigrations({ connectionString: scoped, migrations }),
      ).rejects.toBeDefined();
      const relations = await admin.query(
        "SELECT relname FROM pg_class WHERE relnamespace = $1::regnamespace AND relname <> 'schema_migrations'",
        [schema],
      );
      expect(relations.rows).toEqual([]);
      const ledger = await admin.query("SELECT to_regclass('schema_migrations') AS ledger");
      if (ledger.rows[0].ledger !== null) {
        expect(
          (await admin.query("SELECT count(*)::int AS count FROM schema_migrations")).rows,
        ).toEqual([{ count: 0 }]);
      }
    });
  }, 60_000);
});
