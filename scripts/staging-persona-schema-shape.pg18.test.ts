import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

const connectionString = process.env.CONTROL_PLANE_POSTGRES18_SHAPE_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES18_SHAPE_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES18_SHAPE_TEST_URL is required");
}
const suite = connectionString ? describe : describe.skip;
const artifacts = loadStagingResetArtifacts();
const plan = validateStagingResetArtifacts(artifacts);
const postgres17Reference = "2e295e58b965fd73e73167c1b6628efe28115fd01386d3fd155b104ba0d432fd";

async function databaseFixture(use: (admin: Client, url: string) => Promise<void>) {
  if (!connectionString) throw new Error("PostgreSQL 18 test URL required");
  const source = new URL(connectionString);
  if (source.hostname !== "127.0.0.1" || source.pathname !== "/postgres") {
    throw new Error("PostgreSQL 18 loopback test target required");
  }
  const database = `shape_pg18_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: source.toString() });
  const scoped = new URL(source);
  scoped.pathname = `/${database}`;
  scoped.searchParams.set("options", "-c search_path=api_next,pg_catalog");
  const admin = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    const version = Number(
      (await root.query("SHOW server_version_num")).rows[0]?.server_version_num,
    );
    expect(version).toBeGreaterThanOrEqual(180000);
    expect(version).toBeLessThan(190000);
    await root.query(`CREATE DATABASE "${database}"`);
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await use(admin, scoped.toString());
  } finally {
    await admin.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.end();
  }
}

suite("reset schema shape on disposable PostgreSQL 18.6", () => {
  test("matches the PostgreSQL 17 reference after exact baseline and exact migration replay", async () => {
    await databaseFixture(async (admin) => {
      await admin.query(artifacts.baseline);
      await admin.query("SET search_path=pg_catalog");
      expect(await readResetSchemaShape(admin)).toEqual({
        version: 1,
        object_count: 10_743,
        sha256: postgres17Reference,
      });
    });

    await databaseFixture(async (admin, url) => {
      const result = await runPostgresMigrations({
        connectionString: url,
        migrations: plan.migrations,
      });
      expect(result.result.applied).toEqual(plan.migrations.map(({ version }) => version));
      await admin.query("SET search_path=pg_catalog");
      expect(await readResetSchemaShape(admin)).toEqual({
        version: 1,
        object_count: 10_743,
        sha256: postgres17Reference,
      });

      await admin.query("CREATE TABLE api_next.shape_probe (value text NOT NULL)");
      const required = await readResetSchemaShape(admin);
      await admin.query("ALTER TABLE api_next.shape_probe ALTER COLUMN value DROP NOT NULL");
      expect((await readResetSchemaShape(admin)).sha256).not.toBe(required.sha256);

      await admin.query("ALTER TABLE api_next.shape_probe ALTER COLUMN value SET NOT NULL");
      const withoutCheck = await readResetSchemaShape(admin);
      await admin.query(
        "ALTER TABLE api_next.shape_probe ADD CONSTRAINT shape_probe_value_check CHECK (length(value)>0)",
      );
      expect((await readResetSchemaShape(admin)).sha256).not.toBe(withoutCheck.sha256);

      await admin.query("CREATE TABLE api_next.shape_invalid (value text)");
      await admin.query(
        "ALTER TABLE api_next.shape_invalid ADD CONSTRAINT shape_invalid_value_nn NOT NULL value NOT VALID",
      );
      await expect(readResetSchemaShape(admin)).rejects.toThrow("reset_baseline_shape_unsupported");

      await admin.query("DROP TABLE api_next.shape_invalid");
      await admin.query("CREATE TABLE api_next.shape_named (value text)");
      await admin.query(
        "ALTER TABLE api_next.shape_named ADD CONSTRAINT explicit_name NOT NULL value",
      );
      await expect(readResetSchemaShape(admin)).rejects.toThrow("reset_baseline_shape_unsupported");

      await admin.query("DROP TABLE api_next.shape_named");
      const withoutDomain = await readResetSchemaShape(admin);
      await admin.query("CREATE DOMAIN api_next.shape_domain AS text NOT NULL");
      expect((await readResetSchemaShape(admin)).sha256).not.toBe(withoutDomain.sha256);
    });
  }, 120_000);
});
