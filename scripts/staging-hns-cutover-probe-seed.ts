import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_BRANCH_NAME,
  HNS_STAGING_DATABASE_ID,
  HNS_STAGING_PROVIDER_DATABASE_NAME,
  HNS_STAGING_SQL_DATABASE,
} from "./staging-hns-post-migration-contract.ts";
import {
  collectStagingPostMigrationTargetBinding,
  readHnsPinnedMigrations,
  readStagingMigrationLedger,
} from "./staging-hns-post-migration-runtime.ts";

/**
 * One-time, guarded seed of the synthetic cutover readiness probe on staging.
 *
 * The maintained seed function upserts the synthetic lifecycle row and
 * replaces any queued or leased probe job, so it must never run blind. This
 * command refuses before mutation unless the provider-verified target, the
 * migrator SQL role the operator approved from a dry run, the exact pinned
 * ledger and the recorded cutover pair all match, and the probe tables hold no
 * state that would need reconciliation. Inside one locked transaction it then
 * calls the function and asserts the exact synthetic row and single queued job
 * before committing. Every failure prints a fixed refusal code only.
 */

export const PROBE_SESSION = "cutover-readiness-probe";
export const SERVICE_VERSION = "pirate-hns-authority-provisioner-v2";
export const JOB_ENVELOPE_VERSION = "hns-lifecycle-job-envelope-v1";

export class SeedRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type SeedCommand = Readonly<{ execute: boolean; expected_admin_role: string | undefined }>;

export function parseSeedCommand(arguments_: readonly string[]): SeedCommand {
  let execute = false;
  let role: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--execute") {
      if (execute) throw new SeedRefusal("execute_duplicate");
      execute = true;
    } else if (argument === "--expect-admin-role") {
      const value = arguments_[index + 1];
      if (role !== undefined) throw new SeedRefusal("admin_role_duplicate");
      if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value))
        throw new SeedRefusal("admin_role_invalid");
      role = value;
      index += 1;
    } else throw new SeedRefusal("option_invalid");
  }
  if (execute && role === undefined) throw new SeedRefusal("admin_role_required");
  if (!execute && role !== undefined) throw new SeedRefusal("admin_role_without_execute");
  return { execute, expected_admin_role: role };
}

export type Migration = Readonly<{ version: string; checksum: string }>;

export function requireExactLedger(ledger: readonly Migration[], pinned: readonly Migration[]) {
  if (pinned.length === 0 || ledger.length !== pinned.length)
    throw new SeedRefusal("ledger_length");
  for (let index = 0; index < pinned.length; index += 1) {
    if (ledger[index]?.version !== pinned[index]?.version) throw new SeedRefusal("ledger_version");
    if (ledger[index]?.checksum !== pinned[index]?.checksum)
      throw new SeedRefusal("ledger_checksum");
  }
}

export type ProbeState = Readonly<{
  sql_database: string;
  session_user: string;
  current_user: string;
  cutover: readonly Readonly<{ services: readonly string[]; envelopes: readonly string[] }>[];
  lifecycle: readonly Readonly<{ session: string; synthetic: boolean; phase: string }>[];
  jobs: readonly Readonly<{ session: string; kind: string; state: string; generation: number }>[];
  identity_rows: number;
}>;

export function requireIdentity(state: ProbeState, expectedAdminRole: string) {
  if (state.sql_database !== HNS_STAGING_SQL_DATABASE) throw new SeedRefusal("sql_database");
  if (state.session_user !== expectedAdminRole || state.current_user !== expectedAdminRole)
    throw new SeedRefusal("admin_role_mismatch");
}

export function requireCutoverPair(state: ProbeState) {
  if (
    state.cutover.length !== 1 ||
    !state.cutover[0]?.services.includes(SERVICE_VERSION) ||
    !state.cutover[0]?.envelopes.includes(JOB_ENVELOPE_VERSION)
  )
    throw new SeedRefusal("cutover_pair");
}

/** Only the empty never-seeded state is admitted; anything else is reconciled
 * by a person reading it back, never overwritten by a rerun. */
export function requirePreSeedState(state: ProbeState) {
  requireCutoverPair(state);
  if (state.lifecycle.length !== 0) throw new SeedRefusal("lifecycle_not_empty");
  if (state.jobs.length !== 0) throw new SeedRefusal("lifecycle_jobs_not_empty");
  if (state.identity_rows !== 0) throw new SeedRefusal("service_identity_present");
}

export function requirePostSeedState(state: ProbeState) {
  requireCutoverPair(state);
  const [row] = state.lifecycle;
  if (
    state.lifecycle.length !== 1 ||
    row?.session !== PROBE_SESSION ||
    row.synthetic !== true ||
    row.phase !== "checking_authority"
  )
    throw new SeedRefusal("post_lifecycle");
  const [job] = state.jobs;
  if (
    state.jobs.length !== 1 ||
    job?.session !== PROBE_SESSION ||
    job.kind !== "observe_readiness" ||
    job.state !== "queued" ||
    job.generation !== 1
  )
    throw new SeedRefusal("post_job");
  if (state.identity_rows !== 0) throw new SeedRefusal("post_identity");
}

