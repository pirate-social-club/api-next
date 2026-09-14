import { resolve } from "node:path";

/** Runtime seam and provider operations for the reviewed rehearsal launch.
 * Every process, clock, filesystem and provider call goes through
 * `LaunchRuntime`, so the lifecycle plan is testable with local fakes. The
 * preparation commands here are the reviewed ones and are not otherwise
 * changed by the 2026-09-13 launcher correction. */

export const DATABASE = "pirate-staging";
export const BACKUP_ID = "xvvo8r6tcaa5";
export const DATA_SHA256 = "0b1c97ef5efa0d32eee31cf220e9d5a41f74c7cfecbe782c03f16caaf2628bf8";
export const APPROVED_RATE = "5";
export const SUPERVISOR = "scripts/staging-persona-rehearsal-supervisor.ts";
export const branchNamePattern = /^[a-z0-9][a-z0-9_-]{0,50}$/u;

export const REQUIRED_INJECTED_VARIABLES = [
  "CONTROL_PLANE_POSTGRES_ADMIN_URL",
  "CONTROL_PLANE_POSTGRES_RUNTIME_URL",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

export function missingInjectionVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_INJECTED_VARIABLES.filter((name) => !env[name]?.trim());
}

export function injectedCommand(args: readonly string[]): string[] {
  return [
    "infisical",
    "run",
    "--env=staging",
    "--path=/services/api-next",
    "--path=/services/api-next/operator",
    "--silent",
    "--",
    ...args,
  ];
}

export type CommandResult = {
  readonly failed: boolean;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
};

export type SupervisorResult = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  readonly treeAlive?: boolean;
};

export type FixtureOwnership =
  | { readonly kind: "started"; readonly id: string }
  | { readonly kind: "unresolved"; readonly name: string };

export type LaunchRuntime = {
  readonly run: (command: readonly string[], options?: CommandOptions) => CommandResult;
  readonly runInherit: (command: readonly string[], options?: CommandOptions) => CommandResult;
  readonly runSupervisor: (
    command: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly timeoutMs: number;
      readonly logPath: string;
    },
  ) => Promise<SupervisorResult>;
  readonly waitForGate: () => Promise<void>;
  readonly portInUse: (port: number) => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly mkdir: (path: string) => void;
  readonly writeFile: (path: string, contents: string, mode?: number) => void;
  readonly readFile: (path: string) => string;
  readonly removePath: (path: string) => void;
  readonly containerName: string;
  readonly containerPort: number;
  readonly stateRoot: string;
  readonly tmpDir: string;
  readonly root: string;
  readonly registerPendingCleanup?: (cleanup: () => void | Promise<void>) => void;
  /** Stops and joins the owned supervisor tree; false when it remains alive. */
  readonly terminateSupervisor?: () => Promise<boolean>;
};

export class LaunchRefusal extends Error {}

export const refusal = (code: string) => new LaunchRefusal(code);

const PROVIDER_TIMEOUT_MS = 90_000;
const POST_TIMEOUT_MS = 180_000;
const LOCAL_TIMEOUT_MS = 120_000;
const TYPECHECK_TIMEOUT_MS = 900_000;
const SUITES_TIMEOUT_MS = 2_400_000;
const LOOKUP_ATTEMPTS = 3;
const LOOKUP_DELAY_MS = 5_000;

export const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

export function assertCheckpoint(runtime: LaunchRuntime, expected: string | undefined): void {
  if (!expected || !/^[a-f0-9]{40}$/u.test(expected)) throw refusal("rehearsal_checkpoint_unbound");
  const head = runtime.run(["git", "rev-parse", "HEAD"], { timeoutMs: LOCAL_TIMEOUT_MS });
  if (head.failed || head.timedOut || head.stdout.trim() !== expected)
    throw refusal("rehearsal_checkpoint_moved");
  const status = runtime.run(["git", "status", "--porcelain"], { timeoutMs: LOCAL_TIMEOUT_MS });
  if (status.failed || status.timedOut || status.stdout.trim().length > 0)
    throw refusal("rehearsal_worktree_dirty");
  log(`checkpoint verified: ${head.stdout.trim()}`);
}

type Probe =
  | { readonly injection: "verified"; readonly variables: number }
  | { readonly injection: "missing"; readonly variables: readonly string[] };

