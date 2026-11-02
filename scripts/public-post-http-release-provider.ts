import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  deployWorkerWithProvenance,
  runDeploymentCommand,
} from "./deploy-worker-with-provenance.ts";
import { linuxProcess } from "./production-release/production-linux-process-bound.ts";
import {
  deploymentChildEnvironment,
  injectedProductionUrls,
  providerReadEnvironment,
  safeToolEnvironment,
  wranglerEnvironment,
} from "./production-release/production-managed-environment.ts";
import { exclusiveRecord } from "./production-release/production-operation-evidence.ts";
import {
  HTTP_RELEASE,
  type HttpReleaseIo,
  type HttpReview,
  type HttpSnapshot,
  normalizedVerifier,
  requireRelease,
  sha256,
  type UploadResult,
} from "./public-post-http-release-core.ts";
import {
  HTTP_PATHS,
  qualifiedHttpCandidate,
  verifyFixedPublicPostSource,
} from "./public-post-http-release-source.ts";
import { withRewardsBindingDeployment } from "./rewards-binding-deploy-preflight.ts";
import { cloudflareApi, managedToken, runProviderClient } from "./rewards-e2e/cloudflare-api.mjs";
import { withServingFunctionPrivilegesDeployment } from "./serving-function-privileges-preflight.ts";
import { prepareSongFundingBindingAdmission } from "./song-funding-binding-admission.ts";
import { withTelegramActivationDeployment } from "./telegram-activation-preflight.ts";
import {
  bindings,
  type CandidateBindings,
  digest,
  isSecret,
  runtime,
} from "./worker-binding-drift.ts";
import { readCandidateBindings } from "./worker-deployment-bindings.ts";

const app = HTTP_PATHS.application,
  target = `/workers/scripts/${HTTP_RELEASE.worker}`;
