import { createHash, randomUUID } from "node:crypto";
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

export const HNS_READINESS_CUTOVER_ENDPOINT = "0172_hns_cutover_evidence_consistency.sql";

export type HnsReadinessCutoverBundle = Readonly<{
  readonly bundle_path: string;
  readonly bundle_sha256: string;
  readonly service_version: string;
  readonly job_envelope_version: string;
  readonly executor_id: string;
  readonly attempt_id: string;
}>;

export type HnsRunningIdentity = Readonly<{
  readonly attempt_id: string;
  readonly bundle_sha256: string;
  readonly measured_bundle_sha256: string;
  readonly expected_bundle_sha256: string;
  readonly service_version: string;
  readonly executor_id: string;
  readonly probe_job_id: number | null;
  readonly lease_fence: number | null;
  readonly probe_completed_at: Date | null;
  readonly probe_fresh: boolean;
  readonly probe_outcome: string;
  readonly probe_reason: string | null;
}>;

export type HnsExecutorProgress = Readonly<{
  readonly probe_outcome: string;
  readonly probe_reason: string | null;
  readonly probe_fresh: boolean;
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

/**
 * Maps a recorded probe outcome to the named immediate refusal, or null when
 * the outcome is still a success or a still-retryable shape. A failed probe
 * always names its own reason: `artifact_mismatch` and `attempt_mismatch` are
 * definite recorded failures, any other failed reason is bounded to
 * `probe_failed`.
 */
export function probeOutcomeRefusal(outcome: string, reason: string | null): string | null {
  if (outcome === "failed") {
    return reason === "artifact_mismatch" || reason === "attempt_mismatch"
      ? reason
      : "probe_failed";
  }
  if (outcome === "probe_absent") return "probe_absent";
  if (outcome === "lease_conflict") return "lease_conflict";
  return null;
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
  const identityDecision = hnsRunningIdentityRefusal(identity, input.bundle);
  if (identityDecision !== null) {
    throw refused("service_identity", identityDecision.reason, identityDecision.detail);
  }
  steps.push("service_identity_verified");

  const progress = await input.ports.verifyExecutorProgress();
  const progressDecision = hnsExecutorProgressRefusal(progress);
  if (progressDecision !== null) {
    throw refused("executor_progress", progressDecision.reason, progressDecision.detail);
  }
  steps.push("executor_progress_verified");

  return steps;
}

/**
 * The named decision for a polled running identity against the staged bundle.
 * A row that belongs to a previous attempt is `stale_attempt_result`; a probe
 * that recorded its own failure is reported by name; any other divergence is
 * `wrong_running_artifact`. Absence is the caller's own `service_never_started`
 * case and is not folded here.
 */
export function hnsRunningIdentityRefusal(
  identity: HnsRunningIdentity,
  bundle: HnsReadinessCutoverBundle,
): Readonly<{
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}> | null {
  if (identity.attempt_id !== bundle.attempt_id) {
    return {
      reason: "stale_attempt_result",
      detail: {
        expected_attempt_id: bundle.attempt_id,
        actual_attempt_id: identity.attempt_id.slice(0, 64),
      },
    };
  }
  const identityRefusal = probeOutcomeRefusal(identity.probe_outcome, identity.probe_reason);
  if (identityRefusal !== null) {
    return {
      reason: identityRefusal,
      detail: {
        probe_outcome: identity.probe_outcome.slice(0, 64),
        probe_reason: identity.probe_reason === null ? null : identity.probe_reason.slice(0, 64),
      },
    };
  }
  if (
    identity.bundle_sha256 !== bundle.bundle_sha256 ||
    identity.measured_bundle_sha256 !== bundle.bundle_sha256 ||
    identity.expected_bundle_sha256 !== bundle.bundle_sha256 ||
    identity.service_version !== bundle.service_version ||
    identity.executor_id !== bundle.executor_id ||
    identity.probe_job_id === null ||
    identity.lease_fence === null ||
    identity.probe_completed_at === null ||
    !identity.probe_fresh
  ) {
    return {
      reason: "wrong_running_artifact",
      detail: {
        expected_bundle_sha256: bundle.bundle_sha256,
        actual_bundle_sha256: identity.bundle_sha256.slice(0, 64),
        measured_bundle_sha256: identity.measured_bundle_sha256.slice(0, 64),
        expected_service_version: bundle.service_version,
        actual_service_version: identity.service_version.slice(0, 64),
        expected_executor_id: bundle.executor_id,
        actual_executor_id: identity.executor_id.slice(0, 64),
      },
    };
  }
  return null;
}

/**
 * The named decision for the separately read executor progress. Absence and a
 * non-fresh or non-terminal outcome are both `executor_progress_missing`; a
 * recorded failure is reported by its own name.
 */
export function hnsExecutorProgressRefusal(progress: HnsExecutorProgress | null): Readonly<{
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}> | null {
  if (progress === null) {
    return { reason: "executor_progress_missing", detail: { probe_outcome: "absent" } };
  }
  const progressRefusal = probeOutcomeRefusal(progress.probe_outcome, progress.probe_reason);
  if (progressRefusal !== null) {
    return {
      reason: progressRefusal,
      detail: {
        probe_outcome: progress.probe_outcome.slice(0, 64),
        probe_reason: progress.probe_reason === null ? null : progress.probe_reason.slice(0, 64),
      },
    };
  }
  if (
    !progress.probe_fresh ||
    (progress.probe_outcome !== "ready" && progress.probe_outcome !== "replayed")
  ) {
    return {
      reason: "executor_progress_missing",
      detail: { probe_outcome: progress.probe_outcome.slice(0, 64) },
    };
  }
  return null;
}

export function cutoverRefusalJson(refusal: HnsReadinessCutoverRefusal): string {
  return JSON.stringify(refusal);
}

export async function sha256File(path: string): Promise<string> {
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

/** Stages the reviewed bundle beside its deployment manifest. The in-place
 * cutover and the staging post-migration entry point share this step so the
 * service reads one manifest shape. */
export async function stageHnsReadinessCutoverBundle(input: {
  readonly bundle: HnsReadinessCutoverBundle;
  readonly stage_directory: string;
}): Promise<void> {
  await mkdir(input.stage_directory, { recursive: true });
  const target = join(input.stage_directory, "pirate-hns-authority-provisioner.mjs");
  await Bun.write(target, Bun.file(input.bundle.bundle_path));
  await writeFile(
    join(input.stage_directory, "deployment-manifest.json"),
    `${JSON.stringify(
      {
        bundle_sha256: input.bundle.bundle_sha256,
        service_version: input.bundle.service_version,
        job_envelope_version: input.bundle.job_envelope_version,
        executor_id: input.bundle.executor_id,
        attempt_id: input.bundle.attempt_id,
        staged_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/** Seeds or refreshes the synthetic controlled probe through the reviewed
 * service-side function. Shared by both cutover sequences. */
export async function seedHnsLifecycleCutoverProbe(): Promise<void> {
  await withClient(async (client) => {
    await client.query("SELECT api_next.seed_hns_lifecycle_readiness_cutover_probe_v1()");
  });
}

/** Reads the recorded compatible service/envelope pair as the named outcome.
 * An unavailable read reports `incompatible` rather than a refusal reason, so
 * the sequence decides. */
export async function readHnsLifecycleSchemaCompatibility(input: {
  readonly service_version: string;
  readonly job_envelope_version: string;
}): Promise<string> {
  return withClient(async (client) => {
    try {
      const result = await client.query<{ compatibility: string }>(
        "SELECT api_next.hns_lifecycle_schema_compatibility_v1($1,$2) AS compatibility",
        [input.service_version, input.job_envelope_version],
      );
      return result.rows[0]?.compatibility ?? "unavailable";
    } catch {
      return "incompatible";
    }
  });
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
    attempt_id: option("--attempt-id") ?? randomUUID(),
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
      stageBundle: stageHnsReadinessCutoverBundle,
      quiesceExecutor: () => runCommand(quiesceCommand.split(" "), "quiesce"),
      accountLiveLegacyLeases: () =>
        withClient(async (client) => {
          const result = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM api_next.hns_root_import_observation_jobs
              WHERE operation_kind = 'observe_root_v1'
                AND state = 'leased'
                AND lease_expires_at > clock_timestamp()`,
          );
          return Number(result.rows[0]?.count ?? "-1");
        }),
      applyPreflight: applyMigrationsBeforeRemoval,
      applyRemoval: applyRemovalMigration,
      seedExecutionProbe: seedHnsLifecycleCutoverProbe,
      startService: () => runCommand(startCommand.split(" "), "start"),
      readSchemaCompatibility: () =>
        readHnsLifecycleSchemaCompatibility({
          service_version: bundle.service_version,
          job_envelope_version: bundle.job_envelope_version,
        }),
      verifyRunningIdentity: () =>
        pollCutoverIdentity({
          attempt_id: bundle.attempt_id,
          read_identity: readCutoverIdentityRow,
        }),
      verifyExecutorProgress: async () => {
        const identity = await pollCutoverIdentity({
          attempt_id: bundle.attempt_id,
          read_identity: readCutoverIdentityRow,
        });
        if (identity === null) return null;
        return {
          probe_outcome: identity.probe_outcome,
          probe_reason: identity.probe_reason,
          probe_fresh: identity.probe_fresh,
        };
      },
    },
  });
  console.log(JSON.stringify({ outcome: "cutover_applied", steps }));
}

