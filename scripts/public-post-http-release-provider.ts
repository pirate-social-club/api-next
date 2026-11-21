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
  type HttpReleaseIo,
  type HttpReview,
  type HttpSnapshot,
  normalizedVerifier,
  requireRelease,
  sha256,
  type UploadResult,
} from "./public-post-http-release-core.ts";
import {
  type HttpSourcePolicy,
  PUBLIC_POST_SOURCE,
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
async function allocation(policy: HttpSourcePolicy) {
  const target = `/workers/scripts/${policy.release.worker}`;
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
export function publicPostBindingObservation(
  input: readonly ReturnType<typeof bindings>[number][],
  candidate: CandidateBindings,
  recovery: boolean,
) {
  const actual = bindings(input);
  const declared = bindings(candidate.bindings);
  const observed = {
    effective: bindings([
      ...declared,
      ...actual.filter(isSecret).filter((row) => !declared.some((item) => item.name === row.name)),
    ]),
    verifierActual: actual.find((row) => row.name === "HNS_OWNER_VERIFIER") ?? null,
    verifierDeclared: declared.find((row) => row.name === "HNS_OWNER_VERIFIER"),
  };
  requireRelease(observed.verifierDeclared, "candidate-verifier-binding-missing");
  const { effective, verifierActual } = recovery
    ? observed
    : publicPostBindingProposal(actual, candidate);
  const normalize = (row: ReturnType<typeof bindings>[number]) => {
    if (
      recovery &&
      row.name === "HNS_OWNER_VERIFIER" &&
      (row.type !== "service" ||
        row.service !== "pirate-hns-owner-verifier-production" ||
        (row.environment !== undefined && row.environment !== "production"))
    )
      return row;
    return normalizedVerifier(row);
  };
  const comparable = (row: ReturnType<typeof bindings>[number]) => {
    const { namespace_id, ...rest } = row;
    return normalize(row.type === "durable_object_namespace" ? rest : row);
  };
  return {
    effective,
    verifierActual,
    verifierDeclared: observed.verifierDeclared,
    normalize,
    comparable,
  };
}
async function collect(recovery: boolean, policy: HttpSourcePolicy): Promise<HttpSnapshot> {
  const app = policy.paths.application,
    target = `/workers/scripts/${policy.release.worker}`;
  const before = await allocation(policy);
  const version = await providerApi(`${target}/versions/${before.version}`);
  requireRelease(version.id === before.version, "provider-version-differs");
  const actual = bindings(version.resources.bindings),
    actualRuntime = runtime(version.resources.script_runtime);
  const candidate = await readCandidateBindings(app, policy.release.config, "production");
  requireRelease(candidate.worker_name === policy.release.worker, "candidate-target-differs");
  const { effective, verifierActual, verifierDeclared, normalize, comparable } =
    publicPostBindingObservation(actual, candidate, recovery);
  const rawDomains = await providerApi("/workers/domains?per_page=100");
  requireRelease(
    Array.isArray(rawDomains) && rawDomains.length < 100,
    "domain-pagination-required",
  );
  const domains = rawDomains
    .filter((row) => row.service === policy.release.worker)
    .map((row) => ({ hostname: row.hostname, service: row.service, environment: row.environment }))
    .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
  requireRelease(
    recovery ||
      isDeepStrictEqual(domains, [
        {
          hostname: "api-next.pirate.sc",
          service: policy.release.worker,
          environment: "production",
        },
        {
          hostname: "hns-community-api.pirate.sc",
          service: policy.release.worker,
          environment: "production",
        },
      ]),
    "baseline-domains-differ",
  );
  const subdomain = await providerApi(`${target}/subdomain`);
  requireRelease(
    recovery || isDeepStrictEqual(subdomain, { enabled: true, previews_enabled: false }),
    "baseline-subdomain-differs",
  );
  const liveSettings = settings(await providerApi(`${target}/settings`));
  const latest = await providerApi(`${target}/versions`);
  requireRelease(typeof latest.items?.[0]?.id === "string", "latest-version-missing");
  requireRelease(
    isDeepStrictEqual(await allocation(policy), before),
    "traffic-moved-during-snapshot",
  );
  return {
    ...before,
    message: String(version.annotations?.["workers/message"] ?? ""),
    latest: latest.items[0].id,
    binding_runtime_sha256: digest({
      bindings: actual.map(normalize),
      runtime: actualRuntime,
    }),
    settings_sha256: digest(liveSettings),
    actual_comparable_sha256: digest({
      bindings: actual.map(comparable),
      runtime: actualRuntime,
    }),
    declared_comparable_sha256: digest({
      bindings: effective.map(comparable),
      runtime: candidate.runtime,
    }),
    verifier_representations: { actual: verifierActual, declared: verifierDeclared },
    namespaces: actual.filter((row) => row.type === "durable_object_namespace"),
    domains,
    subdomain,
  };
}
async function modules(versionId: string, policy: HttpSourcePolicy) {
  const app = policy.paths.application;
  const token = await providerToken();
  const result = await runDeploymentCommand(
    [
      "cf",
      "workers",
      "versions",
      "get",
      versionId,
      "--worker-id",
      policy.release.worker,
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
    bytes.toString("base64") === encoded && sha256(bytes) === policy.release.module,
    "serving-compiled-module-differs",
  );
  const declared = await readCandidateBindings(app, policy.release.config, "production");
  requireRelease(
    version.compatibility_date === declared.runtime.compatibility_date &&
      isDeepStrictEqual(
        [...(version.compatibility_flags ?? [])].sort(),
        [...(declared.runtime.compatibility_flags as string[])].sort(),
      ),
    "module-compatibility-differs",
  );
}
function record(name: string, value: unknown, policy: HttpSourcePolicy) {
  requireRelease(/^[a-z0-9-]+\.json$/.test(name), "invalid-evidence-name");
  mkdirSync(policy.paths.evidence, { recursive: true, mode: 0o700 });
  exclusiveRecord(policy.paths.evidence, name, value);
}
function read(name: string, policy: HttpSourcePolicy): unknown {
  const path = resolve(policy.paths.evidence, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
export async function managedGuards<T>(action: (runtimeUrl: string) => Promise<T>) {
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
  policy: HttpSourcePolicy,
): Promise<UploadResult> {
  const app = policy.paths.application,
    nodeCli = resolve(app, "node_modules/wrangler/bin/wrangler.js");
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
  policy: HttpSourcePolicy = PUBLIC_POST_SOURCE,
): HttpReleaseIo {
  const app = policy.paths.application,
    nodeCli = resolve(app, "node_modules/wrangler/bin/wrangler.js");
  return {
    now: () => Date.now(),
    candidate: () => qualifiedHttpCandidate(review, policy),
    collect: () => collect(false, policy),
    observe: () => collect(true, policy),
    read: (name) => read(name, policy),
    record: (name, value) => record(name, value, policy),
    modules: (version) => modules(version, policy),
    guardedUpload: async (commit) => {
      requireRelease(review, "independent-review-required");
      assertBound();
      return managedGuards(async (runtimeUrl) => {
        const runner: typeof runDeploymentCommand = async (command, cwd, signal) => {
          requireRelease(cwd === app, "unexpected-command-root");
          const expected = [
            "bunx",
            "wrangler",
            "deploy",
            "--env",
            "production",
            "--config",
            policy.release.config,
            "--message",
            `git:${policy.release.source}`,
          ];
          if (isDeepStrictEqual(command, expected)) {
            return commit(() =>
              uploadCommand(
                review,
                [
                  "deploy",
                  resolve(policy.paths.packet, "bundle/index.js"),
                  "--no-bundle",
                  "--env",
                  "production",
                  "--config",
                  policy.release.config,
                  "--message",
                  `git:${policy.release.source}`,
                ],
                signal,
                assertBound,
                policy,
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
            policy.release.config,
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
        const receipt = await deployWorkerWithProvenance(
          app,
          {
            configPath: policy.release.config,
            environment: "production",
            sourceRef: policy.release.source,
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
          (root, input) => verifyFixedPublicPostSource(root, input, policy),
        );
        return { version: receipt.worker_version_id };
      });
    },
    rollback: async (version, recheck) => {
      requireRelease(
        review && version === policy.release.baseline,
        "fixed-rollback-target-required",
      );
      assertBound();
      return managedGuards(async () => {
        const funding = await prepareSongFundingBindingAdmission(
          app,
          policy.release.config,
          "production",
          policy.release.source,
        );
        return withServingFunctionPrivilegesDeployment(app, policy.release.config, () =>
          withTelegramActivationDeployment(app, policy.release.config, "production", () =>
            withRewardsBindingDeployment(
              app,
              policy.release.config,
              "production",
              async (signal) => {
                await funding?.recheck();
                await recheck();
                return uploadCommand(
                  review,
                  [
                    "rollback",
                    version,
                    "--env",
                    "production",
                    "--config",
                    policy.release.config,
                    "--yes",
                    "--message",
                    policy.recoveryMessage,
                  ],
                  signal,
                  assertBound,
                  policy,
                );
              },
            ),
          ),
        );
      });
    },
  };
}
