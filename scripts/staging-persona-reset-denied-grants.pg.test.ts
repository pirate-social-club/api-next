import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { readResetGrantCatalog } from "./staging-persona-grant-catalog";
import { localRecoveryTestUrl } from "./staging-persona-recovery-test-target";
import {
  denyReplayedRuntimeGrants,
  verifyResetRuntimeDenied,
} from "./staging-persona-reset-denied-grants";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("local test URL required");
const suite = raw ? describe : describe.skip;

async function fixture(
  use: (admin: Client, observer: Client, runtime: string, member: string) => Promise<void>,
) {
  const source = localRecoveryTestUrl(raw ?? "");
  const database = `denied_${crypto.randomUUID().replaceAll("-", "")}`;
  const runtime = `${database}_runtime`;
  const member = `${database}_member`;
  const root = new Client({ connectionString: source.toString() });
  const scoped = new URL(source);
  scoped.pathname = `/${database}`;
  const admin = new Client({ connectionString: scoped.toString() });
  const observer = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${database}"`);
    await root.query(
      `CREATE ROLE "${runtime}"; CREATE ROLE "${member}"; GRANT "${member}" TO "${runtime}" WITH INHERIT FALSE, SET TRUE`,
    );
    await admin.connect();
    await observer.connect();
    await admin.query("CREATE SCHEMA api_next; CREATE TABLE api_next.retained(id int)");
    await use(admin, observer, runtime, member);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end();
    await observer.end();
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
    await root.query(`DROP ROLE IF EXISTS "${runtime}"; DROP ROLE IF EXISTS "${member}"`);
    await root.end();
  }
}

suite("reset denied grant handoff", () => {
  test("default, PUBLIC and SET ROLE grants are denied before commit without changing defaults", async () =>
    fixture(async (admin, observer, runtime, member) => {
      await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT SELECT ON TABLES TO "${runtime}";
      ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT UPDATE ON SEQUENCES TO "${member}"`);
      const defaults = (await readResetGrantCatalog(admin)).defaults_sha256;
      await admin.query("BEGIN");
      await admin.query(
        "CREATE FUNCTION api_next.retained_routine() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      );
      await admin.query(`CREATE TABLE api_next.replayed(id serial); GRANT INSERT ON api_next.replayed TO PUBLIC;
      GRANT UPDATE ON api_next.replayed TO "${member}"`);
      await expect(verifyResetRuntimeDenied(admin, runtime)).rejects.toThrow();
      await verifyResetRuntimeDenied(observer, runtime);
      await denyReplayedRuntimeGrants(admin, runtime);
      await admin.query("COMMIT");
      await verifyResetRuntimeDenied(observer, runtime);
      expect((await readResetGrantCatalog(admin)).defaults_sha256).toBe(defaults);
      expect(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'api_next.retained_routine()','EXECUTE') AS allowed",
            [runtime],
          )
        ).rows[0].allowed,
      ).toBe(true);
      expect(
        (await admin.query("SELECT to_regclass('api_next.replayed') IS NOT NULL AS present"))
          .rows[0].present,
      ).toBe(true);
      await admin.query(`GRANT SELECT ON api_next.replayed TO "${runtime}"`);
      await expect(verifyResetRuntimeDenied(observer, runtime)).rejects.toThrow();
    }));

  test("unsupported column grants fail and the whole replay transaction rolls back", async () =>
    fixture(async (admin, observer, runtime) => {
      await admin.query("BEGIN");
      await admin.query(
        `CREATE TABLE api_next.unsupported(id int); GRANT SELECT(id) ON api_next.unsupported TO "${runtime}"`,
      );
      await expect(denyReplayedRuntimeGrants(admin, runtime)).rejects.toThrow(
        "reset_column_grants_unsupported",
      );
      await admin.query("ROLLBACK");
      await verifyResetRuntimeDenied(observer, runtime);
      expect(
        (await admin.query("SELECT to_regclass('api_next.unsupported') IS NULL AS absent")).rows[0]
          .absent,
      ).toBe(true);
    }));

  test("does not repair schema authority or accept a call outside an owned transaction", async () =>
    fixture(async (admin, _observer, runtime) => {
      await expect(denyReplayedRuntimeGrants(admin, runtime)).rejects.toThrow(
        "owned_transaction_required",
      );
      await admin.query("BEGIN");
      await admin.query(`GRANT USAGE ON SCHEMA api_next TO "${runtime}"`);
      await expect(denyReplayedRuntimeGrants(admin, runtime)).rejects.toThrow();
      expect(
        (
          await admin.query("SELECT has_schema_privilege($1,'api_next','USAGE') AS allowed", [
            runtime,
          ])
        ).rows[0].allowed,
      ).toBe(true);
      await admin.query("ROLLBACK");
    }));
});
