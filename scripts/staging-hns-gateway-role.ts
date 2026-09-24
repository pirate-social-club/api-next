import { createHash } from "node:crypto";
import type { Client } from "pg";
import { isHnsStagingRoleIdentifier } from "./staging-hns-post-migration-entry.ts";

/** Direct read dependencies of the gateway resolver and its two nested route
 * resolvers. The list is deliberately not a schema-wide read grant. */
export const STAGING_HNS_GATEWAY_READ_TABLES = [
  "communities",
  "community_canonical_route_bindings",
  "community_route_ownership_evidence",
  "hns_authority_inventories",
  "hns_community_app_host_activation_current",
  "hns_community_app_host_activation_revisions",
  "hns_dns_zone_activation_current",
  "hns_dns_zone_activation_revisions",
  "hns_dns_zone_health_observations",
  "operator_managed_route_activations",
] as const;

export const STAGING_HNS_GATEWAY_READ_FUNCTIONS = [
  "effective_active_route(text,timestamptz)",
  "effective_route_authority_v2(text,timestamptz)",
  "resolve_hns_community_app_host_authority_v1(text,timestamptz)",
] as const;

export interface StagingHnsGatewayGrantPlan {
  readonly role: string;
  readonly sql_database: string;
  readonly statements: readonly string[];
  readonly sha256: string;
}

export function stagingHnsGatewayGrantPlan(
  role: string,
  sqlDatabase = "postgres",
): StagingHnsGatewayGrantPlan {
  if (!isHnsStagingRoleIdentifier(role)) throw new Error("staging_gateway_role_invalid");
  if (!isHnsStagingRoleIdentifier(sqlDatabase)) throw new Error("staging_gateway_database_invalid");
  const quotedRole = `"${role}"`;
  const statements = [
    `GRANT USAGE ON SCHEMA api_next TO ${quotedRole}`,
    ...STAGING_HNS_GATEWAY_READ_TABLES.map(
      (table) => `GRANT SELECT ON TABLE api_next.${table} TO ${quotedRole}`,
    ),
    ...STAGING_HNS_GATEWAY_READ_FUNCTIONS.map(
      (signature) => `GRANT EXECUTE ON FUNCTION api_next.${signature} TO ${quotedRole}`,
    ),
  ];
  return {
    role,
    sql_database: sqlDatabase,
    statements,
    sha256: createHash("sha256")
      .update(JSON.stringify({ role, sql_database: sqlDatabase, statements }))
      .digest("hex"),
  };
}

interface GatewayTablePrivilege {
  readonly table_name: string;
  readonly can_select: boolean;
  readonly can_insert: boolean;
  readonly can_update: boolean;
  readonly can_delete: boolean;
  readonly can_truncate: boolean;
  readonly can_references: boolean;
  readonly can_trigger: boolean;
}

export interface StagingHnsGatewayGrantReceipt {
  readonly outcome: "staging_gateway_grants_verified";
  readonly role: string;
  readonly plan_sha256: string;
  readonly table_count: number;
  readonly function_count: number;
}

async function assertRestrictedRole(client: Client, role: string): Promise<void> {
  const result = await client.query<{
    readonly rolcanlogin: boolean;
    readonly rolsuper: boolean;
    readonly rolcreaterole: boolean;
    readonly rolcreatedb: boolean;
    readonly rolreplication: boolean;
    readonly rolbypassrls: boolean;
    readonly inherited_role_count: string;
  }>(
    `SELECT r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            r.rolbypassrls,
            (SELECT count(*)::text FROM pg_auth_members AS m WHERE m.member=r.oid)
              AS inherited_role_count
       FROM pg_roles AS r WHERE r.rolname=$1`,
    [role],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.rolcanlogin !== true ||
    row?.rolsuper !== false ||
    row.rolcreaterole !== false ||
    row.rolcreatedb !== false ||
    row.rolreplication !== false ||
    row.rolbypassrls !== false ||
    row.inherited_role_count !== "0"
  ) {
    throw new Error("staging_gateway_role_not_restricted");
  }
}