export type CutoverIdentityRow = Readonly<{
  readonly attempt_id: string | null;
  readonly bundle_sha256: string;
  readonly measured_bundle_sha256: string | null;
  readonly expected_bundle_sha256: string | null;
  readonly service_version: string;
  readonly executor_id: string;
  readonly probe_job_id: string | null;
  readonly lease_fence: string | null;
  readonly probe_outcome: string;
  readonly probe_reason: string | null;
  readonly probe_completed_at: Date | null;
  readonly probe_fresh: boolean;
}>;

export type CutoverIdentityPoll = Readonly<{
  readonly attempt_id: string;
  readonly read_identity: () => Promise<CutoverIdentityRow | undefined>;
  readonly timeout_ms?: number;
  readonly poll_interval_ms?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}>;

export async function readCutoverIdentityRow(): Promise<CutoverIdentityRow | undefined> {
  return withClient(async (client) => {
    const result = await client.query<CutoverIdentityRow>(
      `SELECT attempt_id, bundle_sha256, measured_bundle_sha256, expected_bundle_sha256,
              service_version, executor_id, probe_job_id, lease_fence, probe_outcome,
              probe_reason, probe_completed_at,
              probe_completed_at > clock_timestamp() - interval '120 seconds' AS probe_fresh
         FROM api_next.hns_lifecycle_service_identity
        WHERE service_name = 'pirate-hns-authority-provisioner'`,
    );
    return result.rows[0];
  });
}

