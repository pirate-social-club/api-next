import { expect, test } from "bun:test";
import { executeLaunch } from "./staging-persona-rehearsal-launch-plan";
import {
  branchIdFromResponse,
  type CommandResult,
  type LaunchRuntime,
  type SupervisorResult,
} from "./staging-persona-rehearsal-launch-runtime";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const BRANCH = "persona-reset-rehearsal-20260913-r11";
const ID = "2s0xprobeid";
const SECRET_URL = "postgres://hidden-credential";

const ok = (stdout = ""): CommandResult => ({ failed: false, timedOut: false, stdout, stderr: "" });
const fail = (stdout = "", stderr = ""): CommandResult => ({
  failed: true,
  timedOut: false,
  stdout,
  stderr,
});

type FakeOptions = {
  readonly gitHeads?: readonly string[];
  readonly gitStatus?: string;
  readonly probe?: string;
  readonly branchLists?: ReadonlyArray<ReadonlyArray<{ name: string; id: string }>>;
  readonly post?: CommandResult;
  readonly shows?: readonly CommandResult[];
  readonly deleteReadback?: CommandResult;
  readonly dockerPs?: string;
  readonly dockerLookups?: readonly string[];
  readonly dockerRun?: CommandResult;
  readonly portInUse?: boolean;
  readonly containerRemove?: CommandResult;
  readonly removePathFails?: boolean;
  readonly supervisor?: SupervisorResult;
  readonly supervisorLog?: string;
  readonly typecheckFails?: boolean;
  readonly suitesFail?: boolean;
};

function fakeRuntime(options: FakeOptions = {}) {
  const runs: string[][] = [];
  const events: string[] = [];
  const files = new Map<string, string>();
  const supervisorEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
  let gitHead = 0;
  let list = 0;
  let show = 0;
  let dockerLookup = 0;

  const runtime: LaunchRuntime = {
    run: (command) => {
      runs.push([...command]);
      events.push(`run:${command.join(" ")}`);
      const joined = command.join(" ");
      if (command[0] === "git" && command[1] === "rev-parse") {
        const heads = options.gitHeads ?? [HEAD];
        const value = heads[Math.min(gitHead, heads.length - 1)] ?? HEAD;
        gitHead += 1;
        return ok(`${value}\n`);
      }
      if (command[0] === "git" && command[1] === "status") return ok(options.gitStatus ?? "");
      if (command[0] === "infisical")
        return ok(`${options.probe ?? '{"injection":"verified","variables":4}'}\n`);
      if (command[0] === "df") return ok("133G\n");
      if (joined.includes("size cluster list"))
        return ok(
          JSON.stringify([{ name: "PS_5_AWS_ARM", configuration: "single node", rate: 5 }]),
        );
      if (joined.includes("staging-persona-provider-backup"))
        return ok(JSON.stringify({ backup_id: "xvvo8r6tcaa5", source_branch_id: "syu03e00w3ux" }));
      if (command[0] === "pscale" && command[1] === "branch" && command[2] === "list") {
        const lists = options.branchLists ?? [[]];
        const value = lists[Math.min(list, lists.length - 1)] ?? [];
        list += 1;
        return ok(JSON.stringify(value));
      }
      if (command[0] === "pscale" && command[1] === "branch" && command[2] === "show") {
        const shows = options.shows ?? [ok('{"ready":true}')];
        const value = shows[Math.min(show, shows.length - 1)] ?? ok('{"ready":true}');
        show += 1;
        return value;
      }
      if (command[0] === "pscale" && command[1] === "branch" && command[2] === "delete")
        return ok();
      if (command[0] === "pscale" && command[1] === "role")
        return ok(JSON.stringify({ database_url: SECRET_URL }));
      if (command[0] === "pscale" && command[1] === "api") {
        if (command.includes("POST"))
          return options.post ?? ok(JSON.stringify({ name: BRANCH, id: ID }));
        if (joined.includes("/roles/default"))
          return ok(JSON.stringify({ default: true, access_host_url: "fake.host" }));
        return options.deleteReadback ?? fail('{"code":"not_found"}');
      }
      if (command[0] === "docker" && command[1] === "ps") {
        if (options.dockerLookups) {
          const value =
            options.dockerLookups[Math.min(dockerLookup, options.dockerLookups.length - 1)] ?? "";
          dockerLookup += 1;
          return ok(value === "" ? "" : `${value}\n`);
        }
        return ok(options.dockerPs ?? "");
      }
      if (command[0] === "docker" && command[1] === "run")
        return options.dockerRun ?? ok("container-id-1\n");
      if (command[0] === "docker" && command[1] === "exec") return ok();
      if (command[0] === "docker" && command[1] === "rm") return options.containerRemove ?? ok();
      return ok();
    },
    runInherit: (command) => {
      runs.push([...command]);
      events.push(`runInherit:${command.join(" ")}`);
      if (command[0]?.endsWith("tsc")) return options.typecheckFails === true ? fail() : ok();
      if (command[0] === "bun" && command[1] === "test")
        return options.suitesFail === true ? fail() : ok();
      return ok();
    },
    runSupervisor: async (command, supervisorOptions) => {
      runs.push([...command]);
      supervisorEnvs.push(supervisorOptions.env ?? {});
      events.push(`supervisor:${command.join(" ")}`);
      files.set(
        supervisorOptions.logPath,
        options.supervisorLog ?? '{"event":"staging_rehearsal_completed","mode":"execute"}\n',
      );
      return options.supervisor ?? { exitCode: 0, timedOut: false, spawnFailed: false };
    },
    waitForGate: async () => {},
    portInUse: async () => options.portInUse ?? false,
    now: () => 1_000_000_000,
    sleep: async () => {},
    mkdir: () => {},
    writeFile: (path, contents) => {
      files.set(path, contents);
      events.push(`write:${path}`);
    },
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing file");
      return value;
    },
    removePath: (path) => {
      if (options.removePathFails) throw new Error("remove failed");
      files.delete(path);
    },
    containerName: `reset-lane-pg17-${BRANCH}`,
    containerPort: 5433,
    stateRoot: "/state",
    tmpDir: "/tmp/scratch",
    root: "/repo",
  };
  return { runtime, runs, events, files, supervisorEnvs };
}

