import pg from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import {
  type SongFundingPurpose,
  songFundingRequirements,
} from "./song-funding-permission-contract.ts";

export const SONG_FUNDING_PRIVILEGES_SQL = `
WITH actor AS (
 SELECT n.oid ns,n.nspname,n.nspowner,r.oid role_oid,
 current_user::text runtime_role,session_user::text session_role,
 NOT(r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) role_safe,
 has_schema_privilege(current_user,n.oid,'USAGE') schema_usage,
 has_schema_privilege(current_user,n.oid,'CREATE') schema_create,
 has_schema_privilege(current_user,n.oid,'USAGE WITH GRANT OPTION') schema_grant_option,
 EXISTS(SELECT 1 FROM pg_proc extra CROSS JOIN LATERAL aclexplode(extra.proacl) acl WHERE extra.pronamespace=n.oid AND acl.grantee=r.oid AND acl.privilege_type='EXECUTE'
 AND NOT EXISTS(SELECT 1 FROM unnest($2::text[],$3::boolean[]) allowed(name,permitted) WHERE permitted AND extra.oid=to_regprocedure(quote_ident(n.nspname)||'.'||allowed.name))) unexpected_execute_grants,
 EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) membership,
 EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN('r','p','v','m','f') AND
 (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
 has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) raw_access
 FROM pg_namespace n JOIN pg_roles r ON r.rolname=current_user WHERE n.nspname=$1
)
SELECT a.runtime_role,a.session_role,a.role_safe,a.schema_usage,a.schema_create,a.schema_grant_option,a.unexpected_execute_grants,a.membership,a.raw_access,
 required.name,required.expected,p.oid IS NOT NULL object_exists,
 p.proconfig function_settings,p.prosecdef security_definer,p.proowner=a.nspowner owner_matches,
 COALESCE(has_function_privilege(current_user,p.oid,'EXECUTE'),false) can_execute,
 COALESCE(has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION'),false) grant_option,
 COALESCE(p.proowner=a.nspowner AND p.prosecdef AND cardinality(p.proconfig)=1 AND
 p.proconfig && ARRAY[format('search_path=%I, pg_catalog, pg_temp',a.nspname),
 format('search_path=pg_catalog, %I, pg_temp',a.nspname),format('search_path=%I, pg_temp',a.nspname)],false) trusted,
 EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
 WHERE x.grantee=0 AND x.privilege_type='EXECUTE') public_execute
 FROM actor a CROSS JOIN unnest($2::text[],$3::boolean[]) required(name,expected)
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(quote_ident(a.nspname)||'.'||required.name)`;

export function assertSongFundingPrivileges(
  rows: readonly Record<string, unknown>[],
  purpose: SongFundingPurpose,
) {
  const required = new Map(songFundingRequirements(purpose).map((r) => [r.name, r.execute]));
  const role = rows[0]?.runtime_role;
  if (typeof role !== "string" || role.length === 0 || rows.length !== required.size)
    throw Error("Song funding permission facts incomplete");
  for (const row of rows) {
    const name = row.name;
    if (
      typeof name !== "string" ||
      !required.has(name) ||
      row.expected !== required.get(name) ||
      row.runtime_role !== role ||
      row.session_role !== role ||
      row.role_safe !== true ||
      row.schema_usage !== true ||
      row.schema_create !== false ||
      row.schema_grant_option !== false ||
      row.unexpected_execute_grants !== false ||
      row.grant_option !== false ||
      row.membership !== false ||
      row.raw_access !== false ||
      row.object_exists !== true ||
      row.can_execute !== row.expected ||
      row.public_execute !== false ||
      (row.expected && row.trusted !== true)
    )
      throw Error(`Song funding purpose permissions refused: ${JSON.stringify(row)}`, {
        cause: row,
      });
    required.delete(name);
  }
  if (required.size) throw Error("Song funding permission facts duplicate");
  return role;
}

export async function runSongFundingPermissionsPreflight(
  url: string,
  purpose: SongFundingPurpose,
  schema = "api_next",
) {
  const db = new pg.Client({
    connectionString: normalizePostgresConnectionString(url),
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 15000,
  });
  try {
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const required = songFundingRequirements(purpose);
    const facts = await db.query(SONG_FUNDING_PRIVILEGES_SQL, [
      schema,
      required.map((r) => r.name),
      required.map((r) => r.execute),
    ]);
    return assertSongFundingPrivileges(facts.rows, purpose);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}
