import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import {
  JOB_ENVELOPE_VERSION,
  PROBE_SESSION,
  requireExactLedger,
  SERVICE_VERSION,
  SeedRefusal,
} from "./staging-hns-cutover-probe-seed.ts";
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
 * Guarded re-seed of the synthetic cutover readiness probe for a new staging
 * provisioner release.
 *
 * Operator preconditions:
 * - Stop the previous provisioner release before re-seeding, and keep it
 *   stopped until the new release has started. The queued probe job belongs
 *   to no attempt, so a previous release that restarts in between takes it,
 *   records its own attempt as ready, and the new release then fails with
 *   attempt_mismatch.
 * - A failed attempt id is burned. Reconciling a failed attempt_mismatch
 *   admits only a fresh manifest attempt_id, never the failed one.
 *
 * Past the schema cutover a release serves only after its own attempt
 * completes the probe, and a completed probe never satisfies a different
 * attempt. The first-seed command admits only the never-seeded state, so a
 * later release needs this separate operation. It reads the release manifest
 * the operator reviewed, proves the bundle beside it matches, requires the
 * staging ledger to equal this source tree's migrations, and admits exactly
 * one of two identity states: the previous attempt's completed probe, or a
 * named failed attempt whose only fault was the attempt mismatch. Any queued
 * or leased probe job, any other probe or identity shape, or a reused attempt
 * refuses. Execution calls the maintained seed function inside one locked
 * transaction and commits only if exactly one fresh probe job was queued and
 * nothing else changed. Every failure prints a fixed refusal code only.
 */

export type ReseedCommand = Readonly<{
  manifest_path: string;
  reconcile_failed_attempt: string | undefined;
  expected_probe_jobs: readonly string[] | undefined;
  execute: boolean;
  expected_admin_role: string | undefined;
}>;

const ATTEMPT_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

export function parseReseedCommand(arguments_: readonly string[]): ReseedCommand {
  let manifest: string | undefined;
  let reconcile: string | undefined;
  let probeJobs: readonly string[] | undefined;
  let execute = false;
  let role: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--manifest") {
      if (manifest !== undefined) throw new SeedRefusal("manifest_duplicate");
      if (value === undefined || !isAbsolute(value)) throw new SeedRefusal("manifest_invalid");
      manifest = value;
      index += 1;
    } else if (argument === "--reconcile-failed-attempt") {
      if (reconcile !== undefined) throw new SeedRefusal("reconcile_duplicate");
      if (value === undefined || !ATTEMPT_ID.test(value))
        throw new SeedRefusal("reconcile_invalid");
      reconcile = value;
      index += 1;
    } else if (argument === "--expect-probe-jobs") {
      if (probeJobs !== undefined) throw new SeedRefusal("probe_jobs_duplicate");
      if (
        value === undefined ||
        !/^\d{1,12}:(?:completed|failed)(?:,\d{1,12}:(?:completed|failed))*$/u.test(value)
      )
        throw new SeedRefusal("probe_jobs_invalid");
      probeJobs = value.split(",");
      index += 1;
    } else if (argument === "--execute") {
      if (execute) throw new SeedRefusal("execute_duplicate");
      execute = true;
    } else if (argument === "--expect-admin-role") {
      if (role !== undefined) throw new SeedRefusal("admin_role_duplicate");
      if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value))
        throw new SeedRefusal("admin_role_invalid");
      role = value;
      index += 1;
    } else throw new SeedRefusal("option_invalid");
  }
  if (manifest === undefined) throw new SeedRefusal("manifest_required");
  if (execute && role === undefined) throw new SeedRefusal("admin_role_required");
  // The operator copies the settled probe history from the dry run; execution
  // refuses unless it is still exactly that history.
  if (execute && probeJobs === undefined) throw new SeedRefusal("probe_jobs_required");
  if (!execute && role !== undefined) throw new SeedRefusal("admin_role_without_execute");
  return {
    manifest_path: manifest,
    reconcile_failed_attempt: reconcile,
    expected_probe_jobs: probeJobs,
    execute,
    expected_admin_role: role,
  };
}