export function probeInjection(runtime: LaunchRuntime): Probe {
  const result = runtime.run(
    injectedCommand(["bun", "scripts/staging-persona-rehearsal-launch.ts", "--probe-injection"]),
    { timeoutMs: LOCAL_TIMEOUT_MS },
  );
  if (result.timedOut) throw refusal("rehearsal_injection_unproven");
  const line = result.stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as Probe;
    if (parsed.injection === "verified" || parsed.injection === "missing") return parsed;
  } catch {
    // The injected child did not produce its own report.
  }
  throw refusal("rehearsal_injection_unproven");
}

export function requireInjection(runtime: LaunchRuntime): Probe {
  const probe = probeInjection(runtime);
  if (probe.injection === "missing")
    throw refusal(`rehearsal_injection_missing:${probe.variables.join(",")}`);
  log("injection verified before any provider mutation");
  return probe;
}

export function assertDiskHeadroom(runtime: LaunchRuntime): void {
  const available = (path: string) => {
    const result = runtime.run(["df", "-BG", "--output=avail", path], {
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    if (result.failed || result.timedOut) throw refusal("rehearsal_disk_headroom_unproven");
    return Number(result.stdout.trim().split("\n").pop()?.replace(/\D/gu, ""));
  };
  const root = available("/");
  const drive = available("/media/t42/codedrive");
  log(`disk root=${root}G codedrive=${drive}G`);
  if (!(root >= 50) || !(drive >= 50)) throw refusal("rehearsal_disk_headroom_insufficient");
}

export function readRate(runtime: LaunchRuntime): string {
  const result = runtime.run(
    ["pscale", "size", "cluster", "list", "--engine", "postgresql", "--format", "json"],
    { timeoutMs: PROVIDER_TIMEOUT_MS },
  );
  if (result.failed || result.timedOut) throw refusal("rehearsal_rate_unproven");
  const sizes = JSON.parse(result.stdout) as Array<{
    name?: string;
    configuration?: string;
    rate?: number;
  }>;
  const entry = sizes.find(
    (size) => size.name === "PS_5_AWS_ARM" && size.configuration === "single node",
  );
  return entry?.rate === undefined ? "" : String(entry.rate);
}

export function observeBackup(runtime: LaunchRuntime): void {
  const result = runtime.run(["bun", "scripts/staging-persona-provider-backup.ts", BACKUP_ID], {
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (result.failed || result.timedOut) throw refusal("staging_provider_backup_unproven");
  const backup = JSON.parse(result.stdout) as { backup_id?: string; source_branch_id?: string };
  if (backup.backup_id !== BACKUP_ID || backup.source_branch_id !== "syu03e00w3ux")
    throw refusal("staging_provider_backup_unproven");
  log("backup verified");
}

/** Only a named object is the created branch. An arbitrary nested `id` is not. */
export function branchIdFromResponse(text: string, branch: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const value = stack.pop();
      if (value === null || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (record.name === branch && typeof record.id === "string" && record.id.length > 0)
        return record.id;
      stack.push(...Object.values(record));
    }
  } catch {
    // A malformed response is an uncertain create, not an identity.
  }
  return undefined;
}

export type BranchLookup =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" };

export function lookupBranch(runtime: LaunchRuntime, branch: string): BranchLookup {
  const listed = runtime.run(["pscale", "branch", "list", DATABASE, "--format", "json"], {
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (listed.failed || listed.timedOut) return { kind: "unresolved" };
  try {
    const parsed = JSON.parse(listed.stdout) as Array<{ name?: string; id?: string }>;
    const found = parsed.find((entry) => entry.name === branch);
    if (found === undefined) return { kind: "absent" };
    return typeof found.id === "string" && found.id.length > 0
      ? { kind: "found", id: found.id }
      : { kind: "unresolved" };
  } catch {
    return { kind: "unresolved" };
  }
}

export async function lookupBranchBounded(
  runtime: LaunchRuntime,
  branch: string,
): Promise<BranchLookup> {
  let last: BranchLookup = { kind: "unresolved" };
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt += 1) {
    last = lookupBranch(runtime, branch);
    if (last.kind === "found") return last;
    if (attempt < LOOKUP_ATTEMPTS - 1) await runtime.sleep(LOOKUP_DELAY_MS);
  }
  return last;
}

function branchAbsentStructured(runtime: LaunchRuntime, branch: string): boolean {
  const readback = runtime.run(
    ["pscale", "api", `organizations/{org}/databases/${DATABASE}/branches/${branch}`],
    { timeoutMs: PROVIDER_TIMEOUT_MS },
  );
  if (!readback.failed && !readback.timedOut) return false;
  try {
    const parsed = JSON.parse(readback.stdout) as { code?: string };
    return parsed.code === "not_found";
  } catch {
    return false;
  }
}

export function branchDeletionConfirmed(runtime: LaunchRuntime, branch: string): boolean {
  return branchAbsentStructured(runtime, branch) && lookupBranch(runtime, branch).kind === "absent";
}

export type CreateOutcome =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "unacknowledged"; readonly id: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" };

export async function createBranch(runtime: LaunchRuntime, branch: string): Promise<CreateOutcome> {
  const bodyPath = resolve(runtime.tmpDir, `launch-${branch}.json`);
  runtime.writeFile(
    bodyPath,
    JSON.stringify({
      name: branch,
      backup_id: BACKUP_ID,
      cluster_size: "PS_5_AWS_ARM",
      replicas: 0,
      deletion_protected: false,
      storage: { minimum_storage_bytes: 21474836480, maximum_storage_bytes: 21474836480 },
    }),
  );
  const created = runtime.run(
    [
      "pscale",
      "api",
      `organizations/{org}/databases/${DATABASE}/branches`,
      "--method",
      "POST",
      "--input",
      bodyPath,
    ],
    { timeoutMs: POST_TIMEOUT_MS },
  );
  try {
    runtime.removePath(bodyPath);
  } catch {
    // A leftover local body file is not a provider resource.
  }
  if (!created.failed && !created.timedOut) {
    const id = branchIdFromResponse(created.stdout, branch);
    if (id !== undefined) return { kind: "created", id };
  }
  // The response was lost, failed or malformed: read back the exact attempted
  // target. Another create is never issued.
  const lookup = await lookupBranchBounded(runtime, branch);
  if (lookup.kind === "found") return { kind: "unacknowledged", id: lookup.id };
  return lookup.kind === "absent" ? { kind: "absent" } : { kind: "unresolved" };
}

export function refuseExistingBranch(runtime: LaunchRuntime, branch: string): void {
  const lookup = lookupBranch(runtime, branch);
  if (lookup.kind === "unresolved") throw refusal("rehearsal_branch_lookup_unproven");
  if (lookup.kind === "found") throw refusal("rehearsal_branch_name_in_use");
}

type ContainerLookup =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" };

function lookupContainer(runtime: LaunchRuntime, name: string): ContainerLookup {
  const result = runtime.run(
    ["docker", "ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.ID}}"],
    { timeoutMs: LOCAL_TIMEOUT_MS },
  );
  if (result.failed || result.timedOut) return { kind: "unresolved" };
  const id = result.stdout.trim().split("\n")[0]?.trim() ?? "";
  return id.length > 0 ? { kind: "found", id } : { kind: "absent" };
}

async function lookupContainerBounded(
  runtime: LaunchRuntime,
  name: string,
): Promise<ContainerLookup> {
  let last: ContainerLookup = { kind: "unresolved" };
  for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt += 1) {
    last = lookupContainer(runtime, name);
    if (last.kind === "found") return last;
    if (attempt < LOOKUP_ATTEMPTS - 1) await runtime.sleep(LOOKUP_DELAY_MS);
  }
  return last;
}

async function createFixture(runtime: LaunchRuntime): Promise<FixtureOwnership> {
  const name = runtime.containerName;
  const existing = lookupContainer(runtime, name);
  if (existing.kind === "unresolved") throw refusal("rehearsal_fixture_lookup_unproven");
  if (existing.kind === "found") throw refusal("rehearsal_fixture_name_in_use");
  if (await runtime.portInUse(runtime.containerPort))
    throw refusal("rehearsal_fixture_port_in_use");
  const started = runtime.run(
    [
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=postgres",
      "--cpus=1",
      "--memory=512m",
      "postgres:17",
      "-c",
      `port=${runtime.containerPort}`,
      "-c",
      "max_locks_per_transaction=1024",
      "-c",
      "fsync=off",
    ],
    { timeoutMs: POST_TIMEOUT_MS },
  );
  if (!started.failed && !started.timedOut) {
    const id = started.stdout.trim();
    if (id.length > 0) return { kind: "started", id };
  }
  // An uncertain create reads its own reserved name back. The name was proven
  // free immediately before the command, so a found container is this run's.
  const lookup = await lookupContainerBounded(runtime, name);
  if (lookup.kind === "found") return { kind: "started", id: lookup.id };
  if (lookup.kind === "unresolved" || started.timedOut) return { kind: "unresolved", name };
  throw refusal("rehearsal_fixture_start_failed");
}

async function waitForFixture(runtime: LaunchRuntime, containerId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = runtime.run(
      ["docker", "exec", containerId, "pg_isready", "-p", String(runtime.containerPort)],
      { timeoutMs: 15_000 },
    );
    if (!ready.failed && !ready.timedOut) return;
    await runtime.sleep(2_000);
  }
  throw refusal("rehearsal_fixture_not_ready");
}

export async function prepare(
  runtime: LaunchRuntime,
  onOwnership: (ownership: FixtureOwnership) => void,
): Promise<void> {
  await runtime.waitForGate();
  log("preparation: typecheck and PostgreSQL suites");
  const typecheck = runtime.runInherit(
    [
      resolve(runtime.root, "node_modules/.bin/tsc"),
      "--noEmit",
      "-p",
      "tsconfig.persona-executor.json",
    ],
    { timeoutMs: TYPECHECK_TIMEOUT_MS },
  );
  if (typecheck.failed || typecheck.timedOut) throw refusal("rehearsal_typecheck_failed");
  const ownership = await createFixture(runtime);
  // Ownership is handed over before readiness or suites can fail, so cleanup
  // never depends on those later steps returning.
  onOwnership(ownership);
  if (ownership.kind === "unresolved") throw refusal("rehearsal_fixture_identity_unresolved");
  const containerId = ownership.id;
  await waitForFixture(runtime, containerId);
  const pgUrl = `postgres://postgres:postgres@127.0.0.1:${runtime.containerPort}/postgres?sslmode=disable`;
  const suites = runtime.runInherit(
    [
      "bun",
      "test",
      "--timeout",
      "15000",
      "scripts/staging-persona-phased-reset.pg.test.ts",
      "scripts/staging-persona-prepare-reset.pg.test.ts",
    ],
    {
      timeoutMs: SUITES_TIMEOUT_MS,
      env: {
        ...process.env,
        TMPDIR: runtime.tmpDir,
        CONTROL_PLANE_POSTGRES_TEST_URL: pgUrl,
        CONTROL_PLANE_POSTGRES_TEST_REQUIRED: "1",
        CONTROL_PLANE_POSTGRES_BACKFILL_TEST_REQUIRED: "1",
        CONTROL_PLANE_POSTGRES_RECOVERY_TEST_CONTAINER: containerId,
      },
    },
  );
  if (suites.failed || suites.timedOut) throw refusal("rehearsal_preparation_suites_failed");
  log("preparation suites passed");
}

export async function waitForBranch(
  runtime: LaunchRuntime,
  branch: string,
  deadlineMs: number,
): Promise<void> {
  const started = runtime.now();
  for (;;) {
    const state = runtime.run(["pscale", "branch", "show", DATABASE, branch, "--format", "json"], {
      timeoutMs: PROVIDER_TIMEOUT_MS,
    });
    if (!state.failed && !state.timedOut) {
      try {
        if ((JSON.parse(state.stdout) as { ready?: boolean }).ready === true) return;
      } catch {
        // A malformed readiness read is retried inside the deadline.
      }
    }
    if (runtime.now() - started >= deadlineMs) throw refusal("rehearsal_branch_not_ready");
    await runtime.sleep(5_000);
  }
}

export function deleteBranchOwned(runtime: LaunchRuntime, branch: string): boolean {
  runtime.run(["pscale", "branch", "delete", DATABASE, branch, "--force"], {
    timeoutMs: POST_TIMEOUT_MS,
  });
  return branchDeletionConfirmed(runtime, branch);
}
