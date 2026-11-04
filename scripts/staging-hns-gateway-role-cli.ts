import { Client } from "pg";
import {
  applyStagingHnsGatewayGrantPlan,
  stagingHnsGatewayGrantPlan,
} from "./staging-hns-gateway-role.ts";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_BRANCH_NAME,
  HNS_STAGING_DATABASE_ID,
  HNS_STAGING_PROVIDER_DATABASE_NAME,
  HNS_STAGING_SQL_DATABASE,
} from "./staging-hns-post-migration-contract.ts";
import { collectStagingPostMigrationTargetBinding } from "./staging-hns-post-migration-runtime.ts";

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

export function parseStagingHnsGatewayRoleCommand(arguments_: readonly string[]): Readonly<{
  readonly role: string;
  readonly execute: boolean;
  readonly approved_plan_sha256: string | undefined;
}> {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--execute") continue;
    if (argument !== "--role" && argument !== "--approve-plan-sha256") {
      throw new Error("staging_gateway_option_invalid");
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("staging_gateway_option_value_missing");
    }
    index += 1;
  }
  const role = option(arguments_, "--role");
  if (role === undefined || arguments_.filter((value) => value === "--role").length !== 1) {
    throw new Error("staging_gateway_role_required");
  }
  const execute = arguments_.includes("--execute");
  if (arguments_.filter((value) => value === "--execute").length > 1) {
    throw new Error("staging_gateway_execute_duplicate");
  }
  const approvedPlanSha256 = option(arguments_, "--approve-plan-sha256");
  if (arguments_.filter((value) => value === "--approve-plan-sha256").length > 1) {
    throw new Error("staging_gateway_approval_duplicate");
  }
  if (execute && approvedPlanSha256 === undefined) {
    throw new Error("staging_gateway_approval_required");
  }
  if (!execute && approvedPlanSha256 !== undefined) {
    throw new Error("staging_gateway_approval_without_execute");
  }
  return { role, execute, approved_plan_sha256: approvedPlanSha256 };
}

export async function runStagingHnsGatewayRoleCommand(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, unknown>>> {
  const command = parseStagingHnsGatewayRoleCommand(arguments_);
  const plan = stagingHnsGatewayGrantPlan(command.role, HNS_STAGING_SQL_DATABASE);
  if (!command.execute) {
    return {
      outcome: "staging_gateway_grants_dry_run",
      role: plan.role,
      sql_database: plan.sql_database,
      plan_sha256: plan.sha256,
      statements: plan.statements,
    };
  }
  if (command.approved_plan_sha256 !== plan.sha256) {
    throw new Error("staging_gateway_grant_plan_not_approved");
  }
  const adminUrl = environment.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (adminUrl === undefined || adminUrl.trim() !== adminUrl || adminUrl.length === 0) {
    throw new Error("staging_gateway_admin_credential_missing");
  }
  const target = await collectStagingPostMigrationTargetBinding(adminUrl);
  if (
    target.database_id !== HNS_STAGING_DATABASE_ID ||
    target.database_name !== HNS_STAGING_PROVIDER_DATABASE_NAME ||
    target.branch_id !== HNS_STAGING_BRANCH_ID ||
    target.branch_name !== HNS_STAGING_BRANCH_NAME ||
    target.branch_ready !== true ||
    target.sql_database !== HNS_STAGING_SQL_DATABASE
  ) {
    throw new Error("staging_gateway_provider_target_mismatch");
  }
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await applyStagingHnsGatewayGrantPlan(client, plan, command.approved_plan_sha256);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  await runStagingHnsGatewayRoleCommand(Bun.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch(() => {
      // Provider and SQL errors may contain credentials; the operator gets
      // only a fixed refusal and must use read-only diagnostics separately.
      console.error('{"outcome":"staging_gateway_grants_refused"}');
      process.exitCode = 1;
    });
}
