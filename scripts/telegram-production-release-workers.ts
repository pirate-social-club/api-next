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
  managedProviderToken,
  providerReadEnvironment,
  wranglerEnvironment,
} from "./production-release/production-managed-environment.ts";
import { exclusiveRecord } from "./production-release/production-operation-evidence.ts";
import { managedGuards } from "./public-post-http-release-provider.ts";
import { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import { parseJsonc } from "./secret-drift-audit.ts";
import { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";
import { prepareSongFundingBindingAdmission } from "./song-funding-binding-admission.ts";
import { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";
import {
  type TelegramFile,
  type TelegramReview,
  telegramFile,
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
  TELEGRAM_RELEASE as policy,
  requireTelegram,
  type TelegramPhase,
  type TelegramWorker,
  telegramMode,
} from "./telegram-production-release-policy.ts";
import {
  publishedTelegramSources,
  publishedTelegramTooling,
} from "./telegram-production-release-source.ts";
import { type Binding, bindings, digest, runtime } from "./worker-binding-drift.ts";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  requireTelegram(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "worker-response-refused",
  );
  return value as Json;
};
export function telegramPhaseConfig(worker: TelegramWorker, phase: TelegramPhase, source: string) {
  const root = parseJsonc<Json>(source),
    production = object(object(root.env).production);
  const config = { ...root, ...production };
  delete config.env;
  delete config.$schema;
  config.main = resolve(policy.paths.artifacts, worker, "bundle/index.js");
  config.vars = {
    ...object(production.vars),
    TELEGRAM_CONFIG_JSON: JSON.stringify(telegramMode(phase)),
  };
  const secrets = config.secrets === undefined ? {} : object(config.secrets);
  const required = secrets.required === undefined ? [] : secrets.required;
  requireTelegram(
    Array.isArray(required) && required.every((name) => typeof name === "string"),
    "secret-declaration-refused",
  );
  config.secrets = {
    ...secrets,
    required: [
      ...new Set([
        ...required,
        policy.vault.name,
        ...(worker === "jobs" ? [policy.vault.transcription] : []),
      ]),
    ],
  };
  requireTelegram(
    config.name === policy.workers[worker].name && config.account_id === policy.account,
    "phase-config-target-differs",
  );
  return config;
}
/** Only the Telegram intent and the two named secret additions may differ. */
export function telegramBindingDelta(
  worker: TelegramWorker,
  before: readonly Binding[],
  after: readonly Binding[],
  phase: TelegramPhase,
  initial: boolean,
) {
  const left = bindings(before),
    right = bindings(after);
  const permitted = new Set([
    "TELEGRAM_CONFIG_JSON",
    policy.vault.name,
    ...(worker === "jobs" ? [policy.vault.transcription] : []),
  ]);
  requireTelegram(
    digest(left.filter((r) => !permitted.has(r.name))) ===
      digest(right.filter((r) => !permitted.has(r.name))),
    "unrelated-worker-binding-drift",
  );
  const mode = right.find((r) => r.name === "TELEGRAM_CONFIG_JSON");
  requireTelegram(
    mode?.type === "plain_text" && mode.text === JSON.stringify(telegramMode(phase)),
    "telegram-mode-differs",
  );
  for (const name of [...permitted].filter((name) => name !== "TELEGRAM_CONFIG_JSON")) {
    const previous = left.find((r) => r.name === name),
      current = right.find((r) => r.name === name);
    requireTelegram(
      current?.type === "secret_text" && (!previous || digest(previous) === digest(current)),
      "telegram-secret-binding-differs",
    );
    if (initial) requireTelegram(!previous, "unexpected-preexisting-secret-binding");
  }
}
export function telegramQueueConsumer(queue: unknown, consumers: unknown) {
  const q = object(queue);
  requireTelegram(
    q.queue_name === policy.queue && typeof q.queue_id === "string" && Array.isArray(consumers),
    "production-telegram-queue-missing",
  );
  const rows = consumers.map(object);
  requireTelegram(
    rows.length === 1 &&
      rows[0]?.type === "worker" &&
      rows[0]?.script_name === policy.workers.jobs.name &&
      (rows[0]?.environment === undefined || rows[0]?.environment === "production"),
    "telegram-consumer-not-the-production-jobs-worker",
  );
  return { queue: q.queue_name, id: q.queue_id, consumers: rows };
}
export interface TelegramWorkerSnapshot {
  readonly version: string;
  readonly deployment: string;
  readonly bindings: readonly Binding[];
  readonly runtime: Json;
  readonly settings: Json;
  readonly domains: readonly unknown[];
  readonly subdomain: unknown;
  readonly queue: ReturnType<typeof telegramQueueConsumer>;
  readonly message: string;
  readonly module_sha256: string;
}
export async function collectTelegramWorker(
  worker: TelegramWorker,
): Promise<TelegramWorkerSnapshot> {
  const name = policy.workers[worker].name,
    target = `/workers/scripts/${name}`;
  const allocation = async () => {
    const result = object(await managedProviderApi(`${target}/deployments`));
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
  };
  const before = await allocation(),
    version = object(await managedProviderApi(`${target}/versions/${before.version}`));
  const resources = object(version.resources);
  const settings = object(await managedProviderApi(`${target}/settings`));
  // Remove volatile placement analysis, while keeping every other setting for exact review.
  const safeSettings = { ...settings };
  delete safeSettings.annotations;
  delete safeSettings.bindings;
  if (safeSettings.placement) {
    const placement = { ...object(safeSettings.placement) };
    delete placement.last_analyzed_at;
    delete placement.status;
    safeSettings.placement = placement;
  }
  const allDomains = await managedProviderApi("/workers/domains?per_page=100");
  requireTelegram(
    Array.isArray(allDomains) && allDomains.length < 100,
    "worker-domain-pagination-unmodelled",
  );
  const domains = allDomains
    .map(object)
    .filter((row) => row.service === name)
    .map((row) => ({
      hostname: row.hostname,
      service: row.service,
      environment: row.environment,
    }))
    .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
  const queueRows = await managedProviderApi(`/queues?name=${policy.queue}`);
  requireTelegram(
    Array.isArray(queueRows) && queueRows.length === 1,
    "exact-production-queue-required",
  );
  const queue = object(queueRows[0]),
    consumers = await managedProviderApi(`/queues/${queue.queue_id}/consumers`);
  const token = await managedProviderToken();
  const result = await runDeploymentCommand(
    [
      "cf",
      "workers",
      "versions",
      "get",
      before.version,
      "--worker-id",
      name,
      "--include",
      "modules",
    ],
    policy.paths.application,
    AbortSignal.timeout(30_000),
    providerReadEnvironment(token),
  );
  requireTelegram(result.exitCode === 0, "compiled-worker-observation-refused");
  const module = object(JSON.parse(result.stdout));
  requireTelegram(
    module.id === before.version &&
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
  requireTelegram(
    isDeepStrictEqual(await allocation(), before),
    "worker-traffic-moved-during-observation",
  );
  return {
    ...before,
    bindings: bindings(resources.bindings),
    runtime: runtime(resources.script_runtime),
    settings: safeSettings,
    domains,
    subdomain: await managedProviderApi(`${target}/subdomain`),
    queue: telegramQueueConsumer(queue, consumers),
    message: String(object(version.annotations)["workers/message"] ?? ""),
    module_sha256: digestBytes(bytes),
  };
}

import { sha256 as digestBytes } from "./public-post-http-release-core.ts";

/** Dynamic provider IDs are retained in receipts; the reviewed semantic state excludes them. */
export function telegramWorkerState(snapshot: TelegramWorkerSnapshot) {
  return {
    bindings_sha256: digest(snapshot.bindings),
    runtime_sha256: digest(snapshot.runtime),
    settings_sha256: digest(snapshot.settings),
    domains_sha256: digest(snapshot.domains),
    subdomain_sha256: digest(snapshot.subdomain),
    queue_sha256: digest(snapshot.queue),
    message: snapshot.message,
    module_sha256: snapshot.module_sha256,
  };
}
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
  const before = await collectTelegramWorker(worker);
  const initial = phase.startsWith("install-");
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
        assertBound();
        requireTelegram(
          digest(telegramWorkerState(await collectTelegramWorker(worker))) ===
            digest(telegramWorkerState(before)),
          "worker-state-moved-immediately-before-upload",
        );
        exclusiveRecord(policy.paths.operation, `${phase}-upload-attempt.json`, {
          worker: target.name,
          source: policy.source,
          configuration_sha256: configuration.sha256,
          previous_version: before.version,
          before_sha256: digest(telegramWorkerState(before)),
        });
        const group = linuxProcess(process.pid).pgrp;
        requireTelegram(group === process.ppid, "owned-timeout-process-group-required");
        const abort = () => process.kill(-group, "SIGTERM");
        signal?.addEventListener("abort", abort, { once: true });
        try {
          // Installed Wrangler accepts JSON from a file descriptor. Values never enter argv or a disk file.
          const child = Bun.spawn(
            [
              review.execution_tools.node_path,
              resolve(app, "node_modules/wrangler/bin/wrangler.js"),
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
          // Consume and discard provider text; it can contain credentials on failure.
          await Promise.all([
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).arrayBuffer(),
          ]);
          return { exitCode: await child.exited, stdout: "", stderr: "" };
        } finally {
          signal?.removeEventListener("abort", abort);
        }
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
          resolve(app, "node_modules/wrangler/bin/wrangler.js"),
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
    const after = await collectTelegramWorker(worker);
    requireTelegram(
      after.version === result.worker_version_id &&
        after.module_sha256 === target.module &&
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
                  resolve(app, "node_modules/wrangler/bin/wrangler.js"),
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
