import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertRewardPlanTime, type RewardOperationsPlan } from "./reward-operations-plan.ts";
import {
  createRewardOperationsReport,
  printableRewardReadiness,
  RewardOperationsRefusal,
} from "./reward-operations-report.ts";
import {
  boundedRewardOperation,
  type RewardWorker,
  type RewardWorkerClient,
  rewardReadDelay,
} from "./reward-operations-worker-client.ts";
import {
  buildRewardFlagSettingsPatch,
  compareRewardWorkerDescriptor,
  publicRewardWorkerState,
  type RewardWorkerDescriptor,
  rewardDescriptorDigest,
  rewardFlag,
} from "./reward-operations-worker-policy.ts";
import type { RewardShutdownGuardOptions } from "./rewards-binding-deploy-preflight.ts";

export type RewardOperationsJournal = {
  begin(planDigest: string): Promise<void>;
  attempt(worker: "http" | "jobs", kind: "patch" | "deploy"): Promise<void>;
};

/** A pre-existing journal permanently refuses execution; reconciliation is read-only. */
export function createRewardOperationsJournal(
  directory: string,
  operationId: string,
): RewardOperationsJournal {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(operationId))
    throw new RewardOperationsRefusal("invalid-plan");
  const path = join(directory, `${operationId}.jsonl`);
  const attempts = new Set<string>();
  let begun = false;
  async function persist(value: unknown, initial: boolean) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_NOFOLLOW |
          (initial ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND),
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } catch (error) {
      if (
        initial &&
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )
        throw new RewardOperationsRefusal("journal-used");
      throw new RewardOperationsRefusal("journal-unavailable");
    } finally {
      await handle?.close();
    }
  }
  return {
    async begin(planDigest) {
      if (begun) throw new RewardOperationsRefusal("journal-used");
      try {
        const namespace = await lstat(directory);
        if (
          !namespace.isDirectory() ||
          namespace.isSymbolicLink() ||
          (namespace.mode & 0o077) !== 0 ||
          (await realpath(directory)) !== directory
        )
          throw new RewardOperationsRefusal("journal-unavailable");
        await persist({ schemaVersion: 1, operationId, planDigest }, true);
        const parent = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        begun = true;
      } catch (error) {
        throw error instanceof RewardOperationsRefusal
          ? error
          : new RewardOperationsRefusal("journal-unavailable");
      }
    },
    async attempt(worker, kind) {
      const key = `${worker}:${kind}`;
      if (!begun || attempts.has(key)) throw new RewardOperationsRefusal("journal-used");
      attempts.add(key);
      await persist({ worker, kind, outcome: "attempted" }, false);
    },
  };
}

type Diagnostics = ReturnType<typeof createRewardOperationsReport>;
export type RewardFlagsDependencies = {
  client: RewardWorkerClient;
  signal: AbortSignal;
  cleanupSignal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  assertExclusion(plan: RewardOperationsPlan, signal: AbortSignal): Promise<void>;
  assertDatabaseTarget(plan: RewardOperationsPlan, signal: AbortSignal): Promise<void>;
  guard(
    operation: (signal: AbortSignal) => Promise<void>,
    options: RewardShutdownGuardOptions,
  ): Promise<void>;
  journal?: RewardOperationsJournal | undefined;
  diagnostics?: Diagnostics;
};

export async function inspectRewardFlagsOperation(
  plan: RewardOperationsPlan,
  dependencies: Pick<RewardFlagsDependencies, "client" | "signal">,
  diagnostics = createRewardOperationsReport(plan.operationId),
) {
  for (const label of ["http", "jobs"] as const) {
    try {
      diagnostics.state(
        label,
        publicRewardWorkerState(
          await boundedRewardOperation(
            dependencies.client.serving(plan.workers[label], dependencies.signal),
            dependencies.signal,
          ),
        ),
      );
    } catch {
      diagnostics.state(label, null);
    }
  }
  return diagnostics.report;
}

