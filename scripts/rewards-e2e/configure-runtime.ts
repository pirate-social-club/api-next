import { Client } from "pg";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import {
  RUNTIME_RELEASE_PRIVILEGES,
  runRuntimeRoleReleasePreflight,
} from "../runtime-role-release-preflight.ts";
import { verifyStagingRuntimeIdentity } from "../staging-persona-approved-privileges.ts";
import {
  type IsolatedDatabaseIdentity,
  validateIsolatedDatabaseIdentity,
} from "./bootstrap-database.ts";

/** The caller independently verifies both credential IDs in the pinned provider branch. */
export async function configureIsolatedRewardsRuntime(input: {
  readonly adminConnectionString: string;
  readonly runtimeConnectionString: string;
  readonly identity: IsolatedDatabaseIdentity;
  readonly runtimeUsernameSha256: string;
}) {
  validateIsolatedDatabaseIdentity(input.adminConnectionString, input.identity);
  const runtimeUrl = validateIsolatedDatabaseIdentity(input.runtimeConnectionString, {
    ...input.identity,
    usernameSha256: input.runtimeUsernameSha256,
  });
  const runtime = new Client({
    connectionString: normalizePostgresConnectionString(runtimeUrl.toString()),
    connectionTimeoutMillis: 20_000,
  });
  await runtime.connect();
  let role: string;
  try {
    const result = await runtime.query<{ role: string }>("SELECT current_user AS role");
    role = result.rows[0]?.role ?? "";
    if (role !== decodeURIComponent(runtimeUrl.username).split(".")[0]) {
      throw new Error("The isolated runtime SQL identity differs from its provider credential");
    }
  } finally {
    await runtime.end();
  }
  const admin = new Client({
    connectionString: normalizePostgresConnectionString(input.adminConnectionString),
    connectionTimeoutMillis: 20_000,
  });
  await admin.connect();
  try {
    await admin.query("BEGIN");
    const receipt = await admin.query<{ finished: boolean }>(
      `SELECT finished FROM rewards_bootstrap_${input.identity.branchId}.receipt WHERE branch_id=$1`,
      [input.identity.branchId],
    );
    if (receipt.rows.length !== 1 || receipt.rows[0]?.finished !== true) {
      throw new Error("Runtime grants require a completed isolated bootstrap");
    }
    await verifyStagingRuntimeIdentity(admin, role);
    const quotedRole = `"${role.replaceAll('"', '""')}"`;
    await admin.query(`GRANT USAGE ON SCHEMA api_next TO ${quotedRole}`);
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA api_next TO ${quotedRole}`,
    );
    await admin.query(
      `GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA api_next TO ${quotedRole}`,
    );
    await admin.query(
      `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON api_next.schema_migrations FROM ${quotedRole}`,
    );
    for (const requirement of RUNTIME_RELEASE_PRIVILEGES) {
      const command = requirement.allowed ? "GRANT" : "REVOKE";
      const direction = requirement.allowed ? "TO" : "FROM";
      const objectKind = requirement.privilege === "EXECUTE" ? "FUNCTION" : "TABLE";
      await admin.query(
        `${command} ${requirement.privilege} ON ${objectKind} api_next.${requirement.object} ${direction} ${quotedRole}`,
      );
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }
  return runRuntimeRoleReleasePreflight({
    runtimeConnectionString: input.runtimeConnectionString,
    adminConnectionString: input.adminConnectionString,
    requireMainLedger: true,
  });
}
