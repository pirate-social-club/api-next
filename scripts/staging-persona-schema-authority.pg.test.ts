import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { observeSchemaRecreationAuthority } from "./staging-persona-schema-authority";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1") {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;

suite("schema recreation authority", () => {
  test("refuses a schema owner lacking database CREATE before any destructive operation", async () => {
    if (!url) throw new Error("test URL required");
    const name = `ddl_${crypto.randomUUID().replaceAll("-", "")}`;
    const password = crypto.randomUUID();
    const admin = new Client({ connectionString: url });
    const scoped = new URL(url);
    scoped.username = name;
    scoped.password = password;
    const owner = new Client({ connectionString: scoped.toString() });
    await admin.connect();
    const database = (await admin.query("SELECT current_database() AS name")).rows[0]
      .name as string;
    const quotedDatabase = `"${database.replaceAll('"', '""')}"`;
    try {
      await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT CREATE ON DATABASE ${quotedDatabase} TO "${name}"`);
      await admin.query(`CREATE SCHEMA "${name}" AUTHORIZATION "${name}"`);
      await admin.query(`REVOKE CREATE ON DATABASE ${quotedDatabase} FROM "${name}"`);
      await owner.connect();
      await expect(observeSchemaRecreationAuthority(owner, name, name)).rejects.toThrow(
        "schema_recreation_authority_unproven",
      );
      expect(
        (
          await admin.query("SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1", [
            name,
          ])
        ).rows,
      ).toEqual([{ count: 1 }]);
      await admin.query(`GRANT CREATE ON DATABASE ${quotedDatabase} TO "${name}"`);
      expect(await observeSchemaRecreationAuthority(owner, name, name)).toEqual({
        scan_version: 1,
        schema_recreation_privileges: true,
        execution_authorized: false,
      });
      await expect(observeSchemaRecreationAuthority(admin, name, name)).rejects.toThrow(
        "schema_recreation_authority_unproven",
      );
      const group = `${name}_group`;
      await admin.query(`CREATE ROLE "${group}" NOLOGIN`);
      try {
        await admin.query(`GRANT CREATE ON DATABASE ${quotedDatabase} TO "${group}"`);
        await admin.query(`ALTER SCHEMA "${name}" OWNER TO "${group}"`);
        await admin.query(`GRANT "${group}" TO "${name}" WITH INHERIT TRUE, SET FALSE`);
        await expect(observeSchemaRecreationAuthority(owner, name, name)).rejects.toThrow(
          "schema_recreation_authority_unproven",
        );
      } finally {
        await admin.query(`ALTER SCHEMA "${name}" OWNER TO "${name}"`);
        await admin.query(`REVOKE CREATE ON DATABASE ${quotedDatabase} FROM "${group}"`);
        await admin.query(`DROP ROLE "${group}"`);
      }
    } finally {
      await owner.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await admin.query(`REVOKE CREATE ON DATABASE ${quotedDatabase} FROM "${name}"`);
      await admin.query(`DROP ROLE IF EXISTS "${name}"`);
      await admin.end();
    }
  });
});
