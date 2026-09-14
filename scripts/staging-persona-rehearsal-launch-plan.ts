import { resolve } from "node:path";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure";
import {
  APPROVED_RATE,
  assertCheckpoint,
  assertDiskHeadroom,
  BACKUP_ID,
  type BranchLookup,
  createBranch,
  DATA_SHA256,
  DATABASE,
  deleteBranchOwned,
  type FixtureOwnership,
  injectedCommand,
  LaunchRefusal,
  type LaunchRuntime,
  log,
  lookupBranchBounded,
  observeBackup,
  prepare,
  readRate,
  refusal,
  refuseExistingBranch,
  requireInjection,
  SUPERVISOR,
  waitForBranch,
} from "./staging-persona-rehearsal-launch-runtime";

/** Lifecycle plan for one bounded provider rehearsal. All process, clock,
 * filesystem and provider calls arrive through `LaunchRuntime`, so every
 * failure path is testable with local fakes. This closes the three boundaries
 * the 2026-09-13 follow-up review found: fixture ownership is captured before
 * readiness and suites can fail, watchdog deadlines survive every state
 * revision, and an owned process tree is stopped and joined before provider
 * cleanup.
 */

const HOUR_MS = 60 * 60_000;
const SUPERVISOR_DEADLINE_MS = 135 * 60_000;
const READINESS_DEADLINE_MS = 8 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;

export type LaunchOptions = {
  readonly checkpoint: string;
  readonly branch: string;
  /** `execute` runs the destructive rehearsal. `dry-run` stops at the
   * read-only provider admission, which is the bounded recovery check: the
   * restored branch is verified and deleted, and no reconstruction, upgrade,
   * grant removal, marker or live target is reachable. */
  readonly supervisorMode?: "execute" | "dry-run";
  /** Owner-authorized diagnostic only: the child captures the raw failure
   * chain owner-only and refuses the first destructive statement so a clean
   * window stays diagnostic. */
  readonly diagnostic?: boolean;
  readonly supervisorDeadlineMs?: number;
  readonly readinessDeadlineMs?: number;
};

export type LaunchOutcome = {
  readonly branch: string;
  readonly branch_id: string | null;
  readonly completed: boolean;
  readonly cleanup: {
    readonly branch: "deleted" | "confirmed_absent" | "unresolved" | "not_created";
    readonly container: "removed" | "not_started" | "unresolved";
    readonly secret: "removed" | "not_written" | "unresolved";
  };
  readonly failures: readonly string[];
  readonly evidence: string | null;
};

type CleanupState = {
  branch: "deleted" | "confirmed_absent" | "unresolved" | "not_created";
  container: "removed" | "not_started" | "unresolved";
  secret: "removed" | "not_written" | "unresolved";
};

type Journal = {
  branch: string;
  checkpoint: string;
  mode?: string;
  diagnostic?: boolean;
  intent_at?: number;
  delete_by?: number;
  ready_at?: number;
  run_deadline_at?: number;
  run_ended_at?: number;
  cleanup_deadline?: number;
  branch_id?: string | null;
  evidence?: string | null;
  state?: string;
  cleanup?: CleanupState;
  failures?: readonly string[];
};

export async function verifyLaunch(runtime: LaunchRuntime, checkpoint: string | undefined) {
  assertCheckpoint(runtime, checkpoint);
  const probe = requireInjection(runtime);
  assertDiskHeadroom(runtime);
  const rate = readRate(runtime);
  if (rate !== APPROVED_RATE) throw refusal("rehearsal_rate_changed");
  observeBackup(runtime);
  console.log(
    JSON.stringify({
      verify: "ready",
      checkpoint,
      rate,
      injection: probe.injection,
      backup: BACKUP_ID,
    }),
  );
}

