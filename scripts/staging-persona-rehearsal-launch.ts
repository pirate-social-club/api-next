import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure";
import { executeLaunch, verifyLaunch } from "./staging-persona-rehearsal-launch-plan";
import {
  branchNamePattern,
  type CommandOptions,
  type CommandResult,
  LaunchRefusal,
  type LaunchRuntime,
  missingInjectionVariables,
  probeInjection,
  REQUIRED_INJECTED_VARIABLES,
  refusal,
  type SupervisorResult,
} from "./staging-persona-rehearsal-launch-runtime";

/** CLI for the one reviewed launch path. The lifecycle lives in
 * staging-persona-rehearsal-launch-plan.ts behind a runtime seam so every
 * failure path is testable locally; this file wires the real processes. */

export {
  branchNamePattern,
  injectedCommand,
  missingInjectionVariables,
} from "./staging-persona-rehearsal-launch-runtime";

const ROOT = resolve(import.meta.dir, "..");
const STATE_ROOT = resolve(ROOT, "../../../.state/staging-reset-rehearsal");
const TMPDIR = "/media/t42/codedrive/tmp-reset-lane";
const CONTAINER_PORT = 5433;

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

let pendingCleanup: (() => void | Promise<void>) | null = null;
let shutdownStarted = false;

async function shutdown(code: number) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    await pendingCleanup?.();
  } catch {
    // Best-effort shutdown; the watchdog deadlines still stand.
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (inUse: boolean) => {
      socket.destroy();
      done(inUse);
    };
    socket.setTimeout(1_500, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

type ActiveSupervisor = {
  readonly child: ReturnType<typeof spawn>;
  readonly groupId: number | null;
};
let activeSupervisor: ActiveSupervisor | null = null;

function supervisorGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch {
    return false;
  }
}

function killSupervisorGroup(): void {
  const active = activeSupervisor;
  if (active === null) return;
  if (active.groupId !== null) {
    try {
      process.kill(-active.groupId, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct child when the group is already gone.
    }
  }
  try {
    active.child.kill("SIGKILL");
  } catch {
    // The child is already gone.
  }
}

export function createSystemRuntime(containerName: string): LaunchRuntime {
  const executableOf = (command: readonly string[]): string => {
    const [executable] = command;
    if (executable === undefined) throw new Error("launch_command_executable_missing");
    return executable;
  };
  const run = (command: readonly string[], options: CommandOptions = {}): CommandResult => {
    const result = spawnSync(executableOf(command), command.slice(1), {
      cwd: ROOT,
      env: options.env ?? { ...process.env, TMPDIR },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    const timedOut =
      result.error !== undefined &&
      result.error !== null &&
      "code" in result.error &&
      result.error.code === "ETIMEDOUT";
    return {
      failed: result.status !== 0,
      timedOut,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  return {
    run,
    runInherit: (command, options = {}) => {
      const result = spawnSync(executableOf(command), command.slice(1), {
        cwd: ROOT,
        env: options.env ?? { ...process.env, TMPDIR },
        stdio: "inherit",
        killSignal: "SIGKILL",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
      const timedOut =
        result.error !== undefined &&
        result.error !== null &&
        "code" in result.error &&
        result.error.code === "ETIMEDOUT";
      return { failed: result.status !== 0, timedOut, stdout: "", stderr: "" };
    },
    runSupervisor: (command, options) =>
      new Promise<SupervisorResult>((done) => {
        const descriptor = openSync(options.logPath, "a");
        let settled = false;
        let timedOut = false;
        const child = spawn(executableOf(command), command.slice(1), {
          cwd: ROOT,
          env: options.env,
          stdio: ["ignore", descriptor, descriptor],
          detached: true,
        });
        const groupId = child.pid ?? null;
        activeSupervisor = { child, groupId };
        const finish = async (result: SupervisorResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          let alive = false;
          if (groupId !== null) {
            for (let attempt = 0; attempt < 100 && supervisorGroupAlive(groupId); attempt += 1)
              await sleep(100);
            alive = supervisorGroupAlive(groupId);
          }
          activeSupervisor = null;
          closeSync(descriptor);
          done(alive ? { ...result, treeAlive: true } : result);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killSupervisorGroup();
          void finish({ exitCode: null, timedOut: true, spawnFailed: false });
        }, options.timeoutMs);
        child.on(
          "error",
          () => void finish({ exitCode: null, timedOut: false, spawnFailed: true }),
        );
        child.on("exit", (code) => {
          if (timedOut) return;
          void finish({ exitCode: code, timedOut: false, spawnFailed: false });
        });
      }),
    terminateSupervisor: async () => {
      const active = activeSupervisor;
      if (active === null) return true;
      killSupervisorGroup();
      const deadline = Date.now() + 10_000;
      while (
        active.groupId !== null &&
        supervisorGroupAlive(active.groupId) &&
        Date.now() < deadline
      )
        await sleep(100);
      const gone = active.groupId === null || !supervisorGroupAlive(active.groupId);
      if (gone) activeSupervisor = null;
      return gone;
    },
    waitForGate: async () => {
      let ticks = 0;
      for (;;) {
        const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
        const free = run(["free", "-m"]);
        const available = Number(free.stdout.split("\n")[1]?.trim().split(/\s+/u)[6]);
        if (load < 8 && available >= 3072) break;
        ticks += 1;
        if (ticks % 10 === 0) log(`gate closed: load1=${load} avail=${available}MiB`);
        await sleep(60_000);
      }
      await sleep(60_000);
      for (;;) {
        const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
        const free = run(["free", "-m"]);
        const available = Number(free.stdout.split("\n")[1]?.trim().split(/\s+/u)[6]);
        if (load < 8 && available >= 3072) return;
        await sleep(60_000);
      }
    },
    portInUse,
    now: () => Date.now(),
    sleep,
    // Owner-only state directories. The reset marker boundary refuses any
    // marker directory with group or other bits (`reset_marker_directory_untrusted`),
    // so the launcher must not pre-create the branch state or evidence
    // directory under a group-readable umask. The r12 attempt failed exactly
    // there: the marker module never got to create its own 0700 directory
    // because the launcher had already created it 0775.
    mkdir: (path) => void mkdirSync(path, { recursive: true, mode: 0o700 }),
    writeFile: (path, contents, mode) => {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp-${process.pid}`;
      const descriptor = openSync(temporary, "w", mode ?? 0o644);
      try {
        writeSync(descriptor, contents);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, path);
      try {
        const directoryDescriptor = openSync(directory, "r");
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch {
        // Directory fsync is not available on every filesystem.
      }
    },
    readFile: (path) => readFileSync(path, "utf8"),
    removePath: (path) => rmSync(path, { force: true }),
    containerName,
    containerPort: CONTAINER_PORT,
    stateRoot: STATE_ROOT,
    tmpDir: TMPDIR,
    root: ROOT,
    registerPendingCleanup: (cleanup) => {
      pendingCleanup = cleanup;
    },
  };
}

async function regrant() {
  const adminUrl = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  const defaultUrl = process.env.DEFAULT_DATABASE_URL;
  const host = process.env.ACCESS_HOST;
  const branchId = process.env.STAGING_REHEARSAL_BRANCH_ID;
  if (!adminUrl || !defaultUrl || !host || !branchId) throw refusal("regrant_inputs_unbound");
  const admin = new URL(adminUrl);
  const login = decodeURIComponent(admin.username);
  const operatorRole = login.replace(/\.syu03e00w3ux$/u, "");
  if (operatorRole === login || operatorRole.length === 0) throw refusal("regrant_role_unbound");

  const superuser = new Client({ connectionString: defaultUrl, connectionTimeoutMillis: 10_000 });
  await superuser.connect();
  try {
    await superuser.query(`GRANT pg_read_all_stats TO "${operatorRole}"`);
  } finally {
    await superuser.end().catch(() => undefined);
  }

  const operator = new URL(adminUrl);
  operator.username = `${operatorRole}.${branchId}`;
  operator.hostname = host;
  const client = new Client({
    connectionString: operator.toString(),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const visible = (
      await client.query(
        "SELECT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.pg_has_role(current_user,'pg_read_all_stats','USAGE') AS visible",
      )
    ).rows[0];
    if (visible.visible !== true) throw refusal("regrant_visibility_unproven");
    const sessions = (await client.query("SELECT count(*)::int AS n FROM pg_stat_activity"))
      .rows[0];
    console.log(
      JSON.stringify({ grant: { role: operatorRole, visible: true, sessions: sessions.n } }),
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

const argv = Bun.argv.slice(2);
const mode = argv[0];
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (import.meta.main) {
  try {
    if (mode === "--probe-injection") {
      const missing = missingInjectionVariables();
      if (missing.length > 0) {
        console.log(JSON.stringify({ injection: "missing", variables: missing }));
        process.exitCode = 2;
      } else {
        console.log(
          JSON.stringify({ injection: "verified", variables: REQUIRED_INJECTED_VARIABLES.length }),
        );
      }
    } else if (mode === "--check-injection") {
      const runtime = createSystemRuntime("reset-lane-pg17-check");
      const probe = probeInjection(runtime);
      console.log(JSON.stringify(probe));
      if (probe.injection === "missing") process.exitCode = 2;
    } else if (mode === "--regrant") {
      await regrant();
    } else if (mode === "--verify") {
      const runtime = createSystemRuntime("reset-lane-pg17-verify");
      await verifyLaunch(runtime, flag("--checkpoint"));
    } else if (mode === "--execute" || mode === "--restore-check") {
      const branch = flag("--branch") ?? "";
      if (!branchNamePattern.test(branch)) throw refusal("rehearsal_branch_name_invalid");
      const runtime = createSystemRuntime(`reset-lane-pg17-${branch}`);
      const outcome = await executeLaunch(runtime, {
        checkpoint: flag("--checkpoint") ?? "",
        branch,
        supervisorMode: mode === "--restore-check" ? "dry-run" : "execute",
        diagnostic: mode === "--execute" && argv.includes("--diagnostic"),
      });
      console.log(
        JSON.stringify({
          mode: mode === "--restore-check" ? "restore-check" : "rehearsal",
          launch: outcome.completed ? "completed" : "unproven",
          ...outcome,
        }),
      );
      if (!outcome.completed) process.exitCode = 1;
    } else {
      console.error(
        "usage: bun scripts/staging-persona-rehearsal-launch.ts --probe-injection | --check-injection | --verify --checkpoint <sha> | --execute --checkpoint <sha> --branch <name> [--diagnostic] | --restore-check --checkpoint <sha> --branch <name>",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof LaunchRefusal)
      console.error(JSON.stringify({ launch: "failed", problem: error.message }));
    else console.error(JSON.stringify({ launch: "failed", ...describeRehearsalFailure(error) }));
    process.exitCode = 1;
  }
}
