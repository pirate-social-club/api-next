import { createHash } from "node:crypto";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { requireExactLedger } from "./staging-hns-cutover-probe-seed.ts";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_DATABASE_ID,
  HNS_STAGING_SQL_DATABASE,
} from "./staging-hns-post-migration-contract.ts";
import { readHnsPinnedMigrations } from "./staging-hns-post-migration-runtime.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

/** Direct provisioner calls still denied to the staging runtime after the
 * cutover grant. Never replace this list with a schema-wide function grant. */
export const HNS_PROVISIONER_MISSING_FUNCTIONS = [
  "claim_hns_authority_provision_job_v1(text,integer)",
  "finalize_hns_authority_provision_job_v1(text,text,bigint,text,text,bytea,text,bytea,text,text)",
  "claim_hns_root_health_renewal_job_v1(text,integer)",
  "finalize_hns_root_health_renewal_job_v1(text,text,bigint,text,text,bytea,text,text)",
  "prepare_hns_root_inventory_renewal_v1(text,text,bigint,text,text,bytea,text,text)",
  "lock_hns_root_zone_mutation_v1(text,text,boolean,text,text,bigint)",
  "set_hns_root_import_lifecycle_plan_digest_v1(text,text)",
] as const;

export class ProvisionerGrantRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function parseProvisionerGrantCommand(arguments_: readonly string[]) {
  if (arguments_.length === 0) return { execute: false, approved_plan_sha256: null } as const;
  if (
    arguments_.length === 3 &&
    arguments_[0] === "--execute" &&
    arguments_[1] === "--approve-plan-sha256" &&
    /^[0-9a-f]{64}$/u.test(arguments_[2] ?? "")
  )
    return { execute: true, approved_plan_sha256: arguments_[2] as string } as const;
  throw new ProvisionerGrantRefusal("options_invalid");
}

export function provisionerGrantPlan(role: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(role))
    throw new ProvisionerGrantRefusal("runtime_role_invalid");
  const statements = HNS_PROVISIONER_MISSING_FUNCTIONS.map(
    (signature) => `GRANT EXECUTE ON FUNCTION api_next.${signature} TO "${role}"`,
  );
  const plan_sha256 = createHash("sha256")
    .update(JSON.stringify({ role, sql_database: HNS_STAGING_SQL_DATABASE, statements }))
    .digest("hex");
  return { role, sql_database: HNS_STAGING_SQL_DATABASE, statements, plan_sha256 };
}

type Privilege = Readonly<{
  signature: string;
  exists: boolean;
  runtime_execute: boolean;
  public_execute: boolean;
}>;

export function requirePrivilegeState(
  privileges: readonly Privilege[],
  expectedRuntimeExecute: boolean,
) {
  if (privileges.length !== HNS_PROVISIONER_MISSING_FUNCTIONS.length)
    throw new ProvisionerGrantRefusal("function_count");
  for (const [index, signature] of HNS_PROVISIONER_MISSING_FUNCTIONS.entries()) {
    const privilege = privileges[index];
    if (privilege?.signature !== signature || !privilege.exists)
      throw new ProvisionerGrantRefusal("function_identity");
    if (privilege.public_execute) throw new ProvisionerGrantRefusal("public_execute");
    if (privilege.runtime_execute !== expectedRuntimeExecute)
      throw new ProvisionerGrantRefusal(
        expectedRuntimeExecute ? "grant_readback_mismatch" : "grant_state_drift",
      );
  }
}

async function readPrivileges(client: Client, role: string): Promise<readonly Privilege[]> {
  const privileges: Privilege[] = [];
  for (const signature of HNS_PROVISIONER_MISSING_FUNCTIONS) {
    const result = await client.query<{
      readonly exists: boolean;
      readonly runtime_execute: boolean | null;
      readonly public_execute: boolean | null;
    }>(
      `SELECT p.oid IS NOT NULL AS exists,
              CASE WHEN p.oid IS NULL THEN NULL
                   ELSE has_function_privilege($1, p.oid, 'EXECUTE') END AS runtime_execute,
              CASE WHEN p.oid IS NULL THEN NULL
                   ELSE EXISTS (
                     SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
                   ) END AS public_execute
         FROM (SELECT to_regprocedure($2) AS oid) target
         LEFT JOIN pg_proc p ON p.oid=target.oid`,
      [role, `api_next.${signature}`],
    );
    const row = result.rows[0];
    privileges.push({
      signature,
      exists: row?.exists === true,
      runtime_execute: row?.runtime_execute === true,
      public_execute: row?.public_execute === true,
    });
  }
  return privileges;
}

