import { Schema } from "effect";
import {
  type DanceServingConsumer,
  danceServingRequirements,
} from "./dance-serving-permission-contract.ts";

/** Read-only facts from the actual connection. No application data or grants. */
export const DANCE_SERVING_PRIVILEGES_SQL = `WITH actor AS (
 SELECT n.oid namespace_oid,n.nspname,n.nspowner,u.relowner,current_user::text runtime_role,
   session_user::text session_role,
   actor.rolcanlogin AND NOT(actor.rolsuper OR actor.rolbypassrls OR actor.rolcreatedb OR actor.rolcreaterole OR actor.rolreplication)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles inherited WHERE inherited.oid<>actor.oid
     AND pg_catalog.pg_has_role(actor.oid,inherited.oid,'MEMBER')
     AND (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreatedb OR inherited.rolcreaterole OR inherited.rolreplication)) AS role_safe,
   pg_catalog.has_schema_privilege(current_user,n.oid,'USAGE') AS schema_usage,
   pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE') AS schema_create,
   pg_catalog.pg_has_role(current_user,n.nspowner,'MEMBER') OR pg_catalog.pg_has_role(current_user,u.relowner,'MEMBER') AS owner_equivalent
 FROM pg_catalog.pg_namespace n
 JOIN pg_catalog.pg_class u ON u.relnamespace=n.oid AND u.relname='users' AND u.relkind='r'
 JOIN pg_catalog.pg_roles actor ON actor.rolname=current_user WHERE n.nspname=$1
), facts AS (
 SELECT a.*,required.object_name,required.boundary,required.expected_execute,required.path_kind,required.require_stable,
   p.oid function_oid,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proacl,c.oid table_oid,c.relowner table_owner,c.relkind
 FROM actor a CROSS JOIN unnest($2::text[],$3::text[],$4::boolean[],$5::text[],$6::boolean[])
   required(object_name,boundary,expected_execute,path_kind,require_stable)
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=CASE WHEN required.boundary='function'
   THEN pg_catalog.to_regprocedure(pg_catalog.quote_ident(a.nspname)||'.'||required.object_name) END
 LEFT JOIN pg_catalog.pg_class c ON required.boundary IN('table','read_table') AND c.relnamespace=a.namespace_oid AND c.relname=required.object_name
)
SELECT runtime_role,session_role,role_safe,schema_usage,schema_create,owner_equivalent,
 object_name,boundary,expected_execute,
 CASE WHEN boundary='function' THEN function_oid IS NOT NULL ELSE table_oid IS NOT NULL AND relkind IN('r','p') END object_exists,
 COALESCE(nspowner=relowner AND CASE WHEN boundary='function' THEN proowner=relowner ELSE table_owner=relowner END,FALSE) anchored_owner,
 COALESCE(prosecdef AND (NOT require_stable OR provolatile='s') AND proconfig=ARRAY[CASE WHEN path_kind='wallet_lock'
   THEN pg_catalog.format('search_path=%I, pg_temp',nspname)
   ELSE pg_catalog.format('search_path=%I, pg_catalog, pg_temp',nspname) END],FALSE) pinned_definer,
 COALESCE(pg_catalog.has_function_privilege(current_user,function_oid,'EXECUTE'),FALSE) can_execute,
 EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) acl
   WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') public_execute,
 COALESCE(pg_catalog.has_table_privilege(current_user,table_oid,'SELECT'),FALSE) can_select,
 COALESCE(pg_catalog.has_table_privilege(current_user,table_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),FALSE)
 OR COALESCE(pg_catalog.has_any_column_privilege(current_user,table_oid,'SELECT,INSERT,UPDATE,REFERENCES'),FALSE) private_access
FROM facts`;

const Fact = Schema.Struct({
  runtime_role: Schema.NonEmptyString,
  session_role: Schema.NonEmptyString,
  role_safe: Schema.Boolean,
  schema_usage: Schema.Boolean,
  schema_create: Schema.Boolean,
  owner_equivalent: Schema.Boolean,
  object_name: Schema.NonEmptyString,
  boundary: Schema.Literals(["function", "table", "read_table"]),
  expected_execute: Schema.Boolean,
  object_exists: Schema.Boolean,
  anchored_owner: Schema.Boolean,
  pinned_definer: Schema.Boolean,
  can_execute: Schema.Boolean,
  public_execute: Schema.Boolean,
  can_select: Schema.Boolean,
  private_access: Schema.Boolean,
});

export class DanceServingPrivilegesRefused extends Error {
  constructor(readonly failures: readonly string[]) {
    super("Dance serving permissions refused");
  }
}

export function assertDanceServingPrivileges(rows: unknown, config: DanceServingConsumer): string {
  const decoded = Schema.decodeUnknownExit(Schema.Array(Fact), { onExcessProperty: "error" })(rows);
  if (decoded._tag === "Failure")
    throw new DanceServingPrivilegesRefused(["permission facts malformed"]);
  const facts = decoded.value;
  const required = new Map(danceServingRequirements(config).map((row) => [row.name, row]));
  const role = facts[0]?.runtime_role;
  if (facts.length !== required.size || role === undefined)
    throw new DanceServingPrivilegesRefused(["permission facts incomplete"]);
  const failures: string[] = [];
  for (const row of facts) {
    const expected = required.get(row.object_name);
    if (
      expected === undefined ||
      row.boundary !== expected.boundary ||
      row.expected_execute !== expected.execute
    ) {
      failures.push("permission facts differ");
      continue;
    }
    required.delete(row.object_name);
    if (
      row.runtime_role !== role ||
      row.session_role !== role ||
      !row.role_safe ||
      row.owner_equivalent ||
      row.schema_create
    )
      failures.push(`${row.object_name}: role is not confined`);
    if (!row.schema_usage || !row.object_exists || !row.anchored_owner)
      failures.push(`${row.object_name}: schema, object or owner differs`);
    if (
      row.can_execute !== expected.execute ||
      row.public_execute ||
      (row.boundary !== "read_table" && row.private_access) ||
      (row.boundary === "read_table" && !row.can_select)
    )
      failures.push(`${row.object_name}: effective privilege mismatch`);
    if (expected.execute && !row.pinned_definer)
      failures.push(`${row.object_name}: trusted definer shape differs`);
  }
  if (required.size > 0) failures.push("permission facts missing or duplicate");
  if (failures.length > 0) throw new DanceServingPrivilegesRefused(failures);
  return role;
}