export async function executeLaunch(
  runtime: LaunchRuntime,
  options: LaunchOptions,
): Promise<LaunchOutcome> {
  const failures: string[] = [];
  const cleanup: CleanupState = {
    branch: "not_created",
    container: "not_started",
    secret: "not_written",
  };
  const supervisorMode = options.supervisorMode ?? "execute";
  // The diagnostic mode is a property of this launch, never of the ambient
  // environment: dry-run never captures, and the child boundary receives an
  // explicit value so an inherited variable cannot enable it.
  const diagnostic = supervisorMode === "execute" && options.diagnostic === true;
  const stateDir = resolve(runtime.stateRoot, options.branch);
  const statePath = resolve(stateDir, "launch-state.json");
  const secretPath = resolve(runtime.tmpDir, `default-role-${options.branch}.json`);
  const journal: Journal = {
    branch: options.branch,
    checkpoint: options.checkpoint,
    mode: supervisorMode,
    diagnostic,
  };
  const writeState = () => {
    if (journal.delete_by !== undefined)
      journal.cleanup_deadline = Math.min(
        journal.delete_by,
        (journal.run_ended_at ?? journal.delete_by) + HOUR_MS,
      );
    else if (journal.run_ended_at !== undefined)
      journal.cleanup_deadline = journal.run_ended_at + HOUR_MS;
    runtime.writeFile(
      statePath,
      JSON.stringify({ ...journal, updated_at: runtime.now() }, null, 2),
    );
  };
  let evidence: string | null = null;
  let branchId: string | null = null;
  let containerId: string | null = null;
  let containerUnresolved = false;
  let createAttempted = false;
  let secretWritten = false;
  let skipProviderCleanup = false;
  let completed = false;

  const ownership = (fixture: FixtureOwnership) => {
    if (fixture.kind === "started") containerId = fixture.id;
    else containerUnresolved = true;
    runtime.registerPendingCleanup?.(async () => {
      if (!(await (runtime.terminateSupervisor?.() ?? true))) return;
      if (containerId !== null)
        runtime.run(["docker", "rm", "-f", "-v", containerId], { timeoutMs: CLEANUP_TIMEOUT_MS });
      if (branchId !== null)
        runtime.run(["pscale", "branch", "delete", DATABASE, options.branch, "--force"], {
          timeoutMs: CLEANUP_TIMEOUT_MS,
        });
    });
  };

  try {
    assertCheckpoint(runtime, options.checkpoint);
    requireInjection(runtime);
    await prepare(runtime, ownership);
    assertCheckpoint(runtime, options.checkpoint);

    assertDiskHeadroom(runtime);
    const rate = readRate(runtime);
    if (rate !== APPROVED_RATE) throw refusal("rehearsal_rate_changed");
    log(`provider rate verified: ${rate} per month`);
    observeBackup(runtime);
    refuseExistingBranch(runtime, options.branch);

    const intentAt = runtime.now();
    runtime.mkdir(stateDir);
    createAttempted = true;
    journal.intent_at = intentAt;
    journal.delete_by = intentAt + 24 * HOUR_MS;
    journal.state = "creating";
    journal.evidence = evidence;
    writeState();

    const created = await createBranch(runtime, options.branch);
    if (created.kind !== "created" && created.kind !== "unacknowledged") {
      throw refusal(
        created.kind === "absent"
          ? "rehearsal_branch_create_unconfirmed"
          : "rehearsal_branch_create_uncertain",
      );
    }
    branchId = created.id;
    evidence = resolve(runtime.stateRoot, branchId, "evidence");
    journal.branch_id = branchId;
    journal.evidence = evidence;
    runtime.mkdir(evidence);
    if (created.kind === "unacknowledged")
      throw refusal("rehearsal_branch_response_unacknowledged");
    log(`branch created id=${branchId}`);

    await waitForBranch(
      runtime,
      options.branch,
      options.readinessDeadlineMs ?? READINESS_DEADLINE_MS,
    );
    journal.ready_at = runtime.now();
    journal.run_deadline_at = journal.ready_at + 6 * HOUR_MS;
    journal.state = "ready";
    writeState();
    log("branch ready");

    const reset = runtime.run(
      ["pscale", "role", "reset-default", DATABASE, options.branch, "--force", "--format", "json"],
      { timeoutMs: CLEANUP_TIMEOUT_MS },
    );
    if (reset.failed || reset.timedOut) throw refusal("rehearsal_access_binding_failed");
    runtime.writeFile(secretPath, reset.stdout, 0o600);
    secretWritten = true;

    const binding = runtime.run(
      [
        "pscale",
        "api",
        `organizations/{org}/databases/${DATABASE}/branches/${options.branch}/roles/default`,
      ],
      { timeoutMs: CLEANUP_TIMEOUT_MS },
    );
    if (binding.failed || binding.timedOut) throw refusal("rehearsal_access_binding_unproven");
    const access = JSON.parse(binding.stdout) as { default?: boolean; access_host_url?: string };
    if (access.default !== true || !access.access_host_url)
      throw refusal("rehearsal_access_binding_unproven");
    log("access binding verified");

    const defaultUrl = (() => {
      const stack: unknown[] = [JSON.parse(runtime.readFile(secretPath))];
      while (stack.length > 0) {
        const value = stack.pop();
        if (typeof value === "string" && /^postgres(ql)?:\/\//u.test(value)) return value;
        if (value !== null && typeof value === "object")
          stack.push(...Object.values(value as Record<string, unknown>));
      }
      return undefined;
    })();
    if (!defaultUrl) throw refusal("rehearsal_default_credential_unproven");
    const regrant = runtime.runInherit(
      injectedCommand(["bun", "scripts/staging-persona-rehearsal-launch.ts", "--regrant"]),
      {
        timeoutMs: CLEANUP_TIMEOUT_MS,
        env: {
          ...process.env,
          DEFAULT_DATABASE_URL: defaultUrl,
          ACCESS_HOST: access.access_host_url,
          STAGING_REHEARSAL_BRANCH_ID: branchId,
        },
      },
    );
    if (regrant.failed || regrant.timedOut) throw refusal("rehearsal_regrant_failed");
    log("visibility re-grant verified");

    assertCheckpoint(runtime, options.checkpoint);
    log("starting the single supervised rehearsal");
    const fixtureId = containerId;
    if (fixtureId === null) throw refusal("rehearsal_fixture_id_unproven");
    const executionLog = resolve(evidence, `execution-${options.branch}.log`);
    const supervisor = await runtime.runSupervisor(
      injectedCommand([
        "bun",
        SUPERVISOR,
        supervisorMode === "dry-run" ? "--dry-run" : "--execute",
        diagnostic ? "--diagnostic" : "--no-diagnostic",
      ]),
      {
        env: {
          ...process.env,
          TMPDIR: runtime.tmpDir,
          STAGING_REHEARSAL_BRANCH_ID: branchId,
          STAGING_REHEARSAL_BRANCH_NAME: options.branch,
          STAGING_REHEARSAL_BACKUP_ID: BACKUP_ID,
          STAGING_REHEARSAL_DATA_SHA256: DATA_SHA256,
          // Explicit in both directions so an inherited value is overridden,
          // and the journal and the child can never disagree.
          STAGING_REHEARSAL_DIAGNOSTIC: diagnostic ? "1" : "0",
          CONTROL_PLANE_POSTGRES_TEST_URL: `postgres://postgres:postgres@127.0.0.1:${runtime.containerPort}/postgres?sslmode=disable`,
          CONTROL_PLANE_POSTGRES_RECOVERY_TEST_CONTAINER: fixtureId,
        },
        timeoutMs: options.supervisorDeadlineMs ?? SUPERVISOR_DEADLINE_MS,
        logPath: executionLog,
      },
    );
    journal.run_ended_at = runtime.now();
    writeState();
    if (supervisor.treeAlive === true) {
      skipProviderCleanup = true;
      throw refusal("rehearsal_supervisor_tree_alive");
    }
    if (supervisor.spawnFailed) throw refusal("rehearsal_supervisor_spawn_failed");
    if (supervisor.timedOut) throw refusal("rehearsal_supervisor_deadline_exceeded");
    const execution = (() => {
      try {
        return runtime.readFile(executionLog);
      } catch {
        return "";
      }
    })();
    completed =
      supervisor.exitCode === 0 && execution.includes('"event":"staging_rehearsal_completed"');
    if (!completed) throw refusal("rehearsal_supervisor_unproven");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    failures.push(
      error instanceof LaunchRefusal
        ? message
        : (describeRehearsalFailure(error).reason ?? "launch_refusal_unproven"),
    );
  }

  if (journal.run_ended_at === undefined) journal.run_ended_at = runtime.now();
  if (!(await (runtime.terminateSupervisor?.() ?? true))) skipProviderCleanup = true;

  if (skipProviderCleanup) {
    if (containerId !== null || containerUnresolved) {
      cleanup.container = "unresolved";
      failures.push("rehearsal_container_not_stopped");
    }
    if (createAttempted) {
      cleanup.branch = "unresolved";
      failures.push("rehearsal_branch_not_deleted_while_running");
    }
  } else {
    if (containerId !== null) {
      try {
        const removed = runtime.run(["docker", "rm", "-f", "-v", containerId], {
          timeoutMs: CLEANUP_TIMEOUT_MS,
        });
        if (removed.failed || removed.timedOut) throw new Error("container");
        cleanup.container = "removed";
      } catch {
        cleanup.container = "unresolved";
        failures.push("rehearsal_container_cleanup_failed");
      }
    } else if (containerUnresolved) {
      cleanup.container = "unresolved";
      failures.push("rehearsal_container_identity_unresolved");
    }
    if (createAttempted) {
      const target: BranchLookup =
        branchId !== null
          ? { kind: "found", id: branchId }
          : await lookupBranchBounded(runtime, options.branch);
      if (target.kind === "found") {
        branchId = target.id;
        if (deleteBranchOwned(runtime, options.branch)) cleanup.branch = "deleted";
        else {
          cleanup.branch = "unresolved";
          failures.push("rehearsal_branch_deletion_unconfirmed");
        }
      } else if (target.kind === "absent") {
        cleanup.branch = "confirmed_absent";
      } else {
        cleanup.branch = "unresolved";
        failures.push("rehearsal_branch_identity_unresolved");
      }
    }
  }
  if (secretWritten) {
    try {
      runtime.removePath(secretPath);
      cleanup.secret = "removed";
    } catch {
      cleanup.secret = "unresolved";
      failures.push("rehearsal_secret_cleanup_failed");
    }
  }
  journal.state = failures.length === 0 ? "cleaned" : "unresolved";
  journal.cleanup = cleanup;
  journal.failures = failures;
  try {
    writeState();
  } catch {
    failures.push("rehearsal_state_write_failed");
  }
  if (failures.length > 0) completed = false;

  return { branch: options.branch, branch_id: branchId, completed, cleanup, failures, evidence };
}