export type ReviewedRelease = Readonly<{ bundle_sha256: string; attempt_id: string }>;

/** The manifest must name this service generation, and the bundle beside it
 * must be the bytes it pins. */
export function requireReviewedRelease(
  manifestText: string,
  bundleBytes: Uint8Array,
): ReviewedRelease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new SeedRefusal("manifest_unreadable");
  }
  const manifest = parsed as Record<string, unknown>;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof manifest.bundle_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.bundle_sha256) ||
    typeof manifest.attempt_id !== "string" ||
    !ATTEMPT_ID.test(manifest.attempt_id) ||
    manifest.service_version !== SERVICE_VERSION ||
    manifest.job_envelope_version !== JOB_ENVELOPE_VERSION
  )
    throw new SeedRefusal("manifest_shape");
  if (createHash("sha256").update(bundleBytes).digest("hex") !== manifest.bundle_sha256)
    throw new SeedRefusal("bundle_digest_mismatch");
  return { bundle_sha256: manifest.bundle_sha256, attempt_id: manifest.attempt_id };
}

export type ReseedState = Readonly<{
  sql_database: string;
  session_user: string;
  current_user: string;
  cutover: readonly Readonly<{ services: readonly string[]; envelopes: readonly string[] }>[];
  probe_lifecycle: readonly Readonly<{
    session: string;
    synthetic: boolean;
    phase: string;
    generation: number;
    revision: number;
  }>[];
  probe_jobs: readonly Readonly<{
    job_id: number;
    kind: string;
    state: string;
    generation: number;
  }>[];
  identity: readonly Readonly<{
    service_version: string;
    attempt_id: string;
    probe_outcome: string;
    probe_reason: string | null;
  }>[];
}>;

function requireCutover(state: ReseedState) {
  if (
    state.cutover.length !== 1 ||
    !state.cutover[0]?.services.includes(SERVICE_VERSION) ||
    !state.cutover[0]?.envelopes.includes(JOB_ENVELOPE_VERSION)
  )
    throw new SeedRefusal("cutover_pair");
}

function requireProbeLifecycle(state: ReseedState) {
  const [row] = state.probe_lifecycle;
  if (
    state.probe_lifecycle.length !== 1 ||
    row?.session !== PROBE_SESSION ||
    row.synthetic !== true ||
    row.phase !== "checking_authority" ||
    row.generation !== 1
  )
    throw new SeedRefusal("probe_lifecycle_unexpected");
}

/** Admits a previously seeded probe whose jobs are all settled and whose
 * identity row belongs to an earlier attempt. */
export function requirePreReseedState(
  state: ReseedState,
  release: ReviewedRelease,
  reconcileFailedAttempt: string | undefined,
  expectedProbeJobs?: readonly string[],
) {
  requireCutover(state);
  requireProbeLifecycle(state);
  if (state.probe_jobs.length === 0) throw new SeedRefusal("probe_never_seeded");
  for (const job of state.probe_jobs) {
    if (job.state === "queued" || job.state === "leased")
      throw new SeedRefusal("probe_job_competing");
    if (job.kind !== "observe_readiness" || (job.state !== "completed" && job.state !== "failed"))
      throw new SeedRefusal("probe_job_unexpected");
  }
  if (
    expectedProbeJobs !== undefined &&
    JSON.stringify(state.probe_jobs.map((job) => `${job.job_id}:${job.state}`)) !==
      JSON.stringify(expectedProbeJobs)
  )
    throw new SeedRefusal("probe_history_unexpected");
  const [identity] = state.identity;
  if (state.identity.length !== 1 || identity === undefined)
    throw new SeedRefusal("service_identity_unexpected");
  if (identity.service_version !== SERVICE_VERSION)
    throw new SeedRefusal("identity_service_version");
  if (identity.attempt_id === release.attempt_id || reconcileFailedAttempt === release.attempt_id)
    throw new SeedRefusal("attempt_not_fresh");
  if (identity.probe_outcome === "ready" || identity.probe_outcome === "replayed") {
    if (reconcileFailedAttempt !== undefined) throw new SeedRefusal("reconcile_not_needed");
    return;
  }
  if (identity.probe_outcome === "failed" && identity.probe_reason === "attempt_mismatch") {
    if (reconcileFailedAttempt !== identity.attempt_id)
      throw new SeedRefusal("failed_attempt_unacknowledged");
    return;
  }
  throw new SeedRefusal("identity_unreconcilable");
}