async function readProbeState(client: Client): Promise<ProbeState> {
  const who = (
    await client.query("SELECT current_database() AS d, session_user AS s, current_user AS c")
  ).rows[0];
  const cutover = await client.query(
    "SELECT compatible_service_versions AS s, compatible_job_envelope_versions AS e FROM api_next.hns_lifecycle_schema_cutover",
  );
  const lifecycle = await client.query(
    "SELECT root_import_session_id AS session, synthetic, phase::text AS phase FROM api_next.hns_root_import_lifecycle ORDER BY 1",
  );
  const jobs = await client.query(
    "SELECT root_import_session_id AS session, job_kind::text AS kind, state::text AS state, generation::int AS generation FROM api_next.hns_root_import_lifecycle_jobs ORDER BY 1",
  );
  const identity = await client.query(
    "SELECT count(*)::int AS n FROM api_next.hns_lifecycle_service_identity",
  );
  return {
    sql_database: who.d,
    session_user: who.s,
    current_user: who.c,
    cutover: cutover.rows.map((row) => ({ services: row.s, envelopes: row.e })),
    lifecycle: lifecycle.rows,
    jobs: jobs.rows,
    identity_rows: identity.rows[0].n,
  };
}

function summary(state: ProbeState) {
  return {
    admin_role: state.current_user,
    lifecycle_rows: state.lifecycle.length,
    lifecycle_jobs: state.jobs.length,
    service_identity_rows: state.identity_rows,
  };
}

export async function runSeedCommand(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, unknown>>> {
  const command = parseSeedCommand(arguments_);
  const adminRaw = environment.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (adminRaw === undefined || adminRaw.length === 0 || adminRaw.trim() !== adminRaw)
    throw new SeedRefusal("admin_credential_missing");
  const target = await collectStagingPostMigrationTargetBinding(adminRaw).catch(() => {
    throw new SeedRefusal("provider_target_unproven");
  });
  if (
    target.database_id !== HNS_STAGING_DATABASE_ID ||
    target.database_name !== HNS_STAGING_PROVIDER_DATABASE_NAME ||
    target.branch_id !== HNS_STAGING_BRANCH_ID ||
    target.branch_name !== HNS_STAGING_BRANCH_NAME ||
    target.branch_ready !== true ||
    target.sql_database !== HNS_STAGING_SQL_DATABASE
  )
    throw new SeedRefusal("provider_target_mismatch");
  if (command.execute && target.migrator_role !== command.expected_admin_role)
    throw new SeedRefusal("provider_admin_role_mismatch");
  const normalized = normalizePostgresConnectionString(adminRaw);
  const [ledger, pinned] = await Promise.all([
    readStagingMigrationLedger(normalized),
    readHnsPinnedMigrations(),
  ]).catch(() => {
    throw new SeedRefusal("ledger_unreadable");
  });
  requireExactLedger(ledger, pinned);

  const client = new Client({ connectionString: normalized, connectionTimeoutMillis: 10_000 });
  await client.connect().catch(() => {
    throw new SeedRefusal("connect");
  });
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      "LOCK TABLE api_next.hns_root_import_lifecycle, api_next.hns_root_import_lifecycle_jobs, api_next.hns_lifecycle_service_identity IN SHARE ROW EXCLUSIVE MODE",
    );
    const before = await readProbeState(client);
    requireIdentity(before, command.expected_admin_role ?? target.migrator_role);
    requirePreSeedState(before);
    if (!command.execute) {
      await client.query("ROLLBACK");
      return {
        outcome: "staging_probe_seed_dry_run",
        ledger_migrations: ledger.length,
        target_admin_role: target.migrator_role,
        ...summary(before),
      };
    }
    const result = await client.query(
      "SELECT api_next.seed_hns_lifecycle_readiness_cutover_probe_v1() AS r",
    );
    if (result.rows[0]?.r !== "seeded") throw new SeedRefusal("seed_result");
    const after = await readProbeState(client);
    requirePostSeedState(after);
    try {
      await client.query("COMMIT");
      committed = true;
    } catch {
      // The server may or may not have committed. Never rerun blind: a fresh
      // dry run reads the state, and a seeded state refuses the execute path.
      throw new SeedRefusal("commit_outcome_ambiguous_read_back_before_any_retry");
    }
    return { outcome: "staging_probe_seeded", ledger_migrations: ledger.length, ...summary(after) };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SeedRefusal) throw error;
    throw new SeedRefusal("database_step_failed");
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  await runSeedCommand(Bun.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      // Provider and SQL errors can carry credentials or hosts; print a fixed code.
      const code = error instanceof SeedRefusal ? error.code : "unexpected";
      console.error(JSON.stringify({ outcome: "staging_probe_seed_refused", code }));
      process.exitCode = 1;
    });
}