const postsIn = (events: readonly string[]) =>
  events.filter((event) => event.startsWith("run:pscale api") && event.includes("POST"));

test("only a named object is the created branch identity", () => {
  expect(branchIdFromResponse(`{"id":"nested"}`, BRANCH)).toBeUndefined();
  expect(branchIdFromResponse(`{"data":[{"name":"${BRANCH}","id":"${ID}"}]}`, BRANCH)).toBe(ID);
  expect(branchIdFromResponse("not json", BRANCH)).toBeUndefined();
});

test("missing injection causes no provider mutation and no container deletion", async () => {
  const fake = fakeRuntime({
    probe: JSON.stringify({
      injection: "missing",
      variables: ["CONTROL_PLANE_POSTGRES_ADMIN_URL"],
    }),
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.completed).toBe(false);
  expect(outcome.failures).toContain(
    "rehearsal_injection_missing:CONTROL_PLANE_POSTGRES_ADMIN_URL",
  );
  expect(postsIn(fake.events)).toHaveLength(0);
  expect(fake.events.some((event) => event.startsWith("run:docker"))).toBe(false);
  expect(outcome.cleanup.container).toBe("not_started");
  expect(outcome.cleanup.branch).toBe("not_created");
});

test("an unacknowledged create reads back the target, deletes it and never POSTs twice", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD],
    branchLists: [[], [{ name: BRANCH, id: ID }], []],
    post: ok("{}"),
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(postsIn(fake.events)).toHaveLength(1);
  expect(outcome.failures).toContain("rehearsal_branch_response_unacknowledged");
  expect(outcome.completed).toBe(false);
  expect(outcome.cleanup.branch).toBe("deleted");
  const intent = fake.events.findIndex((event) => event.includes("launch-state.json"));
  const post = fake.events.findIndex(
    (event) => event.startsWith("run:pscale api") && event.includes("POST"),
  );
  expect(intent).toBeGreaterThanOrEqual(0);
  expect(intent).toBeLessThan(post);
  expect(JSON.stringify(outcome)).not.toContain(SECRET_URL);
});

