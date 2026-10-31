import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runDeploymentCommand } from "../deploy-worker-with-provenance.ts";
import {
  cloudflareAccountId,
  cloudflareApi,
  managedToken,
} from "../rewards-e2e/cloudflare-api.mjs";
import {
  bindings,
  digest,
  isSecret,
  parseServingDeployments,
  runtime,
} from "../worker-binding-drift.ts";
import { readCandidateBindings } from "../worker-deployment-bindings.ts";
import { hash, QUALIFICATION, REPO, SOURCE, TREE } from "./production-database-cutover.ts";

export const ACTUAL_MANIFEST = "9660e32ac1b7186414a5cca7fb0e702fe8ea7f8050791f688b2ab52d53853ec5";
export const CANDIDATE_MANIFEST =
  "3dd9c564eab5e8a9b68dc1ee84bdd1ace4adfbb3843913009b9d47aeee622203";
export const ORDER = ["gateway", "media", "http", "jobs"] as const;
export const targets = {
  gateway: {
    config: "apps/video-source-gateway/wrangler.jsonc",
    worker: "pirate-video-source-gateway-production",
    old: "10972ffc-1d37-431f-abaf-c95830d87d2a",
  },
  media: {
    config: "apps/media-processor-worker/wrangler.jsonc",
    worker: "pirate-media-processor-worker-production",
    old: "3ed0c7ac-b887-4efa-8173-db7f2f547a4b",
  },
  http: {
    config: "apps/http-worker/wrangler.jsonc",
    worker: "pirate-http-worker-production",
    old: "04f260e3-2603-42ed-b1af-661cc8819f01",
  },
  jobs: {
    config: "apps/jobs-worker/wrangler.jsonc",
    worker: "pirate-jobs-worker-production",
    old: "5d99ffd3-b1ab-42ed-8099-1e1e5459555b",
  },
} as const;
export type Component = keyof typeof targets;
export function sourceAndBundle(component: Component) {
  const git = (args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
  assert.equal(git(["rev-parse", "HEAD"]).trim(), SOURCE);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]).trim(), TREE);
  assert.equal(git(["status", "--porcelain"]), "");
  const manifestBytes = readFileSync(
    QUALIFICATION + "mixed-runtime333-source-v1/candidate-manifest.json",
  );
  assert.equal(hash(manifestBytes), CANDIDATE_MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.source_sha, SOURCE);
  assert.equal(manifest.actual_manifest_sha256, ACTUAL_MANIFEST);
  assert.equal(hash(readFileSync(manifest.actual_manifest_path)), ACTUAL_MANIFEST);
  const build = manifest.builds.find((row: any) => row.component === component);
  assert.ok(build);
  assert.equal(build.source_sha, SOURCE);
  assert.equal(hash(readFileSync(build.path)), build.sha256);
  assert.equal(
    hash(readFileSync(REPO + "/" + targets[component].config)),
    build.source_config_sha256,
  );
  return build;
}

function withoutNamespaceId(row: any) {
  if (row.type !== "durable_object_namespace") return row;
  const { namespace_id: _id, ...rest } = row;
  return rest;
}

/** Copied unchanged from the old HTTP recovery module, which binds A5 and is not imported here. */
export function runtimeSettings(input: any) {
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
  const known = new Set([...allowed, "annotations", "bindings"]);
  assert.ok(
    Object.keys(input).every((key) => known.has(key)),
    "Unreviewed HTTP setting",
  );
  const result: any = Object.fromEntries(
    allowed
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, structuredClone(input[key])]),
  );
  result.placement ??= {};
  delete result.placement.last_analyzed_at;
  delete result.placement.status;
  return result;
}

export async function providerJson(args: string[]) {
  const token = await managedToken();
  const result = await runDeploymentCommand(["cf", ...args], REPO, AbortSignal.timeout(30_000), {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length < 48 * 1024 * 1024);
  return JSON.parse(result.stdout);
}

export async function collect(component: Component) {
  const target = targets[component];
  const args = ["--env", "production", "--config", target.config, "--json"];
  const command = async (argv: string[]) => {
    const result = await runDeploymentCommand(argv, REPO, AbortSignal.timeout(30_000));
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length < 2 * 1024 * 1024);
    return result.stdout;
  };
  const deployments = () => command(["bunx", "wrangler", "deployments", "list", ...args]);
  const before = parseServingDeployments(await deployments());
  assert.equal(before.length, 1);
  const [serving] = before;
  assert.ok(serving);
  assert.equal(serving.percentage, 100);
  const version = JSON.parse(
    await command(["bunx", "wrangler", "versions", "view", serving.version_id, ...args]),
  );
  assert.equal(version.id, serving.version_id);
  const actualBindings = bindings(version.resources.bindings);
  for (const row of actualBindings)
    if (row.type === "durable_object_namespace")
      assert.match(String(row.namespace_id ?? ""), /^[a-f0-9]{32}$/u);
  const actualRuntime = runtime(version.resources.script_runtime);
  const candidate = await readCandidateBindings(REPO, target.config, "production");
  assert.equal(candidate.worker_name, target.worker);
  const declared = bindings(candidate.bindings);
  const secrets = actualBindings.filter(isSecret);
  for (const name of candidate.required_secrets)
    assert.ok(secrets.some((row) => row.name === name));
  const effective = bindings([
    ...declared,
    ...secrets.filter((row) => !declared.some((item) => item.name === row.name)),
  ]);
  for (const list of [actualBindings, effective]) {
    assert.equal(
      list.find((row) => row.name === "CONTROL_PLANE")?.id,
      "0c215865d7994c92b940d905f54ece37",
    );
    for (const name of [
      "MEGAPOT_REWARDS_ENABLED",
      "MEGAPOT_V2_SAFE_PILOT_ENABLED",
      "SAFE_POOL_PILOT_ENABLED",
    ])
      assert.ok(
        !list.some((row) => row.name === name) ||
          list.find((row) => row.name === name)?.text === "false",
      );
  }
  const currentSettings = runtimeSettings(
    await cloudflareApi("/workers/scripts/" + target.worker + "/settings"),
  );
  const latest = await cloudflareApi("/workers/scripts/" + target.worker + "/versions");
  assert.equal(latest.items[0].id, version.id, "Latest upload is not serving");
  assert.deepEqual(parseServingDeployments(await deployments()), before);
  const changes = [...new Set([...actualBindings, ...effective].map((row) => row.name))]
    .sort()
    .flatMap((name) => {
      const old = actualBindings.find((row) => row.name === name),
        next = effective.find((row) => row.name === name);
      const oldHash = old ? digest(withoutNamespaceId(old)) : null,
        nextHash = next ? digest(withoutNamespaceId(next)) : null;
      return oldHash === nextHash ? [] : [{ name, before_sha256: oldHash, after_sha256: nextHash }];
    });
  return {
    version: version.id,
    message: version.annotations?.["workers/message"] ?? null,
    baseline_sha256: digest({ bindings: actualBindings, runtime: actualRuntime }),
    candidate_sha256: digest({
      bindings: effective.map(withoutNamespaceId),
      runtime: candidate.runtime,
    }),
    actual_comparable_sha256: digest({
      bindings: actualBindings.map(withoutNamespaceId),
      runtime: actualRuntime,
    }),
    settings_sha256: digest(currentSettings),
    changes,
    namespaces: actualBindings.filter((row) => row.type === "durable_object_namespace"),
  };
}
