import { redactedDiagnosticCause } from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import {
  HNS_AUTHORITY_SERVICE_VERSION,
  HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
} from "../apps/hns-authority-provisioner/src/schema-compatibility.ts";
import {
  readCutoverIdentityRow,
  readHnsLifecycleSchemaCompatibility,
  seedHnsLifecycleCutoverProbe,
  sha256File,
  stageHnsReadinessCutoverBundle,
} from "./hns-readiness-cutover.ts";
import { loadPostgresMigrations } from "./postgres-migrations.ts";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_BRANCH_NAME,
  HNS_STAGING_DATABASE_ID,
  HNS_STAGING_PROVIDER_DATABASE_NAME,
  HNS_STAGING_SERVICE_UNIT,
  HNS_STAGING_SQL_DATABASE,
  type HnsStagingAuthorizedTarget,
  type HnsStagingPostMigrationPorts,
  type HnsStagingTargetBinding,
} from "./staging-hns-post-migration-contract.ts";
import {
  HnsStagingPostMigrationRefused,
  isHnsStagingRoleIdentifier,
  postMigrationRefusalJson,
  runHnsStagingPostMigration,
} from "./staging-hns-post-migration-entry.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

/**
 * Real bindings for the staging post-migration entry point.
 *
 * Credentials arrive only through the approved delivery mechanisms as process
 * environment connection strings and never travel into a receipt or a log. The
 * provider-verified target comes from the reset lane's read-only collector;
 * tests substitute the factory's binding and start-service seams.
 */

const ADMIN_URL_ENV = "CONTROL_PLANE_POSTGRES_ADMIN_URL";
const RUNTIME_URL_ENV = "CONTROL_PLANE_POSTGRES_RUNTIME_URL";
const OPERATOR_URL_ENV = "CONTROL_PLANE_POSTGRES_OPERATOR_URL";
const PROBE_FUNCTION =
  "run_hns_lifecycle_readiness_cutover_probe_v1(text,text,text,text,text,timestamptz)";
const IDENTITY_TABLE = "api_next.hns_lifecycle_service_identity";

function requireConnectionString(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() !== value || value.length === 0) {
    throw new Error(`${name} is required for the staging post-migration entry point`);
  }
  return value;
}

async function withClient<A>(url: string, use: (client: Client) => Promise<A>): Promise<A> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readSqlIdentity(url: string): Promise<string> {
  return withClient(url, async (client) => {
    const row = (await client.query("SELECT current_user AS active, session_user AS login"))
      .rows[0];
    if (typeof row?.active !== "string" || row.active !== row.login) {
      throw new Error("staging_sql_identity_unproven");
    }
    return row.active;
  });
}

/** Provider-verified staging binding, plus the connected SQL database name.
 * The collector refuses unless the staging database id, branch id, reviewed
 * names, ready state, role separation and Hyperdrive origin all hold, so the
 * names returned here are the facts it verified. */
export async function collectStagingPostMigrationTargetBinding(
  adminUrl: string,
): Promise<HnsStagingTargetBinding> {
  const binding = await collectStagingProviderBinding();
  const sqlDatabase = await withClient(adminUrl, async (client) => {
    const row = (await client.query("SELECT current_database() AS database")).rows[0];
    if (
      typeof row?.database !== "string" ||
      row.database.length === 0 ||
      row.database.trim() !== row.database
    ) {
      throw new Error("staging_sql_database_unproven");
    }
    return row.database;
  });
  return {
    database_id: binding.database_id,
    database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
    sql_database: sqlDatabase,
    branch_id: binding.branch_id,
    branch_name: HNS_STAGING_BRANCH_NAME,
    branch_ready: true,
    migrator_role: binding.admin.sqlRole,
  };
}

/** The reviewed grants: EXECUTE on the six-argument probe for the runtime
 * identity, and no direct INSERT, UPDATE or DELETE on the service identity
 * table for the runtime identity, the operator identity or PUBLIC. */
export async function applyStagingPostMigrationGrants(
  adminUrl: string,
  input: Readonly<{ readonly runtime_role: string; readonly operator_role: string }>,
): Promise<void> {
  for (const role of [input.runtime_role, input.operator_role]) {
    if (!isHnsStagingRoleIdentifier(role)) {
      throw new Error("staging_role_identifier_invalid");
    }
  }
  await withClient(adminUrl, async (client) => {
    await client.query(
      `GRANT EXECUTE ON FUNCTION api_next.${PROBE_FUNCTION} TO "${input.runtime_role}"`,
    );
    for (const role of [input.runtime_role, input.operator_role]) {
      await client.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE ${IDENTITY_TABLE} FROM "${role}"`);
    }
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE ${IDENTITY_TABLE} FROM PUBLIC`);
  });
}

