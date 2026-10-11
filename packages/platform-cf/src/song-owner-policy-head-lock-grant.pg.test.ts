import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Postgres test URL required");
const suite = connectionString ? describe : describe.skip;
const grant = "0241_song_owner_policy_head_lock_runtime_grant.sql";

suite("song owner-policy head lock runtime grant", () => {
  test("a database migrated without the role file lets the runtime role take the lock", async () => {
    if (!connectionString) throw new Error("Postgres test URL required");
    const schema = `policy_lock_${randomUUID().replaceAll("-", "")}`;
    const lock = `${schema}.lock_song_owner_policy_head_v1(text,text)`;
    const admin = new Client({ connectionString });
    await admin.connect();
    const allowed = async (role: string) =>
      (await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, lock]))
        .rows[0].allowed;
    try {
      // Role and schema live only in this transaction, so a shared cluster is left unchanged.
      await admin.query("BEGIN");
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET LOCAL search_path TO ${schema}, pg_temp`);
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_next_app') THEN
          CREATE ROLE api_next_app NOLOGIN;
        END IF;
      END $$`);
      const migrations = await loadPostgresMigrations();
      const index = migrations.findIndex((migration) => migration.version === grant);
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index)) await admin.query(migration.sql);
      expect(await allowed("api_next_app")).toBe(false);
      await admin.query(migrations[index]?.sql ?? "");
      expect(await allowed("api_next_app")).toBe(true);
      // 0202 revoked the routine from PUBLIC; the grant must not reopen it.
      expect(await allowed("public")).toBe(false);
      // Replaying the statement is harmless on a database that already holds the grant.
      await admin.query(migrations[index]?.sql ?? "");
      expect(await allowed("api_next_app")).toBe(true);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  }, 120_000);
});