export async function runProvisionerGrantCommand(arguments_: readonly string[]) {
  const command = parseProvisionerGrantCommand(arguments_);
  const adminRaw = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (adminRaw === undefined || adminRaw.length === 0 || adminRaw.trim() !== adminRaw)
    throw new ProvisionerGrantRefusal("admin_credential_missing");
  const binding = await collectStagingProviderBinding().catch(() => {
    throw new ProvisionerGrantRefusal("provider_target_unproven");
  });
  if (
    binding.database_id !== HNS_STAGING_DATABASE_ID ||
    binding.branch_id !== HNS_STAGING_BRANCH_ID ||
    binding.adminRaw !== adminRaw ||
    binding.provider_hyperdrive_bound !== true ||
    binding.admin.sqlRole === binding.runtime.sqlRole
  )
    throw new ProvisionerGrantRefusal("provider_target_mismatch");
  const plan = provisionerGrantPlan(binding.runtime.sqlRole);
  if (command.execute && command.approved_plan_sha256 !== plan.plan_sha256)
    throw new ProvisionerGrantRefusal("plan_not_approved");
  const pinned = await readHnsPinnedMigrations().catch(() => {
    throw new ProvisionerGrantRefusal("pinned_ledger_unreadable");
  });
  const client = new Client({
    connectionString: normalizePostgresConnectionString(adminRaw),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect().catch(() => {
    throw new ProvisionerGrantRefusal("connect");
  });
  let commitStarted = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("LOCK TABLE api_next.schema_migrations IN SHARE MODE");
    const identity = await client.query<{
      readonly database_name: string;
      readonly session_user: string;
      readonly current_user: string;
    }>("SELECT current_database() AS database_name, session_user, current_user");
    const who = identity.rows[0];
    if (
      identity.rows.length !== 1 ||
      who?.database_name !== HNS_STAGING_SQL_DATABASE ||
      who.session_user !== binding.admin.sqlRole ||
      who.current_user !== binding.admin.sqlRole
    )
      throw new ProvisionerGrantRefusal("admin_identity_mismatch");
    const ledger = await client.query<{ readonly version: string; readonly checksum: string }>(
      "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
    );
    requireExactLedger(ledger.rows, pinned);
    const before = await readPrivileges(client, plan.role);
    requirePrivilegeState(before, false);
    if (!command.execute) {
      await client.query("ROLLBACK");
      return {
        outcome: "staging_hns_provisioner_grants_dry_run",
        role: plan.role,
        function_count: before.length,
        plan_sha256: plan.plan_sha256,
        statements: plan.statements,
      };
    }
    for (const statement of plan.statements) await client.query(statement);
    requirePrivilegeState(await readPrivileges(client, plan.role), true);
    commitStarted = true;
    await client.query("COMMIT");
    return {
      outcome: "staging_hns_provisioner_grants_applied",
      role: plan.role,
      function_count: plan.statements.length,
      plan_sha256: plan.plan_sha256,
    };
  } catch (error) {
    if (!commitStarted) await client.query("ROLLBACK").catch(() => undefined);
    if (commitStarted) throw new ProvisionerGrantRefusal("commit_outcome_unknown_read_back");
    if (error instanceof ProvisionerGrantRefusal) throw error;
    throw new ProvisionerGrantRefusal("database_step_failed");
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  await runProvisionerGrantCommand(Bun.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      const code = error instanceof ProvisionerGrantRefusal ? error.code : "unexpected";
      console.error(JSON.stringify({ outcome: "staging_hns_provisioner_grants_refused", code }));
      process.exitCode = 1;
    });
}
