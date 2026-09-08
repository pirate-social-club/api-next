import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { observeRuntimeDenial } from "./staging-persona-runtime-denial";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1") {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;

async function fixture(
  use: (admin: Client, runtime: Client, name: string, group: string) => Promise<void>,
) {
  if (!url) throw new Error("test URL required");
  const name = `denial_${crypto.randomUUID().replaceAll("-", "")}`;
  const group = `${name}_group`;
  const password = crypto.randomUUID();
  const admin = new Client({ connectionString: url });
  const runtimeUrl = new URL(url);
  runtimeUrl.username = name;
  runtimeUrl.password = password;
  const runtime = new Client({ connectionString: runtimeUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.query(`CREATE TABLE "${name}".schema_migrations (version text)`);
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE "${group}" NOLOGIN`);
    await runtime.connect();
    await use(admin, runtime, name, group);
  } finally {
    await runtime.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${group}"`);
    await admin.end();
  }
}

suite("runtime credential denial observation", () => {
  test("proves denial using a separate login and keeps denial after DDL rollback", async () => {
    await fixture(async (admin, runtime, name) => {
      expect(await observeRuntimeDenial(runtime, name, name)).toEqual({
        scan_version: 1,
        runtime_access_denied: true,
        execution_authorized: false,
      });
      await admin.query("BEGIN");
      await admin.query(`CREATE TABLE "${name}".rolled_back (id int)`);
      await admin.query("ROLLBACK");
      expect((await observeRuntimeDenial(runtime, name, name)).runtime_access_denied).toBe(true);
      await expect(
        runtime.query(`SELECT * FROM "${name}".schema_migrations`),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("refuses PUBLIC and inherited access even when direct grants were revoked", async () => {
    await fixture(async (admin, runtime, name, group) => {
      await admin.query(`GRANT USAGE ON SCHEMA "${name}" TO PUBLIC`);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
      await admin.query(`REVOKE USAGE ON SCHEMA "${name}" FROM PUBLIC`);
      await admin.query(`GRANT "${group}" TO "${name}"`);
      await admin.query(`GRANT SELECT ON "${name}".schema_migrations TO "${group}"`);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
      await admin.query(`REVOKE SELECT ON "${name}".schema_migrations FROM "${group}"`);
      expect((await observeRuntimeDenial(runtime, name, name)).runtime_access_denied).toBe(true);
    });
  });

  test("refuses an admin impersonating runtime and a missing target", async () => {
    await fixture(async (admin, runtime, name) => {
      await admin.query(`SET ROLE "${name}"`);
      await expect(observeRuntimeDenial(admin, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
      await admin.query("RESET ROLE");
      await expect(observeRuntimeDenial(runtime, name, `${name}_missing`)).rejects.toThrow(
        "runtime_denial_unproven",
      );
    });
  });

  test("refuses SET ROLE access that NOINHERIT hides from direct privilege checks", async () => {
    await fixture(async (admin, runtime, name, group) => {
      await admin.query(`GRANT "${group}" TO "${name}" WITH INHERIT FALSE, SET TRUE`);
      await admin.query(`GRANT USAGE ON SCHEMA "${name}" TO "${group}"`);
      expect(
        (
          await runtime.query("SELECT has_schema_privilege(current_user, $1, 'USAGE') AS allowed", [
            name,
          ])
        ).rows,
      ).toEqual([{ allowed: false }]);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
    });
  });

  test("refuses an executable security-definer function outside the denied schema", async () => {
    await fixture(async (admin, runtime, name) => {
      const outside = `${name}_outside`;
      await admin.query(`CREATE SCHEMA "${outside}"`);
      try {
        await admin.query(`GRANT USAGE ON SCHEMA "${outside}" TO PUBLIC`);
        await admin.query(`CREATE FUNCTION "${outside}".escape() RETURNS int
          LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
        await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
          "runtime_denial_unproven",
        );
        await admin.query(`REVOKE EXECUTE ON FUNCTION "${outside}".escape() FROM PUBLIC`);
        expect((await observeRuntimeDenial(runtime, name, name)).runtime_access_denied).toBe(true);
      } finally {
        await admin.query(`DROP SCHEMA "${outside}" CASCADE`);
      }
    });
  });

  test("refuses ownership even after the owner revokes its own table privileges", async () => {
    await fixture(async (admin, runtime, name) => {
      await admin.query(`ALTER TABLE "${name}".schema_migrations OWNER TO "${name}"`);
      await admin.query(`REVOKE ALL ON "${name}".schema_migrations FROM "${name}"`);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
    });
  });

  test("refuses column-only and sequence grants while schema access is denied", async () => {
    await fixture(async (admin, runtime, name) => {
      await admin.query(`GRANT SELECT(version) ON "${name}".schema_migrations TO "${name}"`);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
      await admin.query(`REVOKE SELECT(version) ON "${name}".schema_migrations FROM "${name}"`);
      await admin.query(`CREATE SEQUENCE "${name}".probe_seq`);
      await admin.query(`GRANT USAGE ON SEQUENCE "${name}".probe_seq TO "${name}"`);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
      await admin.query(`REVOKE USAGE ON SEQUENCE "${name}".probe_seq FROM "${name}"`);
      expect((await observeRuntimeDenial(runtime, name, name)).runtime_access_denied).toBe(true);
    });
  });

  test("refuses predefined server-program privileges that bypass table ACLs", async () => {
    await fixture(async (admin, runtime, name) => {
      await admin.query(`GRANT pg_execute_server_program TO "${name}"`);
      await expect(observeRuntimeDenial(runtime, name, name)).rejects.toThrow(
        "runtime_denial_unproven",
      );
    });
  });
});
