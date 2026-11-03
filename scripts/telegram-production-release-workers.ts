import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  deployWorkerWithProvenance,
  runDeploymentCommand,
} from "./deploy-worker-with-provenance.ts";
import { linuxProcess } from "./production-release/production-linux-process-bound.ts";
import {
  injectedProductionUrls,
  managedProviderApi,
  wranglerEnvironment,
} from "./production-release/production-managed-environment.ts";
import { exclusiveRecord } from "./production-release/production-operation-evidence.ts";
import { managedGuards } from "./public-post-http-release-provider.ts";
import { assertExecutionTools, fileHash } from "./public-post-http-release-source.ts";
import { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";
import { prepareSongFundingBindingAdmission } from "./song-funding-binding-admission.ts";
import { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";
import {
  type TelegramFile,
  type TelegramReview,
  telegramFile,
  telegramJson,
} from "./telegram-production-release-admission.ts";
import {
  assertTelegramFunctions,
  assertTelegramLedger,
  assertTelegramMatrix,
  telegramDatabase,
  telegramPrivileges,
  telegramRowLocks,
} from "./telegram-production-release-database.ts";
import {
  assertTelegramDisabledTarget,
  assertTelegramForwardWorker,
  assertTelegramHyperdriveOrigin,
  assertTelegramRecoveryVersion,
  TELEGRAM_RELEASE as policy,
  requireTelegram,
  type TelegramPhase,
  type TelegramWorker,
  type TelegramWorkerMetadata,
  type TelegramWorkerSnapshot,
  telegramBindingDelta,
  telegramMode,
  telegramPhaseConfig,
  telegramQueueConsumer,
  telegramWorkerMetadataState,
  telegramWorkerState,
} from "./telegram-production-release-policy.ts";
import {
  publishedTelegramSources,
  publishedTelegramTooling,
} from "./telegram-production-release-source.ts";
import { bindings, digest, runtime } from "./worker-binding-drift.ts";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  requireTelegram(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "worker-response-refused",
  );
  return value as Json;
};
/** Long read-only preflights cannot carry a stale control/process/window check into upload. */
export async function telegramUploadBoundary<T>(input: {
  readonly signal?: AbortSignal | undefined;
  preflight(): Promise<void>;
  assertBound(): void;
  attempt(): void;
  upload(): Promise<T>;
}) {
  await input.preflight();
  requireTelegram(!input.signal?.aborted, "upload-control-connection-lost");
  input.assertBound();
  input.attempt();
  requireTelegram(!input.signal?.aborted, "upload-control-connection-lost");
  input.assertBound();
  return input.upload();
}
type ProviderRead = (path: string) => Promise<unknown>;
async function allocation(worker: TelegramWorker, api: ProviderRead) {
  const result = object(await api(`/workers/scripts/${policy.workers[worker].name}/deployments`));
  requireTelegram(Array.isArray(result.deployments), "worker-deployments-missing");
  const row = object(result.deployments[0]);
  requireTelegram(
    Array.isArray(row.versions) && row.versions.length === 1,
    "single-full-traffic-version-required",
  );
  const version = object(row.versions[0]);
  requireTelegram(
    version.percentage === 100 &&
      typeof version.version_id === "string" &&
      typeof row.id === "string",
    "single-full-traffic-version-required",
  );
  return { version: version.version_id, deployment: row.id };
}
async function latest(worker: TelegramWorker, api: ProviderRead) {
  const uploaded = object(await api(`/workers/scripts/${policy.workers[worker].name}/versions`));
  requireTelegram(
    Array.isArray(uploaded.items) && typeof object(uploaded.items[0]).id === "string",
    "latest-worker-upload-missing",
  );
  return String(object(uploaded.items[0]).id);
}
/** Recovery metadata does not request modules, invent a hash or prove native readiness. */
export async function collectTelegramWorkerMetadata(
  worker: TelegramWorker,
  api: ProviderRead = managedProviderApi,
): Promise<TelegramWorkerMetadata> {
  const name = policy.workers[worker].name,
    target = `/workers/scripts/${name}`;
  const before = await allocation(worker, api);
  const [rawVersion, rawSettings, allDomains, queueRows, subdomain, uploaded] = await Promise.all([
    api(`${target}/versions/${before.version}`),
    api(`${target}/settings`),
    api("/workers/domains?per_page=100"),
    api(`/queues?name=${policy.queue}`),
    api(`${target}/subdomain`),
    latest(worker, api),
  ]);
  const version = object(rawVersion),
    resources = object(version.resources),
    safeSettings = { ...object(rawSettings) };
  delete safeSettings.annotations;
  delete safeSettings.bindings;
  if (safeSettings.placement) {
    const placement = { ...object(safeSettings.placement) };
    delete placement.last_analyzed_at;
    delete placement.status;
    safeSettings.placement = placement;
  }
  requireTelegram(
    Array.isArray(allDomains) && allDomains.length < 100,
    "worker-domain-pagination-unmodelled",
  );
  const domains = allDomains
    .map(object)
    .filter((row) => row.service === name)
    .map((row) => ({ hostname: row.hostname, service: row.service, environment: row.environment }))
    .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
  requireTelegram(
    Array.isArray(queueRows) && queueRows.length === 1,
    "exact-production-queue-required",
  );
  const queue = object(queueRows[0]),
    consumers = await api(`/queues/${queue.queue_id}/consumers`);
  const [after, newest] = await Promise.all([allocation(worker, api), latest(worker, api)]);
  requireTelegram(
    isDeepStrictEqual(after, before) && newest === uploaded,
    "worker-traffic-moved-during-observation",
  );
  return {
    ...before,
    latest: uploaded,
    bindings: bindings(resources.bindings),
    runtime: runtime(resources.script_runtime),
    settings: safeSettings,
    domains,
    subdomain,
    queue: telegramQueueConsumer(queue, consumers),
    message: String(object(version.annotations)["workers/message"] ?? ""),
  };
}
export async function collectTelegramWorker(
  worker: TelegramWorker,
  api: ProviderRead = managedProviderApi,
): Promise<TelegramWorkerSnapshot> {
  const metadata = await collectTelegramWorkerMetadata(worker, api);
  // Same documented endpoint as the installed CLI, through the maintained managed-token transport.
  const module = object(
    await api(
      `/workers/workers/${policy.workers[worker].name}/versions/${metadata.version}?include=modules`,
    ),
  );
  requireTelegram(
    module.id === metadata.version &&
      module.main_module === "index.js" &&
      Array.isArray(module.modules) &&
      module.modules.length === 1,
    "worker-module-inventory-differs",
  );
  const entry = object(module.modules[0]);
  requireTelegram(
    entry.name === "index.js" && typeof entry.content_base64 === "string",
    "worker-module-bytes-missing",
  );
  const bytes = Buffer.from(entry.content_base64, "base64");
  requireTelegram(
    bytes.toString("base64") === entry.content_base64,
    "worker-module-encoding-refused",
  );
  const [after, uploaded] = await Promise.all([allocation(worker, api), latest(worker, api)]);
  requireTelegram(
    after.version === metadata.version &&
      after.deployment === metadata.deployment &&
      uploaded === metadata.latest,
    "worker-traffic-moved-during-observation",
  );
  return { ...metadata, module_sha256: digestBytes(bytes) };
}
export async function telegramServingOrigins(review?: TelegramReview, phase?: TelegramPhase) {
  const [config, http, jobs]: [unknown, TelegramWorkerMetadata, TelegramWorkerMetadata] =
    await Promise.all([
      managedProviderApi(`/hyperdrive/configs/${policy.database.hyperdrive}`),
      collectTelegramWorkerMetadata("http"),
      collectTelegramWorkerMetadata("jobs"),
    ]);
  const origin = assertTelegramHyperdriveOrigin(object(config).origin),
    consumers = [];
  for (const [worker, snapshot] of [
    ["http", http],
    ["jobs", jobs],
  ] as const) {
    const binding = snapshot.bindings.find((row) => row.name === "CONTROL_PLANE");
    requireTelegram(
      binding?.type === "hyperdrive" && binding.id === policy.database.hyperdrive,
      "serving-consumer-hyperdrive-differs",
    );
    if (review && phase) {
      requireTelegram(review.serving_workers, "reviewed-current-worker-readbacks-required");
      assertTelegramForwardWorker(
        phase,
        worker,
        snapshot,
        telegramJson<TelegramWorkerSnapshot>(review.serving_workers[worker]),
      );
    }
    const after = await allocation(worker, managedProviderApi);
    requireTelegram(
      after.version === snapshot.version && after.deployment === snapshot.deployment,
      "counterpart-traffic-moved-during-observation",
    );
    consumers.push({ worker, hyperdrive: binding.id, ...telegramWorkerMetadataState(snapshot) });
  }
  return { origin, consumers };
}

import { sha256 as digestBytes } from "./public-post-http-release-core.ts";

export async function uploadTelegramWorker(
  worker: TelegramWorker,
  phase: TelegramPhase,
  review: TelegramReview,
  configuration: TelegramFile,
  secrets: Readonly<Record<string, string>>,
  assertBound: () => void,
) {
  const target = policy.workers[worker],
    app = policy.paths.application;
  const config = JSON.parse(telegramFile(configuration).toString());
  requireTelegram(
    isDeepStrictEqual(
      config,
      telegramPhaseConfig(worker, phase, readFileSync(resolve(app, target.config), "utf8")),
    ),
    "reviewed-phase-configuration-changed",
  );
  requireTelegram(
    isDeepStrictEqual(
      Object.keys(secrets).sort(),
      [policy.vault.name, ...(worker === "jobs" ? [policy.vault.transcription] : [])].sort(),
    ),
    "unexpected-upload-secret-input",
  );
  const recovery = phase.startsWith("pause-");
  const collect = () =>
    recovery ? collectTelegramWorkerMetadata(worker) : collectTelegramWorker(worker);
  const before = await collect();
  const initial = phase.startsWith("install-");
  requireTelegram(
    phase.startsWith("pause-") || before.latest === before.version,
    "unserved-worker-upload-requires-reconciliation",
  );
  requireTelegram(
    !initial ||
      (before.version === target.baseline &&
        before.module_sha256 === target.baselineModule &&
        before.message === `git:${target.source}`),
    "distinct-serving-baseline-changed",
  );
  const urls = injectedProductionUrls();
  return managedGuards(async () => {
    const runner: typeof runDeploymentCommand = async (command, cwd, signal) => {
      requireTelegram(cwd === app && !signal?.aborted, "deployment-context-changed");
      if (command[0] === "bunx" && command[1] === "wrangler" && command[2] === "deploy") {
        requireTelegram(
          isDeepStrictEqual(command, [
            "bunx",
            "wrangler",
            "deploy",
            "--env",
            "production",
            "--config",
            target.config,
            "--message",
            `git:${policy.source}`,
          ]),
          "unexpected-worker-upload-command",
        );
        return telegramUploadBoundary({
          signal,
          assertBound,
          preflight: async () => {
            requireTelegram(
              digest(telegramWorkerState(await collect())) === digest(telegramWorkerState(before)),
              "worker-state-moved-immediately-before-upload",
            );
            await telegramServingOrigins(
              recovery ? undefined : review,
              recovery ? undefined : phase,
            );
            telegramFile(configuration);
            requireTelegram(
              fileHash(resolve(policy.paths.artifacts, worker, "bundle/index.js")) ===
                target.module && fileHash(resolve(app, target.config)) === target.configSha256,
              "retained-upload-input-changed",
            );
            assertExecutionTools(review);
          },
          attempt: () =>
            exclusiveRecord(policy.paths.operation, `${phase}-upload-attempt.json`, {
              worker: target.name,
              source: policy.source,
              configuration_sha256: configuration.sha256,
              module_sha256: target.module,
              previous_version: before.version,
              previous_latest: before.latest,
              before_sha256: digest(telegramWorkerState(before)),
            }),
          upload: async () => {
            const group = linuxProcess(process.pid).pgrp;
            requireTelegram(group === process.ppid, "owned-timeout-process-group-required");
            const abort = () => process.kill(-group, "SIGTERM");
            signal?.addEventListener("abort", abort, { once: true });
            try {
              assertBound();
              requireTelegram(!signal?.aborted, "upload-control-connection-lost");
              const child = Bun.spawn(
                [
                  review.execution_tools.node_path,
                  resolve(policy.paths.tooling, "node_modules/wrangler/bin/wrangler.js"),
                  "deploy",
                  resolve(policy.paths.artifacts, worker, "bundle/index.js"),
                  "--no-bundle",
                  "--config",
                  configuration.path,
                  "--secrets-file",
                  "/dev/stdin",
                  "--message",
                  `git:${policy.source}`,
                ],
                {
                  cwd: app,
                  env: {
                    ...wranglerEnvironment(),
                    WRANGLER_SEND_METRICS: "false",
                    WRANGLER_WRITE_LOGS: "false",
                  },
                  stdin: new TextEncoder().encode(JSON.stringify(secrets)),
                  stdout: "pipe",
                  stderr: "pipe",
                },
              );
              await Promise.all([
                new Response(child.stdout).arrayBuffer(),
                new Response(child.stderr).arrayBuffer(),
              ]);
              return { exitCode: await child.exited, stdout: "", stderr: "" };
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          },
        });
      }
      const listing = [
        "bunx",
        "wrangler",
        "versions",
        "list",
        "--env",
        "production",
        "--config",
        target.config,
        "--json",
      ];
      requireTelegram(isDeepStrictEqual(command, listing), "unexpected-deployment-child");
      return runDeploymentCommand(
        [
          review.execution_tools.node_path,
          resolve(policy.paths.tooling, "node_modules/wrangler/bin/wrangler.js"),
          ...command.slice(2),
        ],
        app,
        signal,
        { ...wranglerEnvironment(), WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" },
      );
    };
    const result = await deployWorkerWithProvenance(
      app,
      {
        configPath: target.config,
        environment: "production",
        sourceRef: policy.source,
        acceptedMainRef: "origin/main",
      },
      runner,
      () => {},
      undefined,
      undefined,
      undefined,
      (root, path, environment, action) =>
        withTelegramActivationDeployment(
          root,
          path,
          environment,
          action,
          JSON.stringify(telegramMode(phase)),
          async () =>
            telegramDatabase(urls.runtime, policy.database.runtime, true, async (db) => {
              await assertTelegramLedger(db, 334);
              assertTelegramMatrix(await telegramPrivileges(db), true);
              await assertTelegramFunctions(db);
              await telegramRowLocks(db);
            }),
        ),
      undefined,
      undefined,
      async (root, input) => {
        requireTelegram(
          root === app &&
            input.configPath === target.config &&
            input.environment === "production" &&
            input.sourceRef === policy.source &&
            input.acceptedMainRef === "origin/main" &&
            !input.bindingReviewPath &&
            !input.toolingSourceRef,
          "fixed-telegram-source-input-required",
        );
        if (phase.startsWith("pause-")) publishedTelegramTooling(review);
        else publishedTelegramSources(review);
        telegramFile(configuration);
        return { sourceSha: policy.source, configPath: target.config };
      },
    );
    const after = await collect();
    requireTelegram(
      after.version === result.worker_version_id &&
        after.latest === after.version &&
        (recovery || after.module_sha256 === target.module) &&
        after.message === `git:${policy.source}` &&
        digest(after.runtime) === digest(before.runtime) &&
        digest(after.settings) === digest(before.settings) &&
        digest(after.domains) === digest(before.domains) &&
        digest(after.subdomain) === digest(before.subdomain) &&
        digest(after.queue) === digest(before.queue),
      "worker-upload-or-unrelated-resources-unverified",
    );
    telegramBindingDelta(worker, before.bindings, after.bindings, phase, initial);
    exclusiveRecord(policy.paths.operation, `${phase}-worker.json`, {
      worker: target.name,
      version: result.worker_version_id,
      source: policy.source,
      module_sha256: target.module,
      configuration_sha256: configuration.sha256,
      snapshot: after,
      compiled_module_observed: !recovery,
    });
    return result;
  });
}

/** Retained disabled traffic recovery uses the same production deployment guards as715. */
export async function rollbackTelegramWorker(
  worker: TelegramWorker,
  version: string,
  review: TelegramReview,
  assertBound: () => void,
) {
  const target = policy.workers[worker],
    app = policy.paths.application;
  requireTelegram(/^[a-f0-9-]{36}$/u.test(version), "fixed-reviewed-recovery-version-required");
  return managedGuards(async () => {
    const funding = await prepareSongFundingBindingAdmission(
      app,
      target.config,
      "production",
      policy.source,
    );
    return withServingFunctionPrivilegesDeployment(app, target.config, () =>
      withTelegramActivationDeployment(
        app,
        target.config,
        "production",
        () =>
          withRewardsBindingDeployment(app, target.config, "production", async (signal) => {
            await funding?.recheck();
            assertBound();
            requireTelegram(!signal?.aborted, "recovery-control-connection-lost");
            const group = linuxProcess(process.pid).pgrp;
            requireTelegram(group === process.ppid, "owned-timeout-process-group-required");
            const abort = () => process.kill(-group, "SIGTERM");
            signal?.addEventListener("abort", abort, { once: true });
            try {
              return await runDeploymentCommand(
                [
                  review.execution_tools.node_path,
                  resolve(policy.paths.tooling, "node_modules/wrangler/bin/wrangler.js"),
                  "rollback",
                  version,
                  "--config",
                  target.config,
                  "--env",
                  "production",
                  "--yes",
                  "--message",
                  "Telegram practice disabled recovery",
                ],
                app,
                undefined,
                {
                  ...wranglerEnvironment(),
                  WRANGLER_SEND_METRICS: "false",
                  WRANGLER_WRITE_LOGS: "false",
                },
              );
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          }),
        JSON.stringify(telegramMode(worker === "http" ? "pause-http" : "pause-jobs")),
      ),
    );
  });
}

export {
  assertTelegramDisabledTarget,
  assertTelegramForwardWorker,
  assertTelegramHyperdriveOrigin,
  assertTelegramRecoveryVersion,
  type TelegramWorkerMetadata,
  type TelegramWorkerSnapshot,
  telegramBindingDelta,
  telegramPhaseConfig,
  telegramQueueConsumer,
  telegramWorkerMetadataState,
  telegramWorkerState,
};
