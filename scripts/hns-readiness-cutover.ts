import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import {
  readSchemaCutoverState,
  type SchemaCutoverState,
  schemaCompatibilityRefusal,
} from "../apps/hns-authority-provisioner/src/schema-compatibility.ts";
import { loadPostgresMigrations, runPostgresMigrations } from "./postgres-migrations.ts";

/**
 * The executable service/schema cutover sequence.
 *
 * The order is fixed: refuse an incompatible bundle, stage the compatible
 * bundle, quiesce the old executor, account for its live leases, apply the
 * preflight migration, apply the bounded removal batch, seed the controlled
 * execution probe, start the compatible service, then prove separately that
 * the schema is compatible, that the running artifact is the staged one, and
 * that its executor completed controlled readiness work. The preflight and
 * removal are separate `runPostgresMigrations` calls so the preflight's
 * durable unresolved dispositions commit even when removal refuses.
 *
 * The removal batch is bounded to the reviewed cutover endpoint: a migration
 * added after this review is refused rather than silently applied.
 */

export const HNS_READINESS_CUTOVER_ENDPOINT = "0171_hns_cutover_execution_probe.sql";

export type HnsReadinessCutoverBundle = Readonly<{
  readonly bundle_path: string;
  readonly bundle_sha256: string;
  readonly service_version: string;
  readonly job_envelope_version: string;
  readonly executor_id: string;
}>;

export type HnsRunningIdentity = Readonly<{
  readonly bundle_sha256: string;
  readonly service_version: string;
  readonly executor_id: string;
  readonly heartbeat_fresh: boolean;
}>;

export type HnsExecutorProgress = Readonly<{
  readonly probe_outcome: string;
  readonly heartbeat_fresh: boolean;
}>;

export type HnsReadinessCutoverPorts = Readonly<{
  readonly readSchemaState: () => Promise<SchemaCutoverState | null>;
  readonly stageBundle: (input: {
    readonly bundle: HnsReadinessCutoverBundle;
    readonly stage_directory: string;
  }) => Promise<void>;
  readonly quiesceExecutor: () => Promise<void>;
  readonly accountLiveLegacyLeases: () => Promise<number>;
  readonly applyPreflight: () => Promise<void>;
  readonly applyRemoval: () => Promise<void>;
  readonly seedExecutionProbe: () => Promise<void>;
  readonly startService: () => Promise<void>;
  readonly readSchemaCompatibility: () => Promise<string>;
  readonly verifyRunningIdentity: () => Promise<HnsRunningIdentity | null>;
  readonly verifyExecutorProgress: () => Promise<HnsExecutorProgress | null>;
}>;

export type HnsReadinessCutoverRefusal = Readonly<{
  readonly outcome: "cutover_refused";
  readonly step:
    | "launch_guard"
    | "stage_bundle"
    | "quiesce"
    | "account_leases"
    | "migrations"
    | "preflight"
    | "removal"
    | "seed_probe"
    | "start"
    | "schema_compatibility"
    | "service_identity"
    | "executor_progress";
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}>;

export class HnsReadinessCutoverRefused extends Error {
  readonly refusal: HnsReadinessCutoverRefusal;

  constructor(refusal: HnsReadinessCutoverRefusal) {
    super(`HNS readiness cutover refused at ${refusal.step}: ${refusal.reason}`);
    this.name = "HnsReadinessCutoverRefused";
    this.refusal = refusal;
  }
}

