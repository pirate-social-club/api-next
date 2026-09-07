import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  isDatabaseReconnectDenial,
  observeMaintainedDatabaseFence,
} from "./staging-persona-database-collector.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
async function fixture(
  use: (
    input: Parameters<typeof observeMaintainedDatabaseFence>[0],
    name: string,
    scoped: string,
  ) => Promise<void>,
) {
  if (!url) throw new Error("test URL required");
  const name = `fence_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: url });
  const scoped = new URL(url);
  scoped.pathname = `/${name}`;
  const admin = new Client({ connectionString: scoped.toString() });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE "${name}"`);
    await admin.connect();
    await admin.query("CREATE SCHEMA api_next");
    await admin.query("CREATE TABLE api_next.schema_migrations(version text)");
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD 'local-fixture-only'`);
    await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
    const runtime = new URL(scoped);
    runtime.username = name;
    runtime.password = "local-fixture-only";
    const identity = (await admin.query("SELECT current_user::text AS role")).rows[0].role;
    await use(
      {
        admin,
        expectedAdmin: identity,
        runtimes: [{ role: name, connectionString: runtime.toString() }],
        // Local PG harness has no TLS. This seam still makes a real independent connection.
        probeReconnect: async (raw) => {
          const client = new Client({ connectionString: raw, connectionTimeoutMillis: 2000 });
          try {
            await client.connect();
            return false;
          } catch (error) {
            return isDatabaseReconnectDenial(error);
          } finally {
            await client.end().catch(() => undefined);
          }
        },
      },
      name,
      scoped.toString(),
    );
  } finally {
    await admin.end();
    await root.query(`DROP DATABASE IF EXISTS "${name}"`);
    await root.query(`DROP ROLE IF EXISTS "${name}"`);
    await root.end();
  }
}
suite("maintained database fence collector", () => {
  test("proves real reconnect refusal and rejects PUBLIC, table and SET ROLE access", async () =>
    fixture(async (input, name) => {
      const result = await observeMaintainedDatabaseFence(input);
      expect(result).toMatchObject({
        databaseWrites: true,
        reconnectDenied: true,
        runtimeSessions: 0,
      });
      expect(JSON.stringify(result)).not.toContain(name);
      await input.admin.query(`GRANT CONNECT ON DATABASE "${name}" TO PUBLIC`);
      await expect(observeMaintainedDatabaseFence(input)).rejects.toThrow(
        "staging_database_fence_unproven",
      );
      await input.admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
      await input.admin.query(`GRANT SELECT ON api_next.schema_migrations TO "${name}"`);
      await expect(observeMaintainedDatabaseFence(input)).rejects.toThrow(
        "staging_database_fence_unproven",
      );
      await input.admin.query(`REVOKE SELECT ON api_next.schema_migrations FROM "${name}"`);
      await input.admin.query(`GRANT pg_read_all_data TO "${name}" WITH INHERIT FALSE, SET TRUE`);
      await expect(observeMaintainedDatabaseFence(input)).rejects.toThrow(
        "staging_database_fence_unproven",
      );
    }));
  test("refuses active sessions, observer impersonation and a failed reconnect probe without mutation", async () =>
    fixture(async (input, _name, scoped) => {
      const peer = new Client({ connectionString: scoped });
      await peer.connect();
      try {
        await expect(observeMaintainedDatabaseFence(input)).rejects.toThrow(
          "staging_database_fence_unproven",
        );
      } finally {
        await peer.end();
      }
      await expect(
        observeMaintainedDatabaseFence({ ...input, expectedAdmin: "different_observer" }),
      ).rejects.toThrow("staging_database_fence_unproven");
      await expect(
        observeMaintainedDatabaseFence({ ...input, probeReconnect: async () => false }),
      ).rejects.toThrow("staging_database_fence_unproven");
      expect((await observeMaintainedDatabaseFence(input)).runtimeSessions).toBe(0);
    }));
});
