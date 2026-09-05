import type { Client } from "pg";

/** Fresh idle connection only. Observe rights; never grant or exercise DDL. */
export async function observeSchemaRecreationAuthority(
  admin: Client,
  expectedAdmin: string,
  schema = "api_next",
) {
  if (!expectedAdmin || !/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("schema_authority_input");
  }
  try {
    await admin.query("BEGIN READ ONLY");
    await admin.query("SET LOCAL statement_timeout = '5s'");
    await admin.query("SET LOCAL search_path = pg_catalog");
    const result = await admin.query(
      `SELECT
      session_user::text AS login, current_user::text AS effective,
      pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
      pg_catalog.pg_has_role(current_user, nspowner, 'USAGE') AS owns_schema,
      pg_catalog.pg_has_role(current_user, nspowner, 'SET') AS can_preserve_owner
      FROM pg_catalog.pg_namespace WHERE nspname = $1`,
      [schema],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row.login !== expectedAdmin ||
      row.effective !== expectedAdmin ||
      row.can_create !== true ||
      row.owns_schema !== true ||
      row.can_preserve_owner !== true
    ) {
      throw new Error("insufficient_authority");
    }
    await admin.query("ROLLBACK");
    return Object.freeze({
      scan_version: 1,
      schema_recreation_privileges: true,
      execution_authorized: false,
    });
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw new Error("schema_recreation_authority_unproven");
  }
}
