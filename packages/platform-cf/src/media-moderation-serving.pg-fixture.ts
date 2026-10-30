import { randomUUID } from "node:crypto";
import { Client } from "pg";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Tests the moderation receipt boundary, not the entire production role policy. */
export async function withModerationServingRole<A>(
  admin: Client,
  ownerConnection: string,
  use: (connection: string) => Promise<A>,
): Promise<A> {
  const schema = (await admin.query("SELECT current_schema() AS name")).rows[0]?.name;
  if (typeof schema !== "string") throw Error("Moderation fixture schema is missing");
  const role = `media_moderation_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID().replaceAll("-", "");
  let oid: number | undefined;
  let result: A | undefined;
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(async () => {
    await admin.query(
      `CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
    oid = Number(
      (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [role])).rows[0]?.oid,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
    // Surrounding repository writes stay ordinary invoker operations. Only the
    // immutable receipt's missing UPDATE/DELETE is the regression under test.
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(role)}`,
    );
    await admin.query(
      `REVOKE UPDATE,DELETE ON ${quote(schema)}.media_moderation_actions FROM ${quote(role)}`,
    );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION ${quote(schema)}.has_community_moderation_capability_v1(text,text,text) TO ${quote(role)}`,
    );
    const url = new URL(ownerConnection);
    url.username = role;
    url.password = password;
    const runtime = new Client({ connectionString: url.toString() });
    await runtime.connect();
    try {
      const facts = (
        await runtime.query(
          `SELECT current_user=session_user AND current_user=$1 AS bound,
           NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS confined,
           NOT pg_has_role(current_user,n.nspowner,'MEMBER') AS not_owner,
           has_table_privilege(current_user,$2,'SELECT') AS can_select,
           has_table_privilege(current_user,$2,'INSERT') AS can_insert,
           NOT has_table_privilege(current_user,$2,'UPDATE,DELETE') AS cannot_mutate
           FROM pg_roles r JOIN pg_namespace n ON n.nspname=$3 WHERE r.rolname=current_user`,
          [role, `${quote(schema)}.media_moderation_actions`, schema],
        )
      ).rows;
      if (
        facts.length !== 1 ||
        !["bound", "confined", "not_owner", "can_select", "can_insert", "cannot_mutate"].every(
          (key) => facts[0]?.[key] === true,
        )
      )
        throw Error("Moderation fixture runtime permissions differ");
    } finally {
      await runtime.end();
    }
    result = await use(url.toString());
  });
  if (oid !== undefined) {
    await attempt(async () => {
      const current = (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [role])).rows;
      if (current.length !== 1 || Number(current[0]?.oid) !== oid)
        throw Error("Owned moderation fixture role changed before cleanup");
      await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quote(schema)} FROM ${quote(role)}`);
      await admin.query(
        `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${quote(schema)} FROM ${quote(role)}`,
      );
      await admin.query(`REVOKE ALL ON SCHEMA ${quote(schema)} FROM ${quote(role)}`);
      await admin.query(`DROP ROLE ${quote(role)}`);
    });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Moderation permission proof and owned cleanup failed");
  return result as A;
}
