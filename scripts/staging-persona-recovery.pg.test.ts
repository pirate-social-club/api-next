import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { runPostgresMigrations } from "./postgres-migrations";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import {
  loadStagingResetArtifacts,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (connectionString) localRecoveryTestUrl(connectionString);
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = connectionString ? describe : describe.skip;
const plan = validateStagingResetArtifacts(loadStagingResetArtifacts());

// Test-only tools against UUID-created databases. Never accepts a live recovery target.
async function tool(url: URL, executable: string, args: string[], input?: Uint8Array) {
  const localContainer = process.env.CONTROL_PLANE_POSTGRES_RECOVERY_TEST_CONTAINER;
  const env = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
    PGCONNECT_TIMEOUT: "10",
  };
  const command = localContainer
    ? ["docker", "exec", "-i", ...Object.keys(env).flatMap((key) => ["--env", key]), localContainer]
    : [
        "docker",
        "run",
        "--rm",
        "-i",
        "--network=host",
        "--memory=512m",
        "--cpus=1",
        ...Object.keys(env).flatMap((key) => ["--env", key]),
        "postgres:17",
      ];
  const child = Bun.spawn([...command, executable, ...args], {
    env: { ...process.env, ...env },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, bytes] = await Promise.all([
      child.exited,
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error("local_recovery_tool_failed");
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

suite("data-bearing recovery rehearsal on PostgreSQL 17", () => {
  test("restores the 0109 ledger, identities, exact schema, ACLs, sequence and extension", async () => {
    if (!connectionString) throw new Error("test URL required");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const sourceName = `recovery_source_${suffix}`;
    const restoredName = `recovery_restored_${suffix}`;
    const schemaName = `recovery_schema_${suffix}`;
    const readerRole = `recovery_reader_${suffix}`;
    const admin = new Client({ connectionString });
    const sourceUrl = new URL(connectionString);
    const restoredUrl = new URL(connectionString);
    sourceUrl.pathname = `/${sourceName}`;
    restoredUrl.pathname = `/${restoredName}`;
    sourceUrl.searchParams.delete("options");
    restoredUrl.searchParams.delete("options");
    const schemaUrl = new URL(restoredUrl);
    schemaUrl.pathname = `/${schemaName}`;
    const source = new Client({ connectionString: sourceUrl.toString() });
    const restored = new Client({ connectionString: restoredUrl.toString() });
    await admin.connect();
    try {
      const version = Number(
        (await admin.query("SHOW server_version_num")).rows[0].server_version_num,
      );
      expect(version).toBeGreaterThanOrEqual(170000);
      expect(version).toBeLessThan(180000);
      await admin.query(`CREATE DATABASE "${sourceName}" TEMPLATE template0`);
      await admin.query(`CREATE DATABASE "${restoredName}" TEMPLATE template0`);
      await admin.query(`CREATE DATABASE "${schemaName}" TEMPLATE template0`);
      await admin.query(`CREATE ROLE "${readerRole}" NOLOGIN`);
      await source.connect();
      await source.query(
        "CREATE SCHEMA api_next; CREATE SCHEMA recovery_extension; CREATE EXTENSION hstore SCHEMA recovery_extension",
      );
      const migrationUrl = new URL(sourceUrl);
      migrationUrl.searchParams.set("options", "-c search_path=api_next");
      await runPostgresMigrations({
        connectionString: migrationUrl.toString(),
        migrations: plan.migrations.slice(0, 109),
      });
      await source.query("SET search_path TO api_next");
      // Synthetic historical identity rows; no production or staging data is read.
      await source.query("INSERT INTO users (user_id) VALUES ('recovery-account')");
      await source.query(`CREATE TABLE recovery_probe (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload text NOT NULL, properties recovery_extension.hstore);
        INSERT INTO recovery_probe (payload, properties) VALUES ('original timestamp 2026-09-05 17:05:00+00', 'key=>value'), ('hidden by row policy', NULL);
        SELECT setval('api_next.recovery_probe_id_seq', 41, true);
        ALTER TABLE recovery_probe ENABLE ROW LEVEL SECURITY;
        CREATE POLICY recovery_read ON recovery_probe FOR SELECT TO "${readerRole}" USING (id = 1);
        GRANT USAGE ON SCHEMA api_next TO "${readerRole}";
        GRANT SELECT ON recovery_probe TO "${readerRole}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT ON TABLES TO "${readerRole}";
        CREATE FUNCTION recovery_search_path() RETURNS text LANGUAGE sql SET search_path TO api_next, recovery_extension AS $$ SELECT current_setting('search_path') $$;`);
      // Fixed pg_dump restrict key eliminates only tool-generated randomness, not SQL.
      const schemaArgs = ["--schema-only", "--restrict-key=RecoveryRehearsalFixedKey"];
      // PostgreSQL folds some CHECK-expression parentheses when parsing a dump.
      // Canonicalize through a separate schema-only restore, never string rewriting.
      const schemaArchive = await tool(sourceUrl, "pg_dump", ["--format=custom", "--schema-only"]);
      await tool(
        schemaUrl,
        "pg_restore",
        ["--dbname", schemaName, "--single-transaction", "--exit-on-error"],
        schemaArchive,
      );
      const beforeSchema = digest(await tool(schemaUrl, "pg_dump", schemaArgs));
      const archive = await tool(sourceUrl, "pg_dump", ["--format=custom"]);
      expect(archive.byteLength).toBeGreaterThan(0);
      // A separate connection and database is the restore target; the source survives.
      await tool(
        restoredUrl,
        "pg_restore",
        ["--dbname", restoredName, "--single-transaction", "--exit-on-error"],
        archive,
      );
      await restored.connect();
      expect((await restored.query("SELECT current_database() AS name")).rows[0].name).toBe(
        restoredName,
      );
      expect(digest(await tool(restoredUrl, "pg_dump", schemaArgs))).toBe(beforeSchema);
      const reads = [
        "SELECT version, checksum FROM api_next.schema_migrations ORDER BY version",
        "SELECT * FROM api_next.users ORDER BY user_id",
        "SELECT * FROM api_next.personas ORDER BY persona_id",
        "SELECT * FROM api_next.persona_pending_profiles ORDER BY persona_id",
        "SELECT * FROM api_next.persona_wallet_assignments ORDER BY assignment_id",
        "SELECT * FROM api_next.recovery_probe ORDER BY id",
        "SELECT last_value, is_called FROM api_next.recovery_probe_id_seq",
        "SELECT extname, extversion FROM pg_extension ORDER BY extname",
        "SELECT api_next.recovery_search_path()",
      ];
      for (const sql of reads)
        expect((await restored.query(sql)).rows).toEqual((await source.query(sql)).rows);
      const tables = await source.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'api_next' ORDER BY tablename",
      );
      for (const { name } of tables.rows) {
        const sql = `SELECT to_jsonb(row_value)::text AS row FROM api_next."${name.replaceAll('"', '""')}" AS row_value ORDER BY to_jsonb(row_value)::text COLLATE "C"`;
        expect((await restored.query(sql)).rows).toEqual((await source.query(sql)).rows);
      }
      expect(
        (await restored.query("SELECT count(*)::int AS count FROM api_next.personas")).rows[0]
          .count,
      ).toBe(1);
      expect(
        (await restored.query("SELECT nextval('api_next.recovery_probe_id_seq') AS value")).rows[0]
          .value,
      ).toBe("42");
      await restored.query(`SET ROLE "${readerRole}"`);
      expect(
        (await restored.query("SELECT payload FROM api_next.recovery_probe")).rows,
      ).toHaveLength(1);
      await expect(
        restored.query("INSERT INTO api_next.recovery_probe (payload) VALUES ('denied')"),
      ).rejects.toMatchObject({ code: "42501" });
      await restored.query("RESET ROLE");
      // The comparison must notice a missing grant, not normalize it away.
      await restored.query(`REVOKE SELECT ON api_next.recovery_probe FROM "${readerRole}"`);
      expect(digest(await tool(restoredUrl, "pg_dump", schemaArgs))).not.toBe(beforeSchema);
      expect((await source.query("SELECT payload FROM api_next.recovery_probe")).rows).toHaveLength(
        2,
      );
    } finally {
      await source.end();
      await restored.end();
      // Only the UUID test databases and role created above are disposable.
      await admin.query(`DROP DATABASE IF EXISTS "${restoredName}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${schemaName}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${sourceName}"`);
      await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
      await admin.end();
    }
  }, 180_000);
});