/** The seed may add exactly one queued generation-1 probe job and must leave
 * the lifecycle row, every earlier job and the identity row untouched. */
export function requirePostReseedState(before: ReseedState, after: ReseedState) {
  requireCutover(after);
  requireProbeLifecycle(after);
  if (JSON.stringify(after.probe_lifecycle) !== JSON.stringify(before.probe_lifecycle))
    throw new SeedRefusal("post_lifecycle_changed");
  if (JSON.stringify(after.identity) !== JSON.stringify(before.identity))
    throw new SeedRefusal("post_identity_changed");
  const previousMax = Math.max(...before.probe_jobs.map((job) => job.job_id));
  const kept = after.probe_jobs.filter((job) => job.job_id <= previousMax);
  const added = after.probe_jobs.filter((job) => job.job_id > previousMax);
  if (JSON.stringify(kept) !== JSON.stringify(before.probe_jobs))
    throw new SeedRefusal("post_prior_jobs_changed");
  const [job] = added;
  if (
    added.length !== 1 ||
    job?.kind !== "observe_readiness" ||
    job.state !== "queued" ||
    job.generation !== 1
  )
    throw new SeedRefusal("post_job");
}

async function readReseedState(client: Client, schema: string): Promise<ReseedState> {
  const who = (
    await client.query("SELECT current_database() AS d, session_user AS s, current_user AS c")
  ).rows[0];
  const cutover = await client.query(
    `SELECT compatible_service_versions AS s, compatible_job_envelope_versions AS e FROM "${schema}".hns_lifecycle_schema_cutover`,
  );
  const lifecycle = await client.query(
    `SELECT root_import_session_id AS session, synthetic, phase::text AS phase,
            generation::int AS generation, revision::int AS revision
       FROM "${schema}".hns_root_import_lifecycle
      WHERE root_import_session_id = $1 OR synthetic ORDER BY 1`,
    [PROBE_SESSION],
  );
  const jobs = await client.query(
    `SELECT lifecycle_job_id::int AS job_id, job_kind::text AS kind, state::text AS state,
            generation::int AS generation
       FROM "${schema}".hns_root_import_lifecycle_jobs
      WHERE root_import_session_id = $1 ORDER BY lifecycle_job_id`,
    [PROBE_SESSION],
  );
  const identity = await client.query(
    `SELECT service_version, attempt_id, probe_outcome, probe_reason
       FROM "${schema}".hns_lifecycle_service_identity
      WHERE service_name = 'pirate-hns-authority-provisioner'`,
  );
  return {
    sql_database: who.d,
    session_user: who.s,
    current_user: who.c,
    cutover: cutover.rows.map((row) => ({ services: row.s, envelopes: row.e })),
    probe_lifecycle: lifecycle.rows,
    probe_jobs: jobs.rows,
    identity: identity.rows,
  };
}

function summary(state: ReseedState) {
  return {
    admin_role: state.current_user,
    probe_jobs: state.probe_jobs.map(({ job_id, state: jobState }) => `${job_id}:${jobState}`),
    identity: state.identity.map(({ attempt_id, probe_outcome, probe_reason }) => ({
      attempt_id,
      probe_outcome,
      probe_reason,
    })),
  };
}