export async function runRewardFlagsOperation(
  plan: RewardOperationsPlan,
  execute: boolean,
  dependencies: RewardFlagsDependencies,
) {
  const diagnostics = dependencies.diagnostics ?? createRewardOperationsReport(plan.operationId);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? rewardReadDelay;
  const client: RewardWorkerClient = {
    authenticate: (worker, active) =>
      boundedRewardOperation(dependencies.client.authenticate(worker, active), active),
    serving: (worker, active) =>
      boundedRewardOperation(dependencies.client.serving(worker, active), active),
    versions: (worker, active) =>
      boundedRewardOperation(dependencies.client.versions(worker, active), active),
    view: (worker, id, active) =>
      boundedRewardOperation(dependencies.client.view(worker, id, active), active),
    patch: (worker, settings, active) =>
      boundedRewardOperation(dependencies.client.patch(worker, settings, active), active),
    deploy: (worker, id, message, active) =>
      boundedRewardOperation(dependencies.client.deploy(worker, id, message, active), active),
  };
  let signal = dependencies.signal;
  let begun = false;
  let stageMutation = false;
  const expectedFinal = { http: plan.workers.http.baseline, jobs: plan.workers.jobs.baseline };
  const assertCurrent = () => {
    if (signal.aborted)
      throw signal.reason instanceof RewardOperationsRefusal
        ? signal.reason
        : new RewardOperationsRefusal("deadline");
    assertRewardPlanTime(plan, now());
  };
  async function exclusion() {
    diagnostics.enter("exclusion");
    assertCurrent();
    await boundedRewardOperation(dependencies.assertExclusion(plan, signal), signal);
    assertCurrent();
  }
  async function precheck(label: "http" | "jobs") {
    const worker = plan.workers[label];
    diagnostics.enter("authentication");
    assertCurrent();
    await client.authenticate(worker, signal);
    diagnostics.enter("worker-precheck");
    assertCurrent();
    const active = await client.serving(worker, signal);
    diagnostics.state(label, publicRewardWorkerState(active));
    compareRewardWorkerDescriptor(worker.baseline, active);
    const latest = (await client.versions(worker, signal)).at(-1)?.id;
    if (worker.route === "settings-patch" && latest !== active.id)
      throw new RewardOperationsRefusal("latest-mismatch");
    if (worker.route === "existing-version") {
      if (!worker.candidate || ![active.id, worker.candidate.id].includes(latest ?? ""))
        throw new RewardOperationsRefusal("latest-mismatch");
      compareRewardWorkerDescriptor(
        worker.candidate,
        await client.view(worker, worker.candidate.id, signal),
      );
    }
    return active;
  }
  async function attempt(
    label: "http" | "jobs",
    kind: "patch" | "deploy",
    mutation: () => Promise<void>,
  ) {
    diagnostics.enter("database-target");
    assertCurrent();
    await boundedRewardOperation(dependencies.assertDatabaseTarget(plan, signal), signal);
    await exclusion();
    if (!dependencies.journal) throw new RewardOperationsRefusal("journal-unavailable");
    diagnostics.enter("journal");
    if (!begun) {
      await boundedRewardOperation(
        dependencies.journal.begin(rewardDescriptorDigest(plan)),
        signal,
      );
      begun = true;
    }
    assertCurrent();
    await boundedRewardOperation(dependencies.journal.attempt(label, kind), signal);
    assertCurrent();
    diagnostics.enter("mutation");
    diagnostics.report.mutation = "attempted";
    stageMutation = true;
    try {
      await boundedRewardOperation(mutation(), signal);
    } catch (error) {
      diagnostics.report.mutation = "uncertain";
      throw error;
    } finally {
      stageMutation = false;
    }
  }
  async function existingDeploy(
    label: "http" | "jobs",
    before: RewardWorkerDescriptor,
    made: RewardWorkerDescriptor,
    message: string,
  ) {
    const worker = plan.workers[label];
    if (!worker.deploymentAuthority) throw new RewardOperationsRefusal("readback");
    diagnostics.enter("authentication");
    await client.authenticate(worker, signal);
    diagnostics.enter("worker-precheck");
    assertCurrent();
    const active = await client.serving(worker, signal);
    compareRewardWorkerDescriptor(before, active);
    const latest = (await client.versions(worker, signal)).at(-1)?.id;
    if (worker.route === "settings-patch" && latest !== made.id)
      throw new RewardOperationsRefusal("latest-mismatch");
    if (worker.route === "existing-version" && ![before.id, made.id].includes(latest ?? ""))
      throw new RewardOperationsRefusal("latest-mismatch");
    compareRewardWorkerDescriptor(made, await client.view(worker, made.id, signal));
    await attempt(label, "deploy", () => client.deploy(worker, made.id, message, signal));
  }
  async function identifyPatch(worker: RewardWorker, message: string) {
    diagnostics.enter("polling");
    for (let observation = 0; observation < 12; observation++) {
      assertCurrent();
      if (observation > 0) await boundedRewardOperation(sleep(5_000, signal), signal);
      const versions = await client.versions(worker, signal);
      const matches = versions.filter((version) => version.message === message);
      if (matches.length > 1) throw new RewardOperationsRefusal("identity-drift");
      if (matches[0]) {
        if (versions.at(-1)?.id !== matches[0].id)
          throw new RewardOperationsRefusal("latest-mismatch");
        return client.view(worker, matches[0].id, signal);
      }
      if (versions.at(-1)?.id !== worker.baseline.id)
        throw new RewardOperationsRefusal("identity-drift");
    }
    throw new RewardOperationsRefusal("readback");
  }
  try {
    diagnostics.enter("plan");
    assertCurrent();
    await exclusion();
    await precheck("http");
    await precheck("jobs");
    diagnostics.enter("database-target");
    await boundedRewardOperation(dependencies.assertDatabaseTarget(plan, signal), signal);
    await dependencies.guard(
      async (guardSignal) => {
        signal = AbortSignal.any([dependencies.signal, guardSignal]);
        for (const label of ["http", "jobs"] as const) {
          const worker = plan.workers[label];
          const before = await precheck(label);
          if (rewardFlag(before) === plan.target || !execute) continue;
          const message = `${before.message.slice(0, 44)} rewards-operator:${plan.operationId}:${label}:${plan.target}`;
          let made: RewardWorkerDescriptor;
          if (worker.route === "existing-version") {
            if (!worker.candidate) throw new RewardOperationsRefusal("invalid-plan");
            made = worker.candidate;
            await existingDeploy(label, before, made, message);
          } else {
            await attempt(label, "patch", () =>
              client.patch(
                worker,
                buildRewardFlagSettingsPatch(before, plan.target, message),
                signal,
              ),
            );
            made = await identifyPatch(worker, message);
            if (made.message !== message) throw new RewardOperationsRefusal("identity-drift");
            compareRewardWorkerDescriptor(before, made, plan.target, false);
            const active = await client.serving(worker, signal);
            if (active.id === before.id) await existingDeploy(label, before, made, message);
            else if (active.id !== made.id) throw new RewardOperationsRefusal("identity-drift");
          }
          diagnostics.enter("readback");
          assertCurrent();
          const after = await client.serving(worker, signal);
          compareRewardWorkerDescriptor(made, after);
          if (rewardFlag(after) !== plan.target) throw new RewardOperationsRefusal("readback");
          diagnostics.state(label, publicRewardWorkerState(after));
          expectedFinal[label] = made;
        }
        diagnostics.enter("readback");
        for (const label of ["http", "jobs"] as const) {
          assertCurrent();
          const worker = plan.workers[label];
          const after = await client.serving(worker, signal);
          diagnostics.state(label, publicRewardWorkerState(after));
          compareRewardWorkerDescriptor(expectedFinal[label], after);
          const latest = (await client.versions(worker, signal)).at(-1)?.id;
          if (worker.route === "settings-patch" && latest !== after.id)
            throw new RewardOperationsRefusal("latest-mismatch");
          if (
            worker.route === "existing-version" &&
            ![worker.baseline.id, worker.candidate?.id].includes(latest)
          )
            throw new RewardOperationsRefusal("latest-mismatch");
        }
        assertCurrent();
      },
      {
        expectedRevision: plan.expectedRevision,
        signal: dependencies.signal,
        cleanupSignal: dependencies.cleanupSignal,
        observe(event) {
          if (event.stage === "guard-rollback") {
            if (event.status === "failed")
              diagnostics.cleanup(
                event.stage,
                Object.assign(
                  new RewardOperationsRefusal(
                    event.failure?.reason ?? "unknown",
                    event.failure?.status,
                  ),
                  { code: event.failure?.sqlstate ?? event.failure?.transport },
                ),
              );
            return;
          }
          if (event.status === "started") diagnostics.enter(event.stage);
          if (
            event.present &&
            event.category &&
            !diagnostics.report.blockers.includes(event.category)
          )
            diagnostics.report.blockers.push(event.category);
        },
      },
    );
    if (diagnostics.report.cleanupFailures.length) throw new RewardOperationsRefusal("unknown");
    diagnostics.enter("complete");
    diagnostics.report.ok = true;
    if (begun) diagnostics.report.mutation = "verified";
  } catch (error) {
    if (stageMutation || begun) diagnostics.report.mutation = "uncertain";
    diagnostics.fail(error);
    await inspectRewardFlagsOperation(plan, { client, signal: dependencies.signal }, diagnostics);
  }
  diagnostics.report.blockers = printableRewardReadiness(diagnostics.report.blockers);
  return diagnostics.report;
}
