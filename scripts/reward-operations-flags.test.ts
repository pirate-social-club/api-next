import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRewardOperationsJournal,
  type RewardFlagsDependencies,
  runRewardFlagsOperation,
} from "./reward-operations-flags.ts";
import { RewardOperationsRefusal } from "./reward-operations-report.ts";
import { rewardPlanFixture } from "./reward-operations-test-fixture.ts";
import type { RewardWorkerClient } from "./reward-operations-worker-client.ts";
import type { RewardWorkerDescriptor } from "./reward-operations-worker-policy.ts";

type Mutable<T> = T extends readonly (infer Value)[]
  ? Mutable<Value>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function fixture(
  options: {
    lag?: number;
    deploy?: boolean;
    lost?: boolean;
    failJobs?: boolean;
    hide?: boolean;
  } = {},
) {
  const plan = structuredClone(rewardPlanFixture()) as Mutable<
    ReturnType<typeof rewardPlanFixture>
  >;
  const signal = new AbortController();
  const calls: string[] = [];
  const active = new Map<string, RewardWorkerDescriptor>();
  const versions = new Map<string, RewardWorkerDescriptor[]>();
  const lag = new Map<string, number>();
  for (const worker of Object.values(plan.workers)) {
    active.set(worker.name, worker.baseline);
    versions.set(worker.name, [worker.baseline]);
  }
  const client: RewardWorkerClient = {
    async authenticate() {},
    async serving(worker) {
      return active.get(worker.name) as RewardWorkerDescriptor;
    },
    async versions(worker) {
      const remaining = lag.get(worker.name) ?? 0;
      lag.set(worker.name, Math.max(0, remaining - 1));
      const values = versions.get(worker.name) as RewardWorkerDescriptor[];
      return (remaining > 0 || options.hide ? values.slice(0, 1) : values).map((v, i) => ({
        id: v.id,
        message: v.message,
        createdAt: i,
      }));
    },
    async view(worker, id) {
      const found = versions.get(worker.name)?.find((v) => v.id === id);
      if (!found) throw new RewardOperationsRefusal("identity-drift");
      return found;
    },
    async patch(worker, settings) {
      calls.push(`patch:${worker.name}`);
      if (options.failJobs && worker.name === plan.workers.jobs.name)
        throw Error("private provider failure");
      const patch = settings as { annotations: { "workers/message": string } };
      const made = {
        ...worker.baseline,
        id: "22222222-2222-2222-2222-222222222222",
        message: patch.annotations["workers/message"],
        bindings: worker.baseline.bindings.map((b) =>
          b.name === "MEGAPOT_REWARDS_ENABLED" ? { ...b, text: "false" } : b,
        ),
      };
      versions.get(worker.name)?.push(made);
      lag.set(worker.name, options.lag ?? 0);
      if (!options.deploy) active.set(worker.name, made);
      if (options.lost) throw new RewardOperationsRefusal("transport");
    },
    async deploy(worker, id) {
      calls.push(`deploy:${worker.name}`);
      active.set(worker.name, await client.view(worker, id, signal.signal));
    },
  };
  let begins = 0;
  const markers: string[] = [];
  const dependencies: RewardFlagsDependencies = {
    client,
    signal: signal.signal,
    now: () => Date.parse("2026-10-03T12:00:00Z"),
    sleep: async () => {},
    assertExclusion: async () => {},
    assertDatabaseTarget: async () => {},
    guard: async (operation, options) => {
      expect(options.expectedRevision).toBe("10");
      await operation(signal.signal);
    },
    journal: {
      async begin() {
        begins++;
      },
      async attempt(label, kind) {
        markers.push(`${label}:${kind}`);
      },
    },
  };
  return { plan, dependencies, calls, markers, active, versions, signal, begins: () => begins };
}

test("PATCH may deploy immediately while listing lags; each Worker is written exactly once", async () => {
  const run = fixture({ lag: 2 });
  const report = await runRewardFlagsOperation(run.plan, true, run.dependencies);
  expect(report.ok).toBe(true);
  expect(report.mutation).toBe("verified");
  expect(run.calls).toEqual([
    "patch:pirate-http-worker-staging",
    "patch:pirate-jobs-worker-staging",
  ]);
  expect(run.markers).toEqual(["http:patch", "jobs:patch"]);
  expect(run.begins()).toBe(1);
});

test("a verified upload can deploy once only with separate deployment authority", async () => {
  const run = fixture({ deploy: true });
  run.plan.workers.http.deploymentAuthority = "review:deploy-http";
  run.plan.workers.jobs.deploymentAuthority = "review:deploy-jobs";
  const report = await runRewardFlagsOperation(run.plan, true, run.dependencies);
  expect(report.ok).toBe(true);
  expect(run.calls).toHaveLength(4);
  expect(run.calls.filter((c) => c.startsWith("deploy"))).toHaveLength(2);
  const refused = fixture({ deploy: true });
  expect((await runRewardFlagsOperation(refused.plan, true, refused.dependencies)).ok).toBe(false);
  expect(refused.calls).toHaveLength(1);
});