function refused(
  step: HnsReadinessCutoverRefusal["step"],
  reason: string,
  detail?: Readonly<Record<string, unknown>>,
): HnsReadinessCutoverRefused {
  return new HnsReadinessCutoverRefused({
    outcome: "cutover_refused",
    step,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * Refuses a migration set that reaches past the reviewed cutover endpoint.
 * `migration.version` is the migration filename; the fixed-width ordinal
 * prefix makes lexical order numeric order.
 */
export function assertMigrationsWithinEndpoint(
  migrations: readonly { readonly version: string }[],
  endpoint: string = HNS_READINESS_CUTOVER_ENDPOINT,
): void {
  const beyond = migrations
    .map((migration) => migration.version)
    .filter((version) => version > endpoint)
    .sort();
  if (beyond.length > 0) {
    throw refused("migrations", "migration_endpoint_exceeded", {
      endpoint,
      first_beyond: beyond[0],
    });
  }
}

export async function runHnsReadinessCutover(input: {
  readonly bundle: HnsReadinessCutoverBundle;
  readonly stage_directory: string;
  readonly ports: HnsReadinessCutoverPorts;
}): Promise<readonly string[]> {
  const steps: string[] = [];

  const state = await input.ports.readSchemaState();
  const guard = schemaCompatibilityRefusal({
    state,
    service_version: input.bundle.service_version,
    job_envelope_version: input.bundle.job_envelope_version,
  });
  if (guard !== null) {
    throw refused(
      "launch_guard",
      "schema_incompatible",
      guard as unknown as Record<string, unknown>,
    );
  }

  await input.ports.stageBundle({
    bundle: input.bundle,
    stage_directory: input.stage_directory,
  });
  steps.push("bundle_staged");

  await input.ports.quiesceExecutor();
  steps.push("executor_quiesced");

  const liveLeases = await input.ports.accountLiveLegacyLeases();
  if (liveLeases > 0) {
    throw refused("account_leases", "live_legacy_lease", { live_legacy_leases: liveLeases });
  }
  steps.push("leases_accounted");

  await input.ports.applyPreflight();
  steps.push("preflight_applied");

  await input.ports.applyRemoval();
  steps.push("removal_applied");

  await input.ports.seedExecutionProbe();
  steps.push("probe_seeded");

  await input.ports.startService();
  steps.push("service_started");

  const compatibility = await input.ports.readSchemaCompatibility();
  if (compatibility !== "compatible" && compatibility !== "pre_cutover") {
    throw refused("schema_compatibility", "schema_incompatible", {
      compatibility: compatibility.slice(0, 64),
    });
  }
  steps.push("schema_compatibility_recorded");

  const identity = await input.ports.verifyRunningIdentity();
  if (identity === null) {
    throw refused("service_identity", "service_never_started");
  }
  if (
    identity.bundle_sha256 !== input.bundle.bundle_sha256 ||
    identity.service_version !== input.bundle.service_version ||
    identity.executor_id !== input.bundle.executor_id ||
    !identity.heartbeat_fresh
  ) {
    throw refused("service_identity", "wrong_running_artifact", {
      expected_bundle_sha256: input.bundle.bundle_sha256,
      actual_bundle_sha256: identity.bundle_sha256.slice(0, 64),
      expected_service_version: input.bundle.service_version,
      actual_service_version: identity.service_version.slice(0, 64),
      expected_executor_id: input.bundle.executor_id,
      actual_executor_id: identity.executor_id.slice(0, 64),
    });
  }
  steps.push("service_identity_verified");

  const progress = await input.ports.verifyExecutorProgress();
  if (
    progress === null ||
    !progress.heartbeat_fresh ||
    (progress.probe_outcome !== "ready" && progress.probe_outcome !== "replayed")
  ) {
    throw refused("executor_progress", "executor_progress_missing", {
      probe_outcome: progress === null ? "absent" : progress.probe_outcome.slice(0, 64),
    });
  }
  steps.push("executor_progress_verified");

  return steps;
}

export function cutoverRefusalJson(refusal: HnsReadinessCutoverRefusal): string {
  return JSON.stringify(refusal);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function requireConnectionString(): string {
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (
    connectionString === undefined ||
    connectionString.trim() !== connectionString ||
    connectionString.length === 0
  ) {
    throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL is required for the cutover sequence");
  }
  return connectionString;
}

async function withClient<A>(use: (client: Client) => Promise<A>): Promise<A> {
  const client = new Client({ connectionString: requireConnectionString() });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runCommand(command: readonly string[], step: "quiesce" | "start"): Promise<void> {
  if (command.length === 0) throw new Error("cutover command is empty");
  const child = Bun.spawn([...command], { stderr: "pipe", stdout: "pipe" });
  const [exitCode] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    // The command's own diagnostics belong in operator logs, not in this
    // bounded refusal.
    throw refused(step, "command_failed", { command: command[0] });
  }
}

async function applyMigrationsBeforeRemoval(): Promise<void> {
  const migrations = await loadPostgresMigrations();
  const throughPreflight = migrations.filter((migration) => migration.version < "0169");
  await runPostgresMigrations({
    connectionString: requireConnectionString(),
    migrations: throughPreflight,
  });
}

async function applyRemovalMigration(): Promise<void> {
  const migrations = await loadPostgresMigrations();
  assertMigrationsWithinEndpoint(migrations);
  await runPostgresMigrations({
    connectionString: requireConnectionString(),
    migrations,
  });
}

export async function main(arguments_: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const option = (name: string): string | undefined => {
    const index = arguments_.indexOf(name);
    return index === -1 ? undefined : arguments_[index + 1];
  };
  const bundlePath = option("--bundle");
  const stageDirectory = option("--stage-directory");
  const executorId = option("--executor-id");
  if (bundlePath === undefined || stageDirectory === undefined || executorId === undefined) {
    throw new Error(
      "usage: hns-readiness-cutover --bundle <file> --stage-directory <dir> --executor-id <id>",
    );
  }
  const bundleSha = await sha256File(bundlePath);
  const bundle: HnsReadinessCutoverBundle = {
    bundle_path: bundlePath,
    bundle_sha256: bundleSha,
    service_version: option("--service-version") ?? "pirate-hns-authority-provisioner-v2",
    job_envelope_version: option("--job-envelope-version") ?? "hns-lifecycle-job-envelope-v1",
    executor_id: executorId,
  };
  const quiesceCommand =
    option("--quiesce-command") ?? "systemctl stop pirate-hns-authority-provisioner";
  const startCommand =
    option("--start-command") ?? "systemctl start pirate-hns-authority-provisioner";

  const steps = await runHnsReadinessCutover({
    bundle,
    stage_directory: stageDirectory,
    ports: {
      readSchemaState: () =>
        withClient((client) => readSchemaCutoverState((text) => client.query(text))),
      stageBundle: async ({ bundle: staged, stage_directory }) => {
        await mkdir(stage_directory, { recursive: true });
        const target = join(stage_directory, "pirate-hns-authority-provisioner.mjs");
        await Bun.write(target, Bun.file(staged.bundle_path));
        await writeFile(
          join(stage_directory, "deployment-manifest.json"),
          `${JSON.stringify(
            {
              bundle_sha256: staged.bundle_sha256,
              service_version: staged.service_version,
              job_envelope_version: staged.job_envelope_version,
              executor_id: staged.executor_id,
              staged_at: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        );
      },
      quiesceExecutor: () => runCommand(quiesceCommand.split(" "), "quiesce"),
      accountLiveLegacyLeases: () =>
        withClient(async (client) => {
          const result = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM hns_root_import_observation_jobs
              WHERE operation_kind = 'observe_root_v1'
                AND state = 'leased'
                AND lease_expires_at > clock_timestamp()`,
          );
          return Number(result.rows[0]?.count ?? "-1");
        }),
      applyPreflight: applyMigrationsBeforeRemoval,
      applyRemoval: applyRemovalMigration,
      seedExecutionProbe: () =>
        withClient(async (client) => {
          await client.query("SELECT seed_hns_lifecycle_readiness_cutover_probe_v1()");
        }),
      startService: () => runCommand(startCommand.split(" "), "start"),
      readSchemaCompatibility: () =>
        withClient(async (client) => {
          try {
            const result = await client.query<{ compatibility: string }>(
              "SELECT hns_lifecycle_schema_compatibility_v1($1,$2) AS compatibility",
              [bundle.service_version, bundle.job_envelope_version],
            );
            return result.rows[0]?.compatibility ?? "unavailable";
          } catch {
            return "incompatible";
          }
        }),
      verifyRunningIdentity: () =>
        withClient(async (client) => {
          const result = await client.query<{
            bundle_sha256: string;
            service_version: string;
            executor_id: string;
            heartbeat_fresh: boolean;
          }>(
            `SELECT bundle_sha256, service_version, executor_id,
                    heartbeat_at > clock_timestamp() - interval '120 seconds' AS heartbeat_fresh
               FROM hns_lifecycle_service_identity
              WHERE service_name = 'pirate-hns-authority-provisioner'`,
          );
          const row = result.rows[0];
          if (row === undefined) return null;
          return {
            bundle_sha256: row.bundle_sha256,
            service_version: row.service_version,
            executor_id: row.executor_id,
            heartbeat_fresh: row.heartbeat_fresh === true,
          };
        }),
      verifyExecutorProgress: () =>
        withClient(async (client) => {
          const result = await client.query<{
            probe_outcome: string;
            heartbeat_fresh: boolean;
          }>(
            `SELECT probe_outcome,
                    heartbeat_at > clock_timestamp() - interval '120 seconds' AS heartbeat_fresh
               FROM hns_lifecycle_service_identity
              WHERE service_name = 'pirate-hns-authority-provisioner'`,
          );
          const row = result.rows[0];
          if (row === undefined) return null;
          return {
            probe_outcome: row.probe_outcome,
            heartbeat_fresh: row.heartbeat_fresh === true,
          };
        }),
    },
  });
  console.log(JSON.stringify({ outcome: "cutover_applied", steps }));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (error instanceof HnsReadinessCutoverRefused) {
      console.error(cutoverRefusalJson(error.refusal));
    } else {
      console.error(
        JSON.stringify({
          outcome: "cutover_failed",
          reason: error instanceof Error ? error.message.slice(0, 256) : "cutover failed",
        }),
      );
    }
    process.exitCode = 1;
  });
}