async function assertExactGatewayPrivileges(client: Client, role: string): Promise<void> {
  const schemaPrivilege = await client.query<{ readonly can_create: boolean }>(
    "SELECT has_schema_privilege($1, 'api_next', 'CREATE') AS can_create",
    [role],
  );
  if (schemaPrivilege.rows[0]?.can_create !== false) {
    throw new Error("staging_gateway_schema_write_allowed");
  }
  const definers = await client.query<{ readonly executable_definers: string }>(
    `SELECT count(*)::text AS executable_definers
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid=p.pronamespace
      WHERE n.nspname='api_next' AND p.prosecdef
        AND has_function_privilege($1, p.oid, 'EXECUTE')`,
    [role],
  );
  if (definers.rows[0]?.executable_definers !== "0") {
    throw new Error("staging_gateway_definer_execute_allowed");
  }
  const tables = await client.query<GatewayTablePrivilege>(
    `SELECT c.relname AS table_name,
            has_table_privilege($1, c.oid, 'SELECT') AS can_select,
            has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
            has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
            has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate,
            has_table_privilege($1, c.oid, 'REFERENCES') AS can_references,
            has_table_privilege($1, c.oid, 'TRIGGER') AS can_trigger
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid=c.relnamespace
      WHERE n.nspname='api_next' AND c.relkind IN ('r','p','v','m','f')`,
    [role],
  );
  const approved = new Set<string>(STAGING_HNS_GATEWAY_READ_TABLES);
  for (const table of tables.rows) {
    if (
      table.can_select !== approved.has(table.table_name) ||
      table.can_insert ||
      table.can_update ||
      table.can_delete ||
      table.can_truncate ||
      table.can_references ||
      table.can_trigger
    ) {
      throw new Error("staging_gateway_table_privilege_mismatch");
    }
    approved.delete(table.table_name);
  }
  if (approved.size !== 0) throw new Error("staging_gateway_dependency_table_missing");
  for (const signature of STAGING_HNS_GATEWAY_READ_FUNCTIONS) {
    const functionPrivilege = await client.query<{ readonly can_execute: boolean }>(
      "SELECT has_function_privilege($1, $2, 'EXECUTE') AS can_execute",
      [role, `api_next.${signature}`],
    );
    if (functionPrivilege.rows.length !== 1 || functionPrivilege.rows[0]?.can_execute !== true) {
      throw new Error("staging_gateway_function_privilege_mismatch");
    }
  }
}

/** Only a separately confirmed caller should invoke this mutating operation.
 * The transaction rolls back every grant if identity or readback differs. */
export async function applyStagingHnsGatewayGrantPlan(
  client: Client,
  plan: StagingHnsGatewayGrantPlan,
  approvedPlanSha256: string,
): Promise<StagingHnsGatewayGrantReceipt> {
  const expected = stagingHnsGatewayGrantPlan(plan.role, plan.sql_database);
  if (
    approvedPlanSha256 !== expected.sha256 ||
    plan.sha256 !== expected.sha256 ||
    JSON.stringify(plan.statements) !== JSON.stringify(expected.statements)
  ) {
    throw new Error("staging_gateway_grant_plan_not_approved");
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const identity = await client.query<{ readonly database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    if (identity.rows[0]?.database_name !== plan.sql_database || identity.rows.length !== 1) {
      throw new Error("staging_gateway_sql_database_mismatch");
    }
    await assertRestrictedRole(client, plan.role);
    for (const statement of expected.statements) await client.query(statement);
    await assertExactGatewayPrivileges(client, plan.role);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return {
    outcome: "staging_gateway_grants_verified",
    role: plan.role,
    plan_sha256: expected.sha256,
    table_count: STAGING_HNS_GATEWAY_READ_TABLES.length,
    function_count: STAGING_HNS_GATEWAY_READ_FUNCTIONS.length,
  };
}