test("deletion that cannot be proven absent fails the launch even when the child completed", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], [{ name: BRANCH, id: ID }]],
    deleteReadback: fail("Error: not_found"),
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_branch_deletion_unconfirmed");
  expect(outcome.cleanup.branch).toBe("unresolved");
  expect(outcome.completed).toBe(false);
});

test("one cleanup failure does not suppress the other cleanup steps", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], []],
    containerRemove: fail(),
    removePathFails: true,
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_container_cleanup_failed");
  expect(outcome.failures).toContain("rehearsal_secret_cleanup_failed");
  expect(outcome.cleanup.branch).toBe("deleted");
  expect(fake.events.some((event) => event.startsWith("run:pscale branch delete"))).toBe(true);
});

test("a supervisor that never exits is bounded and cleaned up", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], []],
    supervisor: { exitCode: null, timedOut: true, spawnFailed: false },
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_supervisor_deadline_exceeded");
  expect(outcome.completed).toBe(false);
  expect(outcome.cleanup.branch).toBe("deleted");
});

test("a supervisor that cannot spawn is reported and cleaned up", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], []],
    supervisor: { exitCode: null, timedOut: false, spawnFailed: true },
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_supervisor_spawn_failed");
  expect(outcome.cleanup.branch).toBe("deleted");
});

test("the diagnostic mode is explicit, journal-consistent and overrides an ambient variable", async () => {
  const previous = process.env.STAGING_REHEARSAL_DIAGNOSTIC;
  process.env.STAGING_REHEARSAL_DIAGNOSTIC = "1";
  const journalOf = (fake: ReturnType<typeof fakeRuntime>) =>
    JSON.parse(fake.files.get(`/state/${BRANCH}/launch-state.json`) ?? "{}");
  try {
    const ambientRun = fakeRuntime({ gitHeads: [HEAD, HEAD, HEAD], branchLists: [[], []] });
    await executeLaunch(ambientRun.runtime, { checkpoint: HEAD, branch: BRANCH });
    expect(ambientRun.supervisorEnvs.at(-1)?.STAGING_REHEARSAL_DIAGNOSTIC).toBe("0");
    expect(ambientRun.events.find((event) => event.startsWith("supervisor:"))).toContain(
      "--no-diagnostic",
    );
    expect(journalOf(ambientRun).diagnostic).toBe(false);

    const dryRun = fakeRuntime({ gitHeads: [HEAD, HEAD, HEAD], branchLists: [[], []] });
    await executeLaunch(dryRun.runtime, {
      checkpoint: HEAD,
      branch: BRANCH,
      supervisorMode: "dry-run",
      diagnostic: true,
    });
    expect(dryRun.supervisorEnvs.at(-1)?.STAGING_REHEARSAL_DIAGNOSTIC).toBe("0");
    expect(dryRun.events.find((event) => event.startsWith("supervisor:"))).toContain(
      "--no-diagnostic",
    );
    expect(journalOf(dryRun).diagnostic).toBe(false);

    const diagnosticRun = fakeRuntime({ gitHeads: [HEAD, HEAD, HEAD], branchLists: [[], []] });
    await executeLaunch(diagnosticRun.runtime, {
      checkpoint: HEAD,
      branch: BRANCH,
      diagnostic: true,
    });
    expect(diagnosticRun.supervisorEnvs.at(-1)?.STAGING_REHEARSAL_DIAGNOSTIC).toBe("1");
    expect(diagnosticRun.events.find((event) => event.startsWith("supervisor:"))).toContain(
      "--diagnostic",
    );
    expect(journalOf(diagnosticRun).diagnostic).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.STAGING_REHEARSAL_DIAGNOSTIC;
    else process.env.STAGING_REHEARSAL_DIAGNOSTIC = previous;
  }
});

test("a restore check runs the read-only supervisor and completes without the destructive flag", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], []],
    supervisorLog: '{"event":"staging_rehearsal_completed","mode":"dry-run"}\n',
  });
  const outcome = await executeLaunch(fake.runtime, {
    checkpoint: HEAD,
    branch: BRANCH,
    supervisorMode: "dry-run",
  });
  expect(outcome.completed).toBe(true);
  const supervisor = fake.events.find((event) => event.startsWith("supervisor:"));
  expect(supervisor).toContain("--dry-run");
  expect(supervisor).not.toContain("--execute");
  expect(outcome.cleanup.branch).toBe("deleted");
  const state = JSON.parse(fake.files.get(`/state/${BRANCH}/launch-state.json`) ?? "{}");
  expect(state.mode).toBe("dry-run");
});