const nodeCli = resolve(app, "node_modules/wrangler/bin/wrangler.js");
export const publicPostProviderEnvironment = (
  input?: Readonly<Record<string, string | undefined>>,
): Record<string, string> => ({
  ...safeToolEnvironment(input),
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
});
const providerToken = async () => {
  const token = await managedToken({
    environment: publicPostProviderEnvironment(),
    renew: () => runProviderClient({ environment: publicPostProviderEnvironment() }),
  });
  requireRelease(
    typeof token === "string" && token.length > 0,
    "managed-provider-login-unavailable",
  );
  return token;
};
const providerApi = (path: string) => cloudflareApi(path, {}, { token: providerToken });
const withoutNamespace = (row: ReturnType<typeof bindings>[number]) => {
  if (row.type !== "durable_object_namespace") return normalizedVerifier(row);
  const { namespace_id: _id, ...rest } = row;
  return normalizedVerifier(rest);
};
/** Same maintained normalization as the accepted HTTP baseline observation. */
function settings(input: Record<string, unknown>) {
  const allowed = [
    "compatibility_date",
    "compatibility_flags",
    "usage_model",
    "limits",
    "logpush",
    "observability",
    "placement",
    "tail_consumers",
    "tags",
  ];
  requireRelease(
    Object.keys(input).every((key) => [...allowed, "annotations", "bindings"].includes(key)),
    "unmodelled-worker-setting",
  );
  const result = Object.fromEntries(
    allowed
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, structuredClone(input[key])]),
  );
  const placement = result.placement as Record<string, unknown> | undefined;
  result.placement = placement ?? {};
  if (placement) {
    delete placement.last_analyzed_at;
    delete placement.status;
  }
  return result;
}
async function allocation() {
  const result = await providerApi(`${target}/deployments`);
  const row = result.deployments?.[0];
  requireRelease(
    row && row.versions?.length === 1 && row.versions[0].percentage === 100,
    "one-full-traffic-version-required",
  );
  return { deployment: String(row.id), version: String(row.versions[0].version_id) };
}
export function publicPostBindingProposal(
  input: readonly ReturnType<typeof bindings>[number][],
  candidate: CandidateBindings,
) {
  const actual = bindings(input),
    secrets = actual.filter(isSecret),
    declared = bindings(candidate.bindings);
  const verifierActual = actual.find((row) => row.name === "HNS_OWNER_VERIFIER");
  const verifierDeclared = declared.find((row) => row.name === "HNS_OWNER_VERIFIER");
  requireRelease(verifierActual && verifierDeclared, "verifier-binding-missing");
  for (const name of candidate.required_secrets) {
    requireRelease(
      secrets.some((row) => row.name === name),
      "required-existing-secret-missing",
    );
  }
  const effective = bindings([
    ...declared,
    ...secrets.filter((row) => !declared.some((item) => item.name === row.name)),
  ]);
  requireRelease(
    digest(actual.map(withoutNamespace)) === digest(effective.map(withoutNamespace)),
    "candidate-bindings-differ",
  );
  return { effective, verifierActual, verifierDeclared };
}
async function collect(): Promise<HttpSnapshot> {
  const before = await allocation();
  const version = await providerApi(`${target}/versions/${before.version}`);
  requireRelease(version.id === before.version, "provider-version-differs");
  const actual = bindings(version.resources.bindings),
    actualRuntime = runtime(version.resources.script_runtime);
  const candidate = await readCandidateBindings(app, HTTP_RELEASE.config, "production");
  requireRelease(candidate.worker_name === HTTP_RELEASE.worker, "candidate-target-differs");
  const { effective, verifierActual, verifierDeclared } = publicPostBindingProposal(
    actual,
    candidate,
  );
  const rawDomains = await providerApi("/workers/domains?per_page=100");
  requireRelease(
    Array.isArray(rawDomains) && rawDomains.length < 100,
    "domain-pagination-required",
  );
  const domains = rawDomains
    .filter((row) => row.service === HTTP_RELEASE.worker)
    .map((row) => ({ hostname: row.hostname, service: row.service, environment: row.environment }))
    .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
  requireRelease(
    isDeepStrictEqual(domains, [
      { hostname: "api-next.pirate.sc", service: HTTP_RELEASE.worker, environment: "production" },
      {
        hostname: "hns-community-api.pirate.sc",
        service: HTTP_RELEASE.worker,
        environment: "production",
      },
    ]),
    "baseline-domains-differ",
  );
  const subdomain = await providerApi(`${target}/subdomain`);
  requireRelease(
    isDeepStrictEqual(subdomain, { enabled: true, previews_enabled: false }),
    "baseline-subdomain-differs",
  );
  const liveSettings = settings(await providerApi(`${target}/settings`));
  const latest = await providerApi(`${target}/versions`);
  requireRelease(typeof latest.items?.[0]?.id === "string", "latest-version-missing");
  requireRelease(isDeepStrictEqual(await allocation(), before), "traffic-moved-during-snapshot");
  return {
    ...before,
    message: String(version.annotations?.["workers/message"] ?? ""),
    latest: latest.items[0].id,
    binding_runtime_sha256: digest({
      bindings: actual.map(normalizedVerifier),
      runtime: actualRuntime,
    }),
    settings_sha256: digest(liveSettings),
    actual_comparable_sha256: digest({
      bindings: actual.map(withoutNamespace),
      runtime: actualRuntime,
    }),
    declared_comparable_sha256: digest({
      bindings: effective.map(withoutNamespace),
      runtime: candidate.runtime,
    }),
    verifier_representations: { actual: verifierActual, declared: verifierDeclared },
    namespaces: actual.filter((row) => row.type === "durable_object_namespace"),
    domains,
    subdomain,
  };
}
async function modules(versionId: string) {
  const token = await providerToken();
  const result = await runDeploymentCommand(
    [
      "cf",
      "workers",
      "versions",
      "get",
      versionId,
      "--worker-id",
      HTTP_RELEASE.worker,
      "--include",
      "modules",
    ],
    app,
    AbortSignal.timeout(30_000),
    providerReadEnvironment(token),
  );
  requireRelease(result.exitCode === 0, "compiled-module-read-refused");
  const version = JSON.parse(result.stdout);
  requireRelease(
    version.id === versionId &&
      version.main_module === "index.js" &&
      version.modules?.length === 1 &&
      version.modules[0].name === "index.js",
    "module-inventory-differs",
  );
  const encoded = version.modules[0].content_base64;
  requireRelease(typeof encoded === "string", "compiled-module-bytes-missing");
  const bytes = Buffer.from(encoded, "base64");
  requireRelease(
    bytes.toString("base64") === encoded && sha256(bytes) === HTTP_RELEASE.module,
    "serving-compiled-module-differs",
  );
  const declared = await readCandidateBindings(app, HTTP_RELEASE.config, "production");
  requireRelease(
    version.compatibility_date === declared.runtime.compatibility_date &&
      isDeepStrictEqual(
        [...(version.compatibility_flags ?? [])].sort(),
        [...(declared.runtime.compatibility_flags as string[])].sort(),
      ),
    "module-compatibility-differs",
  );
}
function record(name: string, value: unknown) {
  requireRelease(/^[a-z0-9-]+\.json$/.test(name), "invalid-evidence-name");
  mkdirSync(HTTP_PATHS.evidence, { recursive: true, mode: 0o700 });
  exclusiveRecord(HTTP_PATHS.evidence, name, value);
}
function read(name: string): unknown {
  const path = resolve(HTTP_PATHS.evidence, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
async function managedGuards<T>(action: (runtimeUrl: string) => Promise<T>) {
  const urls = injectedProductionUrls();
  const selected = {
    RUNTIME_POSTGRES_URL: urls.runtime,
    CONTROL_PLANE_POSTGRES_RUNTIME_URL: urls.runtime,
    CONTROL_PLANE_POSTGRES_ADMIN_URL: urls.owner,
  };
  const previous = new Map(
    [...Object.keys(selected), "CLOUDFLARE_API_TOKEN"].map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, selected);
    delete process.env.CLOUDFLARE_API_TOKEN;
    return await action(urls.runtime);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
/** Abort the verified owned timeout group, including uploader descendants, not merely its parent. */
async function uploadCommand(
  review: HttpReview,
  argv: readonly string[],
  signal: AbortSignal | undefined,
  assertBound: () => void,
): Promise<UploadResult> {
  assertBound();
  requireRelease(!signal?.aborted, "control-connection-lost-before-upload");
  const group = linuxProcess(process.pid).pgrp;
  requireRelease(group === process.ppid, "owned-timeout-group-required");
  const abort = () => process.kill(-group, "SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await runDeploymentCommand(
      [review.execution_tools.node_path, nodeCli, ...argv],
      app,
      undefined,
      { ...wranglerEnvironment(), WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
export function realHttpReleaseIo(
  review?: HttpReview,
  assertBound: () => void = () => {
    requireRelease(false, "bounded-child-required");
  },
): HttpReleaseIo {
  return {
    now: () => Date.now(),
    candidate: () => qualifiedHttpCandidate(review),
    collect,
    read,
    record,
    modules,
    guardedUpload: async (commit) => {
      requireRelease(review, "independent-review-required");
      assertBound();
      await managedGuards(async (runtimeUrl) => {
        const runner: typeof runDeploymentCommand = async (command, cwd, signal) => {
          requireRelease(cwd === app, "unexpected-command-root");
          const expected = [
            "bunx",
            "wrangler",
            "deploy",
            "--env",
            "production",
            "--config",
            HTTP_RELEASE.config,
            "--message",
            `git:${HTTP_RELEASE.source}`,
          ];
          if (isDeepStrictEqual(command, expected)) {
            return commit(() =>
              uploadCommand(
                review,
                [
                  "deploy",
                  resolve(HTTP_PATHS.packet, "bundle/index.js"),
                  "--no-bundle",
                  "--env",
                  "production",
                  "--config",
                  HTTP_RELEASE.config,
                  "--message",
                  `git:${HTTP_RELEASE.source}`,
                ],
                signal,
                assertBound,
              ),
            );
          }
          const versions = [
            "bunx",
            "wrangler",
            "versions",
            "list",
            "--env",
            "production",
            "--config",
            HTTP_RELEASE.config,
            "--json",
          ];
          if (isDeepStrictEqual(command, versions)) {
            return runDeploymentCommand(
              [review.execution_tools.node_path, nodeCli, ...command.slice(2)],
              app,
              signal,
              {
                ...wranglerEnvironment(),
                WRANGLER_SEND_METRICS: "false",
                WRANGLER_WRITE_LOGS: "false",
              },
            );
          }
          requireRelease(
            isDeepStrictEqual(command, ["bun", "scripts/telegram-activation-preflight.ts"]),
            "unreviewed-child-command",
          );
          return runDeploymentCommand(
            [review.execution_tools.bun_path, ...command.slice(1)],
            app,
            signal,
            deploymentChildEnvironment(command, runtimeUrl),
          );
        };
        await deployWorkerWithProvenance(
          app,
          {
            configPath: HTTP_RELEASE.config,
            environment: "production",
            sourceRef: HTTP_RELEASE.source,
            acceptedMainRef: "origin/main",
          },
          runner,
          () => {},
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          verifyFixedPublicPostSource,
        );
      });
    },
    rollback: async (version) => {
      requireRelease(review && version === HTTP_RELEASE.baseline, "fixed-rollback-target-required");
      assertBound();
      return managedGuards(async () => {
        const funding = await prepareSongFundingBindingAdmission(
          app,
          HTTP_RELEASE.config,
          "production",
          HTTP_RELEASE.source,
        );
        return withServingFunctionPrivilegesDeployment(app, HTTP_RELEASE.config, () =>
          withTelegramActivationDeployment(app, HTTP_RELEASE.config, "production", () =>
            withRewardsBindingDeployment(app, HTTP_RELEASE.config, "production", async (signal) => {
              await funding?.recheck();
              return uploadCommand(
                review,
                [
                  "rollback",
                  version,
                  "--env",
                  "production",
                  "--config",
                  HTTP_RELEASE.config,
                  "--yes",
                  "--message",
                  "Public post HTTP baseline recovery",
                ],
                signal,
                assertBound,
              );
            }),
          ),
        );
      });
    },
  };
}