/** The effective privilege matrix through `has_function_privilege` and
 * `has_table_privilege`, which include PUBLIC and inherited authority. */
export async function readStagingPostMigrationPrivilegeMatrix(
  adminUrl: string,
  input: Readonly<{ readonly runtime_role: string; readonly operator_role: string }>,
): Promise<{
  readonly runtime: {
    readonly probe_execute: boolean;
    readonly identity_insert: boolean;
    readonly identity_update: boolean;
    readonly identity_delete: boolean;
  };
  readonly operator: {
    readonly probe_execute: boolean;
    readonly identity_insert: boolean;
    readonly identity_update: boolean;
    readonly identity_delete: boolean;
  };
}> {
  return withClient(adminUrl, async (client) => {
    const result = await client.query<Record<string, boolean>>(
      `SELECT
         has_function_privilege($1, 'api_next.${PROBE_FUNCTION}', 'EXECUTE') AS runtime_probe_execute,
         has_table_privilege($1, '${IDENTITY_TABLE}', 'INSERT') AS runtime_identity_insert,
         has_table_privilege($1, '${IDENTITY_TABLE}', 'UPDATE') AS runtime_identity_update,
         has_table_privilege($1, '${IDENTITY_TABLE}', 'DELETE') AS runtime_identity_delete,
         has_function_privilege($2, 'api_next.${PROBE_FUNCTION}', 'EXECUTE') AS operator_probe_execute,
         has_table_privilege($2, '${IDENTITY_TABLE}', 'INSERT') AS operator_identity_insert,
         has_table_privilege($2, '${IDENTITY_TABLE}', 'UPDATE') AS operator_identity_update,
         has_table_privilege($2, '${IDENTITY_TABLE}', 'DELETE') AS operator_identity_delete`,
      [input.runtime_role, input.operator_role],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("staging_privilege_matrix_unavailable");
    const flag = (key: string) => row[key] === true;
    return {
      runtime: {
        probe_execute: flag("runtime_probe_execute"),
        identity_insert: flag("runtime_identity_insert"),
        identity_update: flag("runtime_identity_update"),
        identity_delete: flag("runtime_identity_delete"),
      },
      operator: {
        probe_execute: flag("operator_probe_execute"),
        identity_insert: flag("operator_identity_insert"),
        identity_update: flag("operator_identity_update"),
        identity_delete: flag("operator_identity_delete"),
      },
    };
  });
}

export async function readStagingMigrationLedger(
  adminUrl: string,
): Promise<readonly { readonly version: string; readonly checksum: string }[]> {
  return withClient(adminUrl, async (client) => {
    const result = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM api_next.schema_migrations ORDER BY version",
    );
    return result.rows;
  });
}

export async function readHnsPinnedMigrations(): Promise<
  readonly { readonly version: string; readonly checksum: string }[]
> {
  return (await loadPostgresMigrations()).map(({ version, checksum }) => ({ version, checksum }));
}

/** Starts the explicitly named staging unit. The name is checked here as well
 * as in the sequence so a production unit cannot be started through this
 * path even by a mistaken caller. */
export async function startStagingServiceUnit(unit: string): Promise<void> {
  if (unit !== HNS_STAGING_SERVICE_UNIT) {
    throw new Error("staging_service_unit_not_authorized");
  }
  const child = Bun.spawn(["systemctl", "start", unit], { stderr: "pipe", stdout: "pipe" });
  const [exitCode] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error("staging_service_start_failed");
}