test("failed or lost disable retains confirmed off states and never enables or replays", async () => {
  for (const options of [{ failJobs: true }, { lost: true }]) {
    const run = fixture(options);
    const report = await runRewardFlagsOperation(run.plan, true, run.dependencies);
    expect(report.ok).toBe(false);
    expect(report.mutation).toBe("uncertain");
    expect(report.workers.http?.current?.flag).toBe("false");
    expect(report.workers.jobs?.current?.flag).toBe("true");
    expect(run.calls).toHaveLength(options.lost ? 1 : 2);
    expect(run.calls.every((c) => c.startsWith("patch"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private");
  }
});

test("a reviewed existing version deploys exactly once without PATCH", async () => {
  const run = fixture();
  for (const worker of Object.values(run.plan.workers)) {
    const candidate = {
      ...worker.baseline,
      id: "22222222-2222-2222-2222-222222222222",
      bindings: worker.baseline.bindings.map((binding) =>
        binding.name === "MEGAPOT_REWARDS_ENABLED" ? { ...binding, text: "false" } : binding,
      ),
    };
    Object.assign(worker, {
      route: "existing-version",
      candidate,
      deploymentAuthority: "review:existing",
    });
    run.versions.get(worker.name)?.push(candidate);
  }
  const report = await runRewardFlagsOperation(run.plan, true, run.dependencies);
  expect(report.ok).toBe(true);
  expect(run.calls).toEqual([
    "deploy:pirate-http-worker-staging",
    "deploy:pirate-jobs-worker-staging",
  ]);
});

test("final paired readback refuses HTTP drift during jobs work and reports actual state", async () => {
  const run = fixture();
  const original = run.dependencies.client.patch;
  run.dependencies.client.patch = async (worker, settings, signal) => {
    await original(worker, settings, signal);
    if (worker.name === run.plan.workers.jobs.name)
      run.active.set(run.plan.workers.http.name, run.plan.workers.http.baseline);
  };
  const report = await runRewardFlagsOperation(run.plan, true, run.dependencies);
  expect(report.ok).toBe(false);
  expect(report.workers.http?.current?.flag).toBe("true");
  expect(run.calls).toHaveLength(2);
  expect(run.markers).toHaveLength(2);
});

test("all prerequisites precede markers; changed latest, revoked lease or deadline cannot claim an attempt", async () => {
  for (const kind of ["latest", "lease", "deadline", "authentication"] as const) {
    const run = fixture();
    if (kind === "latest")
      run.dependencies.client.versions = async () => [
        { id: "33333333-3333-3333-3333-333333333333", message: "other", createdAt: 1 },
      ];
    if (kind === "lease") {
      let reads = 0;
      run.dependencies.assertExclusion = async () => {
        if (++reads > 1) throw new RewardOperationsRefusal("exclusion");
      };
    }
    if (kind === "deadline")
      run.dependencies.client.authenticate = async () => {
        run.signal.abort();
      };
    if (kind === "authentication")
      run.dependencies.client.authenticate = async () => {
        throw new RewardOperationsRefusal("authentication");
      };
    expect((await runRewardFlagsOperation(run.plan, true, run.dependencies)).ok).toBe(false);
    expect(run.calls).toHaveLength(0);
    expect(run.markers).toHaveLength(0);
    expect(run.begins()).toBe(0);
  }
});

test("dry run and already-off skip all writes; polling has a finite twelve-observation limit", async () => {
  const dry = fixture();
  expect((await runRewardFlagsOperation(dry.plan, false, dry.dependencies)).ok).toBe(true);
  expect(dry.calls).toHaveLength(0);
  expect(dry.begins()).toBe(0);
  const skipped = fixture();
  for (const worker of Object.values(skipped.plan.workers)) {
    worker.baseline = {
      ...worker.baseline,
      bindings: worker.baseline.bindings.map((b) =>
        b.name === "MEGAPOT_REWARDS_ENABLED" ? { ...b, text: "false" } : b,
      ),
    };
    skipped.active.set(worker.name, worker.baseline);
  }
  expect((await runRewardFlagsOperation(skipped.plan, true, skipped.dependencies)).ok).toBe(true);
  expect(skipped.calls).toHaveLength(0);
  const hidden = fixture({ hide: true });
  let waits = 0;
  hidden.dependencies.sleep = async () => {
    waits++;
  };
  expect((await runRewardFlagsOperation(hidden.plan, true, hidden.dependencies)).ok).toBe(false);
  expect(waits).toBe(11);
  expect(hidden.calls).toHaveLength(1);
});

test("the durable journal refuses restart and contains no credentials or descriptor contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-journal-"));
  try {
    const journal = createRewardOperationsJournal(directory, "fixture");
    await journal.begin("a".repeat(64));
    await journal.attempt("http", "patch");
    await expect(journal.attempt("http", "patch")).rejects.toThrow("journal-used");
    await expect(
      createRewardOperationsJournal(directory, "fixture").begin("a".repeat(64)),
    ).rejects.toThrow("journal-used");
    const contents = await readFile(join(directory, "fixture.jsonl"), "utf8");
    expect(contents).toContain("attempted");
    expect(contents).not.toContain("SECRET");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