test("a checkpoint that moves before creation stops the attempt with no POST", async () => {
  const fake = fakeRuntime({ gitHeads: [HEAD, MOVED] });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_checkpoint_moved");
  expect(postsIn(fake.events)).toHaveLength(0);
  expect(outcome.cleanup.branch).toBe("not_created");
});

test("a checkpoint that moves before the child stops the child and deletes the branch", async () => {
  const fake = fakeRuntime({ gitHeads: [HEAD, HEAD, MOVED], branchLists: [[], []] });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_checkpoint_moved");
  expect(fake.events.some((event) => event.startsWith("supervisor:"))).toBe(false);
  expect(outcome.cleanup.branch).toBe("deleted");
});

test("an existing branch name is refused without a POST or foreign deletion", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD],
    branchLists: [[{ name: BRANCH, id: "foreign" }]],
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_branch_name_in_use");
  expect(postsIn(fake.events)).toHaveLength(0);
  expect(fake.events.some((event) => event.startsWith("run:pscale branch delete"))).toBe(false);
  expect(outcome.cleanup.branch).toBe("not_created");
});

test("an existing fixture container is refused and never removed", async () => {
  const fake = fakeRuntime({ gitHeads: [HEAD, HEAD], dockerPs: "foreign-container-id" });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_fixture_name_in_use");
  expect(fake.events.some((event) => event.startsWith("run:docker rm"))).toBe(false);
  expect(fake.events.some((event) => event.startsWith("run:docker run"))).toBe(false);
  expect(postsIn(fake.events)).toHaveLength(0);
});

test("a suite failure after fixture creation still removes the owned container", async () => {
  const fake = fakeRuntime({ gitHeads: [HEAD], suitesFail: true });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_preparation_suites_failed");
  expect(outcome.cleanup.container).toBe("removed");
  expect(fake.events.some((event) => event.startsWith("run:docker rm -f -v container-id-1"))).toBe(
    true,
  );
});

test("an uncertain fixture create reads back and removes only the owned container", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD],
    dockerRun: ok(""),
    dockerLookups: ["", "owned-container-id"],
    suitesFail: true,
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.cleanup.container).toBe("removed");
  expect(
    fake.events.some((event) => event.startsWith("run:docker rm -f -v owned-container-id")),
  ).toBe(true);
});

test("watchdog deadlines survive the unresolved cleanup revision", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], [{ name: BRANCH, id: ID }]],
    deleteReadback: fail("Error: not_found"),
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.cleanup.branch).toBe("unresolved");
  const state = JSON.parse(fake.files.get(`/state/${BRANCH}/launch-state.json`) ?? "{}");
  expect(state.state).toBe("unresolved");
  for (const field of [
    "intent_at",
    "delete_by",
    "ready_at",
    "run_deadline_at",
    "run_ended_at",
    "cleanup_deadline",
  ])
    expect(typeof state[field]).toBe("number");
  expect(state.cleanup_deadline).toBeLessThanOrEqual(state.delete_by);
  expect(state.branch_id).toBe(ID);
  expect(state.evidence).toBe(`/state/${ID}/evidence`);
});

test("a live process tree blocks provider cleanup and keeps the deadlines", async () => {
  const fake = fakeRuntime({
    gitHeads: [HEAD, HEAD, HEAD],
    branchLists: [[], []],
    supervisor: { exitCode: 0, timedOut: false, spawnFailed: false, treeAlive: true },
  });
  const outcome = await executeLaunch(fake.runtime, { checkpoint: HEAD, branch: BRANCH });
  expect(outcome.failures).toContain("rehearsal_supervisor_tree_alive");
  expect(outcome.cleanup.branch).toBe("unresolved");
  expect(outcome.cleanup.container).toBe("unresolved");
  expect(fake.events.some((event) => event.startsWith("run:pscale branch delete"))).toBe(false);
  expect(fake.events.some((event) => event.startsWith("run:docker rm"))).toBe(false);
  const state = JSON.parse(fake.files.get(`/state/${BRANCH}/launch-state.json`) ?? "{}");
  expect(typeof state.delete_by).toBe("number");
});