export function makeHnsStagingPostMigrationPorts(input: {
  readonly connection_strings: Readonly<{
    readonly admin: string;
    readonly runtime: string;
    readonly operator: string;
  }>;
  readonly target_binding: HnsStagingTargetBinding;
  readonly start_service?: (unit: string) => Promise<void>;
}): HnsStagingPostMigrationPorts {
  const { admin, runtime, operator } = input.connection_strings;
  return {
    readTargetBinding: async () => input.target_binding,
    readMigratorIdentity: () => readSqlIdentity(admin),
    readRuntimeIdentity: () => readSqlIdentity(runtime),
    readOperatorIdentity: () => readSqlIdentity(operator),
    readMigrationLedger: () => readStagingMigrationLedger(admin),
    readPinnedMigrations: readHnsPinnedMigrations,
    applyReviewedGrants: (grants) => applyStagingPostMigrationGrants(admin, grants),
    readPrivilegeMatrix: (roles) => readStagingPostMigrationPrivilegeMatrix(admin, roles),
    stageBundle: stageHnsReadinessCutoverBundle,
    seedExecutionProbe: seedHnsLifecycleCutoverProbe,
    startService: input.start_service ?? startStagingServiceUnit,
    readSchemaCompatibility: ({ service_version, job_envelope_version }) =>
      readHnsLifecycleSchemaCompatibility({ service_version, job_envelope_version }),
    readCutoverIdentity: readCutoverIdentityRow,
  };
}

export async function main(arguments_: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const option = (name: string): string | undefined => {
    const index = arguments_.indexOf(name);
    return index === -1 ? undefined : arguments_[index + 1];
  };
  const bundlePath = option("--bundle");
  const stageDirectory = option("--stage-directory");
  const executorId = option("--executor-id");
  const runtimeRole = option("--runtime-role");
  const operatorRole = option("--operator-role");
  const migratorRole = option("--migrator-role");
  if (
    bundlePath === undefined ||
    stageDirectory === undefined ||
    executorId === undefined ||
    runtimeRole === undefined ||
    operatorRole === undefined ||
    migratorRole === undefined
  ) {
    throw new Error(
      "usage: staging-hns-post-migration-entry --bundle <file> --stage-directory <dir> --executor-id <id> --runtime-role <role> --operator-role <role> --migrator-role <role>",
    );
  }
  const adminUrl = requireConnectionString(ADMIN_URL_ENV);
  const runtimeUrl = requireConnectionString(RUNTIME_URL_ENV);
  const operatorUrl = requireConnectionString(OPERATOR_URL_ENV);
  const serviceVersion = option("--service-version") ?? HNS_AUTHORITY_SERVICE_VERSION;
  const jobEnvelopeVersion = option("--job-envelope-version") ?? HNS_LIFECYCLE_JOB_ENVELOPE_VERSION;
  const authorized: HnsStagingAuthorizedTarget = {
    database_id: HNS_STAGING_DATABASE_ID,
    database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
    sql_database: HNS_STAGING_SQL_DATABASE,
    branch_id: HNS_STAGING_BRANCH_ID,
    branch_name: HNS_STAGING_BRANCH_NAME,
    runtime_role: runtimeRole,
    operator_role: operatorRole,
    migrator_role: migratorRole,
    service_unit: HNS_STAGING_SERVICE_UNIT,
  };
  const targetBinding = await collectStagingPostMigrationTargetBinding(adminUrl);
  const pollTimeout = option("--identity-poll-timeout-ms");
  const result = await runHnsStagingPostMigration({
    authorized,
    release: {
      service_version: serviceVersion,
      job_envelope_version: jobEnvelopeVersion,
    },
    bundle: {
      bundle_path: bundlePath,
      bundle_sha256: await sha256File(bundlePath),
      service_version: serviceVersion,
      job_envelope_version: jobEnvelopeVersion,
      executor_id: executorId,
    },
    stage_directory: stageDirectory,
    ports: makeHnsStagingPostMigrationPorts({
      connection_strings: { admin: adminUrl, runtime: runtimeUrl, operator: operatorUrl },
      target_binding: targetBinding,
    }),
    ...(pollTimeout === undefined ? {} : { identity_poll: { timeout_ms: Number(pollTimeout) } }),
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (error instanceof HnsStagingPostMigrationRefused) {
      console.error(postMigrationRefusalJson(error.refusal));
    } else {
      console.error(postMigrationFailureJson(error));
    }
    process.exitCode = 1;
  });
}

/** The bounded failure shape for anything that is not a named refusal. The
 * diagnostic is redacted with the same rule as every other cause on this
 * path, so a connection string or credential never reaches a log. */
export function postMigrationFailureJson(error: unknown): string {
  const cause = redactedDiagnosticCause(error);
  return JSON.stringify({
    outcome: "post_migration_failed",
    reason: cause === null || cause.length === 0 ? "post-migration failed" : cause.slice(0, 256),
  });
}
