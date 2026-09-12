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
 * preflight migration, apply the removal migration, start the compatible
 * service and verify its claims. The preflight and removal are separate
 * `runPostgresMigrations` calls so the preflight's durable unresolved
 * dispositions commit even when removal refuses.
 */

export type HnsReadinessCutoverBundle = Readonly<{
  readonly bundle_path: string;
  readonly bundle_sha256: string;
  readonly service_version: string;
  readonly job_envelope_version: string;
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
  readonly startService: () => Promise<void>;
  readonly verifyClaims: () => Promise<boolean>;
}>;

export type HnsReadinessCutoverRefusal = Readonly<{
  readonly outcome: "cutover_refused";
  readonly step:
    | "launch_guard"
    | "stage_bundle"
    | "quiesce"
    | "account_leases"
    | "preflight"
    | "removal"
    | "start"
    | "verify_claims";
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

  await input.ports.startService();
  steps.push("service_started");

  const claimsVerified = await input.ports.verifyClaims();
  if (!claimsVerified) {
    throw refused("verify_claims", "claims_unverified");
  }
  steps.push("claims_verified");

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
  await runPostgresMigrations({
    connectionString: requireConnectionString(),
    migrations: await loadPostgresMigrations(),
  });
}

export async function main(arguments_: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const option = (name: string): string | undefined => {
    const index = arguments_.indexOf(name);
    return index === -1 ? undefined : arguments_[index + 1];
  };
  const bundlePath = option("--bundle");
  const stageDirectory = option("--stage-directory");
  if (bundlePath === undefined || stageDirectory === undefined) {
    throw new Error("usage: hns-readiness-cutover --bundle <file> --stage-directory <dir>");
  }
  const bundleSha = await sha256File(bundlePath);
  const bundle: HnsReadinessCutoverBundle = {
    bundle_path: bundlePath,
    bundle_sha256: bundleSha,
    service_version: option("--service-version") ?? "pirate-hns-authority-provisioner-v2",
    job_envelope_version: option("--job-envelope-version") ?? "hns-lifecycle-job-envelope-v1",
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
      startService: () => runCommand(startCommand.split(" "), "start"),
      verifyClaims: () =>
        withClient(async (client) => {
          const result = await client.query<{ compatibility: string }>(
            "SELECT hns_lifecycle_schema_compatibility_v1($1,$2) AS compatibility",
            [bundle.service_version, bundle.job_envelope_version],
          );
          return result.rows[0]?.compatibility === "compatible";
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