/**
 * Polls for the identity row of this exact attempt. A row that belongs to the
 * requested attempt is conclusive and returns immediately, including an
 * explicit failed outcome, so a definite startup failure is reported at once
 * instead of waiting out the deadline. A previous attempt's row is stale
 * evidence: the poll keeps waiting for this attempt and surfaces the stale row
 * only at the bounded deadline so the caller can report `stale_attempt_result`.
 * Absence at the deadline reports null rather than hanging.
 */
export async function pollCutoverIdentity(
  input: CutoverIdentityPoll,
): Promise<HnsRunningIdentity | null> {
  const timeoutMs = input.timeout_ms ?? 120_000;
  const pollIntervalMs = input.poll_interval_ms ?? 1_000;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const deadline = now() + timeoutMs;
  let last: HnsRunningIdentity | null = null;
  for (;;) {
    const row = await input.read_identity();
    if (row !== undefined) {
      const identity: HnsRunningIdentity = {
        attempt_id: row.attempt_id ?? "",
        bundle_sha256: row.bundle_sha256,
        measured_bundle_sha256: row.measured_bundle_sha256 ?? "",
        expected_bundle_sha256: row.expected_bundle_sha256 ?? "",
        service_version: row.service_version,
        executor_id: row.executor_id,
        probe_job_id: row.probe_job_id === null ? null : Number(row.probe_job_id),
        lease_fence: row.lease_fence === null ? null : Number(row.lease_fence),
        probe_completed_at: row.probe_completed_at,
        probe_fresh: row.probe_fresh === true,
        probe_outcome: row.probe_outcome,
        probe_reason: row.probe_reason,
      };
      if (identity.attempt_id === input.attempt_id) return identity;
      last = identity;
    }
    if (now() >= deadline) return last;
    await sleep(pollIntervalMs);
  }
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
