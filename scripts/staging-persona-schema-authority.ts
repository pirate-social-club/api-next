import type { Client } from "pg";

/** In-place reset preserves the namespace: database CREATE and SET ROLE are
 * deliberately not prerequisites. No transaction ownership or DDL here.
 */
export async function assertInplaceSchemaAuthority(
  admin: Pick<Client, "query">,
  expectedRole: string,
  schemaOid: number,
) {
  const result = await admin.query(`SELECT session_user AS login,current_user AS active,n.oid,
    pg_catalog.pg_has_role(current_user,n.nspowner,'USAGE') AS owns,
    pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') AS usage,
    pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') AS create
    FROM pg_catalog.pg_namespace n WHERE n.nspname='api_next'`);
  const row = result.rows[0];
  if (
    !row ||
    row.login !== expectedRole ||
    row.active !== expectedRole ||
    row.oid !== schemaOid ||
    !row.owns ||
    !row.usage ||
    !row.create
  )
    throw new Error("reset_inplace_authority_unproven");
}

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