export async function runReseedCommand(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, unknown>>> {
  const command = parseReseedCommand(arguments_);
  const manifestText = await readFile(command.manifest_path, "utf8").catch(() => {
    throw new SeedRefusal("manifest_unreadable");
  });
  const bundleBytes = await readFile(
    join(dirname(command.manifest_path), "bin", "pirate-hns-authority-provisioner.mjs"),
  ).catch(() => {
    throw new SeedRefusal("bundle_unreadable");
  });
  const release = requireReviewedRelease(manifestText, bundleBytes);

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
  const [ledger, source] = await Promise.all([
    readStagingMigrationLedger(normalized),
    readHnsPinnedMigrations(),
  ]).catch(() => {
    throw new SeedRefusal("ledger_unreadable");
  });
  // The release is built from this source tree, so its migrations are the
  // ledger it was reviewed against.
  requireExactLedger(ledger, source);

  const client = new Client({ connectionString: normalized, connectionTimeoutMillis: 10_000 });
  await client.connect().catch(() => {
    throw new SeedRefusal("connect");
  });
  try {
    return await reseedWithinTransaction(client, {
      schema: "api_next",
      sql_database: HNS_STAGING_SQL_DATABASE,
      expected_role: command.expected_admin_role ?? target.migrator_role,
      release,
      reconcile_failed_attempt: command.reconcile_failed_attempt,
      expected_probe_jobs: command.expected_probe_jobs,
      execute: command.execute,
      ledger_migrations: ledger.length,
      ledger_head: ledger.at(-1)?.version ?? null,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

export type ReseedTransactionInput = Readonly<{
  schema: string;
  sql_database: string;
  expected_role: string;
  release: ReviewedRelease;
  reconcile_failed_attempt: string | undefined;
  expected_probe_jobs: readonly string[] | undefined;
  execute: boolean;
  ledger_migrations: number;
  ledger_head: string | null;
}>;

/** The locked read, check, seed and re-check, committed only on an exact
 * post-state. Exported so a disposable PostgreSQL schema can exercise the
 * maintained functions it calls. */
export async function reseedWithinTransaction(
  client: Client,
  input: ReseedTransactionInput,
): Promise<Readonly<Record<string, unknown>>> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(input.schema)) throw new SeedRefusal("schema_invalid");
  const schema = input.schema;
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      `LOCK TABLE "${schema}".hns_root_import_lifecycle, "${schema}".hns_root_import_lifecycle_jobs, "${schema}".hns_lifecycle_service_identity IN SHARE ROW EXCLUSIVE MODE`,
    );
    const before = await readReseedState(client, schema);
    if (before.sql_database !== input.sql_database) throw new SeedRefusal("sql_database");
    if (before.session_user !== input.expected_role || before.current_user !== input.expected_role)
      throw new SeedRefusal("admin_role_mismatch");
    if (input.execute && input.expected_probe_jobs === undefined)
      throw new SeedRefusal("probe_jobs_required");
    requirePreReseedState(
      before,
      input.release,
      input.reconcile_failed_attempt,
      input.expected_probe_jobs,
    );
    const bound = {
      attempt_id: input.release.attempt_id,
      bundle_sha256: input.release.bundle_sha256,
      ledger_migrations: input.ledger_migrations,
      ledger_head: input.ledger_head,
      reconciled_failed_attempt: input.reconcile_failed_attempt ?? null,
    };
    if (!input.execute) {
      await client.query("ROLLBACK");
      return { outcome: "staging_probe_reseed_dry_run", ...bound, ...summary(before) };
    }
    const result = await client.query(
      `SELECT "${schema}".seed_hns_lifecycle_readiness_cutover_probe_v1() AS r`,
    );
    if (result.rows[0]?.r !== "seeded") throw new SeedRefusal("seed_result");
    const after = await readReseedState(client, schema);
    requirePostReseedState(before, after);
    try {
      await client.query("COMMIT");
      committed = true;
    } catch {
      // Never rerun blind: a fresh dry run reads the state, and the queued
      // job it left refuses the execute path as a competing probe.
      throw new SeedRefusal("commit_outcome_ambiguous_read_back_before_any_retry");
    }
    return { outcome: "staging_probe_reseeded", ...bound, ...summary(after) };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SeedRefusal) throw error;
    throw new SeedRefusal("database_step_failed");
  }
}

if (import.meta.main) {
  await runReseedCommand(Bun.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      // Provider and SQL errors can carry credentials or hosts; print a fixed code.
      const code = error instanceof SeedRefusal ? error.code : "unexpected";
      console.error(JSON.stringify({ outcome: "staging_probe_reseed_refused", code }));
      process.exitCode = 1;
    });
}
