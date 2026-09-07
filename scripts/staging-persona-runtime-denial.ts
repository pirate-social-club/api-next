import type { Client } from "pg";

export const RUNTIME_DENIAL_CATALOG_SQL = `
      WITH roles AS (
        SELECT oid, rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
        FROM pg_catalog.pg_roles WHERE pg_has_role($2::name, oid, 'MEMBER')
      ), target AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)
      SELECT
        (SELECT count(*)::int FROM target) AS schema_count,
        EXISTS (SELECT FROM roles WHERE rolsuper OR rolcreaterole OR rolcreatedb
          OR rolbypassrls OR rolreplication OR left(rolname, 3) = 'pg_') AS elevated,
        EXISTS (SELECT FROM roles WHERE has_database_privilege(roles.oid, current_database(), 'CREATE'))
          AS database_create,
        EXISTS (SELECT FROM roles JOIN pg_catalog.pg_shdepend d ON d.refobjid = roles.oid
          WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.deptype = 'o'
            AND d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())) AS owns_objects,
        EXISTS (SELECT FROM roles, target
          WHERE has_schema_privilege(roles.oid, target.oid, 'USAGE,CREATE')) AS schema_access,
        EXISTS (SELECT FROM roles, pg_catalog.pg_class c, target
          WHERE c.relnamespace = target.oid AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(roles.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(roles.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
          AS table_access,
        EXISTS (SELECT FROM roles, pg_catalog.pg_class c, target
          WHERE c.relnamespace = target.oid AND c.relkind = 'S'
            AND has_sequence_privilege(roles.oid,c.oid,'USAGE,SELECT,UPDATE')) AS sequence_access,
        EXISTS (SELECT FROM roles, pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND has_schema_privilege(roles.oid,n.oid,'USAGE')
            AND has_function_privilege(roles.oid,p.oid,'EXECUTE')) AS definer_access
    `;

/**
 * Observe a dedicated connection authenticated with runtime credentials.
 * This does not fence writers, verify provider identity, or authorize a reset.
 * Use a fresh connection, never an admin connection with SET ROLE.
 */
export async function observeRuntimeDenial(
  runtime: Client,
  expectedRole: string,
  schema = "api_next",
) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema) || !expectedRole) {
    throw new Error("runtime_probe_input");
  }
  try {
    await runtime.query("BEGIN READ ONLY");
    await runtime.query("SET LOCAL statement_timeout = '5s'");
    await runtime.query("SET LOCAL search_path = pg_catalog");
    const identity = await runtime.query(
      "SELECT session_user::text AS login, current_user::text AS effective",
    );
    if (identity.rows[0]?.login !== expectedRole || identity.rows[0]?.effective !== expectedRole) {
      throw new Error("identity");
    }
    // Include every membership conservatively, including roles available via SET ROLE.
    const result = await runtime.query(RUNTIME_DENIAL_CATALOG_SQL, [schema, expectedRole]);
    const row = result.rows[0];
    if (
      row?.schema_count !== 1 ||
      [
        row.elevated,
        row.database_create,
        row.owns_objects,
        row.schema_access,
        row.table_access,
        row.sequence_access,
        row.definer_access,
      ].some((flag) => flag !== false)
    ) {
      throw new Error("effective_access");
    }
    await runtime.query("SAVEPOINT runtime_denial_probe");
    let denied = false;
    try {
      // LIMIT 0 verifies permissions without reading identity data.
      await runtime.query(`SELECT 1 FROM "${schema}".schema_migrations LIMIT 0`);
    } catch (error) {
      denied =
        typeof error === "object" && error !== null && "code" in error && error.code === "42501";
    }
    await runtime.query("ROLLBACK TO SAVEPOINT runtime_denial_probe");
    if (!denied) throw new Error("probe_not_denied");
    await runtime.query("ROLLBACK");
    return Object.freeze({
      scan_version: 1,
      runtime_access_denied: true,
      execution_authorized: false,
    });
  } catch {
    await runtime.query("ROLLBACK").catch(() => undefined);
    // Driver errors may contain endpoint names or SQL details; retain neither.
    throw new Error("runtime_denial_unproven");
  }
}
