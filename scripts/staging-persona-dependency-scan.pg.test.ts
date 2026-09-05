import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import { observeResetDependencyClosure } from "./staging-persona-dependency-scan";
import { inspectStagingRemovalPlan } from "./staging-persona-removal-plan";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1") {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;

async function fixture(use: (admin: Client, scoped: string) => Promise<void>) {
  if (!url) throw new Error("test URL required");
  const database = `dependency_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: url });
  const scoped = new URL(url);
  scoped.pathname = `/${database}`;
  scoped.searchParams.set("options", "-c search_path=api_next");
  const admin = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await admin.query("CREATE SCHEMA reset_outside");
    await use(admin, scoped.toString());
  } finally {
    await admin.end();
    // Only this test's UUID database, without FORCE.
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.end();
  }
}

suite("reset dependency closure", () => {
  test("plans roots from the real pinned chain and keeps standalone objects distinct", async () => {
    await fixture(async (admin, scoped) => {
      const artifacts = loadStagingResetArtifacts();
      const plan = validateStagingResetArtifacts(artifacts);
      await runPostgresMigrations({ connectionString: scoped, migrations: plan.migrations });
      await admin.query('CREATE TABLE api_next."quoted table" (value int)');
      await admin.query('INSERT INTO api_next."quoted table" VALUES (7)');
      await admin.query('CREATE VIEW api_next.plan_view AS SELECT * FROM api_next."quoted table"');
      await admin.query("CREATE TYPE api_next.plan_enum AS ENUM ('one')");
      await admin.query("CREATE TYPE api_next.plan_composite AS (value int)");
      await admin.query("CREATE SEQUENCE api_next.plan_sequence");
      await admin.query("BEGIN READ ONLY");
      try {
        const result = await inspectStagingRemovalPlan(admin, artifacts);
        expect(result.execution_authorized).toBe(false);
        expect(result.roots.length).toBeGreaterThan(600);
        expect(
          result.roots.find((root) => root.identity === 'api_next."quoted table"')?.statement,
        ).toBe('DROP TABLE IF EXISTS api_next."quoted table" CASCADE');
        expect(result.roots.find((root) => root.identity === "api_next.plan_enum")?.phase).toBe(3);
        expect(
          result.roots.find((root) => root.identity === "api_next.plan_composite")?.phase,
        ).toBe(3);
        expect(result.roots.find((root) => root.identity === "api_next.plan_sequence")?.phase).toBe(
          4,
        );
        expect(result.roots.every((root) => !root.statement.includes("DROP SCHEMA"))).toBe(true);
        expect((await admin.query('SELECT * FROM api_next."quoted table"')).rows).toEqual([
          { value: 7 },
        ]);
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  }, 60_000);

  test("refuses unsupported roots even with a namespace-local closure", async () => {
    await fixture(async (admin) => {
      await admin.query('CREATE COLLATION api_next.plan_collation FROM "C"');
      await admin.query("BEGIN READ ONLY");
      try {
        await expect(inspectStagingRemovalPlan(admin, loadStagingResetArtifacts())).rejects.toThrow(
          "removal_plan_unsupported_objects",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  });

  test("accepts the complete pinned schema including internal TOAST objects", async () => {
    await fixture(async (admin, scoped) => {
      const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());
      await runPostgresMigrations({ connectionString: scoped, migrations: plan.migrations });
      const result = await observeResetDependencyClosure(admin);
      expect(result.execution_authorized).toBe(false);
      expect(result.object_count).toBeGreaterThan(119);
      expect(result.closure_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await observeResetDependencyClosure(admin)).toEqual(result);
    });
  }, 60_000);

  test("refuses a dependent outside view without dropping it", async () => {
    await fixture(async (admin) => {
      await admin.query("CREATE TABLE api_next.source (id int)");
      await admin.query("CREATE VIEW reset_outside.consumer AS SELECT * FROM api_next.source");
      await expect(observeResetDependencyClosure(admin)).rejects.toThrow(
        "reset_dependency_closure_unproven",
      );
      expect((await admin.query("SELECT * FROM reset_outside.consumer")).rows).toEqual([]);
    });
  });

  test("refuses an outside foreign key and admits it only after explicit fixture removal", async () => {
    await fixture(async (admin) => {
      await admin.query("CREATE TABLE api_next.source (id int PRIMARY KEY)");
      await admin.query("CREATE TABLE reset_outside.consumer (id int REFERENCES api_next.source)");
      await expect(observeResetDependencyClosure(admin)).rejects.toThrow(
        "reset_dependency_closure_unproven",
      );
      await admin.query("ALTER TABLE reset_outside.consumer DROP CONSTRAINT consumer_id_fkey");
      expect((await observeResetDependencyClosure(admin)).execution_authorized).toBe(false);
    });
  });

  test("refuses an extension in the target schema rather than cascading its removal", async () => {
    await fixture(async (admin) => {
      await admin.query("CREATE EXTENSION hstore WITH SCHEMA api_next");
      await expect(observeResetDependencyClosure(admin)).rejects.toThrow(
        "reset_dependency_closure_unproven",
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_extension WHERE extname='hstore'",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    });
  });

  test("preserves an outside extension used by a target table", async () => {
    await fixture(async (admin) => {
      await admin.query("CREATE EXTENSION hstore WITH SCHEMA reset_outside");
      await admin.query("CREATE TABLE api_next.source (value reset_outside.hstore)");
      expect((await observeResetDependencyClosure(admin)).execution_authorized).toBe(false);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_extension WHERE extname='hstore'",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    });
  });
});
