import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { bound, BROWSER_PLAN_FILE, DANCE_PLAN_FILE, executorSha256 as databaseExecutorSha256, hash, liveFacts, managedUrls, matches, OPERATION_DIR, QUALIFICATION, REPO, RUNTIME, save, SOURCE, TREE, ownerRead, record, recordDigest, assertDatabasePlansCommitted } from "./production-database-cutover.ts";
import { deployWorkerWithProvenance, runDeploymentCommand } from "../deploy-worker-with-provenance.ts";
import { readCandidateBindings } from "../worker-deployment-bindings.ts";
import { bindings, digest, isSecret, parseServingDeployments, runtime } from "../worker-binding-drift.ts";
import { cloudflareApi, cloudflareAccountId, managedToken } from "../rewards-e2e/cloudflare-api.mjs";

import { acceptedExecutor, evidenceDiagnostics, resolution } from "./production-operation-evidence.ts";
import { admitted as validateAdmission, assertReviewedBinding } from "./production-release-admission.ts";
export { assertReviewedBinding };

export const ACTUAL_MANIFEST = "9660e32ac1b7186414a5cca7fb0e702fe8ea7f8050791f688b2ab52d53853ec5";
export const CANDIDATE_MANIFEST = "3dd9c564eab5e8a9b68dc1ee84bdd1ace4adfbb3843913009b9d47aeee622203";
export const ORDER = ["gateway", "media", "http", "jobs"] as const;
const targets = {
  gateway: { config: "apps/video-source-gateway/wrangler.jsonc", worker: "pirate-video-source-gateway-production", old: "10972ffc-1d37-431f-abaf-c95830d87d2a" },
  media: { config: "apps/media-processor-worker/wrangler.jsonc", worker: "pirate-media-processor-worker-production", old: "3ed0c7ac-b887-4efa-8173-db7f2f547a4b" },
  http: { config: "apps/http-worker/wrangler.jsonc", worker: "pirate-http-worker-production", old: "04f260e3-2603-42ed-b1af-661cc8819f01" },
  jobs: { config: "apps/jobs-worker/wrangler.jsonc", worker: "pirate-jobs-worker-production", old: "5d99ffd3-b1ab-42ed-8099-1e1e5459555b" },
} as const;
export type Component = keyof typeof targets;
const self = () => hash(readFileSync(new URL(import.meta.url)));

export async function withManagedGuardEnvironment<T>(urls: { owner: string; runtime: string }, action: () => Promise<T>): Promise<T> {
  const selected = { RUNTIME_POSTGRES_URL: urls.runtime, CONTROL_PLANE_POSTGRES_RUNTIME_URL: urls.runtime, CONTROL_PLANE_POSTGRES_ADMIN_URL: urls.owner };
  const keys = [...Object.keys(selected), "CLOUDFLARE_API_TOKEN"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, selected);
    delete process.env.CLOUDFLARE_API_TOKEN;
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function sourceAndBundle(component: Component) {
  const git = (args: string[]) => execFileSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
  assert.equal(git(["rev-parse", "HEAD"]).trim(), SOURCE);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]).trim(), TREE);
  assert.equal(git(["status", "--porcelain"]), "");
  const manifestBytes = readFileSync(QUALIFICATION + "mixed-runtime333-source-v1/candidate-manifest.json");
  assert.equal(hash(manifestBytes), CANDIDATE_MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.source_sha, SOURCE);
  assert.equal(manifest.actual_manifest_sha256, ACTUAL_MANIFEST);
  assert.equal(hash(readFileSync(manifest.actual_manifest_path)), ACTUAL_MANIFEST);
  const build = manifest.builds.find((row: any) => row.component === component);
  assert.ok(build);
  assert.equal(build.source_sha, SOURCE);
  assert.equal(hash(readFileSync(build.path)), build.sha256);
  assert.equal(hash(readFileSync(REPO + "/" + targets[component].config)), build.source_config_sha256);
  return build;
}

function withoutNamespaceId(row: any) {
  if (row.type !== "durable_object_namespace") return row;
  const { namespace_id: _id, ...rest } = row;
  return rest;
}

/** Copied unchanged from the old HTTP recovery module, which binds A5 and is not imported here. */
export function runtimeSettings(input: any) {
  const allowed = ["compatibility_date","compatibility_flags","usage_model","limits","logpush","observability","placement","tail_consumers","tags"];
  const known = new Set([...allowed,"annotations","bindings"]);
  assert.ok(Object.keys(input).every(key=>known.has(key)),"Unreviewed HTTP setting");
  const result:any = Object.fromEntries(allowed.filter(key=>input[key]!==undefined).map(key=>[key,structuredClone(input[key])]));
  result.placement ??= {};
  delete result.placement.last_analyzed_at;
  delete result.placement.status;
  return result;
}

async function providerJson(args: string[]) {
  const token = await managedToken();
  const result = await runDeploymentCommand(["cf", ...args], REPO, AbortSignal.timeout(30_000), {
    ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length < 48 * 1024 * 1024);
  return JSON.parse(result.stdout);
}

async function collect(component: Component) {
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
  const [serving] = before; assert.ok(serving);
  assert.equal(serving.percentage, 100);
  const version = JSON.parse(await command(["bunx", "wrangler", "versions", "view", serving.version_id, ...args]));
  assert.equal(version.id, serving.version_id);
  const actualBindings = bindings(version.resources.bindings);
  for (const row of actualBindings)
    if (row.type === "durable_object_namespace") assert.match(String(row.namespace_id ?? ""), /^[a-f0-9]{32}$/u);
  const actualRuntime = runtime(version.resources.script_runtime);
  const candidate = await readCandidateBindings(REPO, target.config, "production");
  assert.equal(candidate.worker_name, target.worker);
  const declared = bindings(candidate.bindings);
  const secrets = actualBindings.filter(isSecret);
  for (const name of candidate.required_secrets) assert.ok(secrets.some(row => row.name === name));
  const effective = bindings([...declared, ...secrets.filter(row => !declared.some(item => item.name === row.name))]);
  for (const list of [actualBindings, effective]) {
    assert.equal(list.find(row => row.name === "CONTROL_PLANE")?.id, "0c215865d7994c92b940d905f54ece37");
    for (const name of ["MEGAPOT_REWARDS_ENABLED", "MEGAPOT_V2_SAFE_PILOT_ENABLED", "SAFE_POOL_PILOT_ENABLED"])
      assert.ok(!list.some(row => row.name === name) || list.find(row => row.name === name)?.text === "false");
  }
  const currentSettings = runtimeSettings(await cloudflareApi("/workers/scripts/" + target.worker + "/settings"));
  const latest = await cloudflareApi("/workers/scripts/" + target.worker + "/versions");
  assert.equal(latest.items[0].id, version.id, "Latest upload is not serving");
  assert.deepEqual(parseServingDeployments(await deployments()), before);
  const changes = [...new Set([...actualBindings, ...effective].map(row => row.name))].sort().flatMap(name => {
    const old = actualBindings.find(row => row.name === name), next = effective.find(row => row.name === name);
    const oldHash = old ? digest(withoutNamespaceId(old)) : null, nextHash = next ? digest(withoutNamespaceId(next)) : null;
    return oldHash === nextHash ? [] : [{ name, before_sha256: oldHash, after_sha256: nextHash }];
  });
  return {
    version: version.id, message: version.annotations?.["workers/message"] ?? null,
    baseline_sha256: digest({ bindings: actualBindings, runtime: actualRuntime }),
    candidate_sha256: digest({ bindings: effective.map(withoutNamespaceId), runtime: candidate.runtime }),
    actual_comparable_sha256: digest({ bindings: actualBindings.map(withoutNamespaceId), runtime: actualRuntime }),
    settings_sha256: digest(currentSettings), changes,
    namespaces: actualBindings.filter(row => row.type === "durable_object_namespace"),
  };
}

async function verifyCandidate(component: Component, before: any, reviewPath: string) {
  const target = targets[component], build = deps.sourceAndBundle(component);
  const after = await deps.collect(component);
  assert.equal(after.message, "git:" + SOURCE);
  assert.equal(after.actual_comparable_sha256, before.candidate_sha256);
  for (const row of before.namespaces) assert.deepEqual(after.namespaces.find((item: any) => item.name === row.name), row);
  const version = await deps.providerJson(["workers", "versions", "get", after.version, "--worker-id", target.worker, "--include", "modules"]);
  assert.equal(version.id, after.version);
  assert.equal(version.modules.length, 1);
  assert.equal(version.modules[0].name, build.path.split("/").at(-1));
  assert.equal(Buffer.from(version.modules[0].content_base64, "base64").toString("base64"), version.modules[0].content_base64);
  assert.equal(hash(Buffer.from(version.modules[0].content_base64, "base64")), build.sha256);
  assert.equal(version.compatibility_date, build.compatibility_date);
  assert.deepEqual(version.compatibility_flags, build.compatibility_flags);
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  assert.equal(after.settings_sha256, review.worker_bindings[component].candidate_settings_sha256);
  const confirmed = await deps.collect(component);
  assert.deepEqual(confirmed, after);
  return after;
}

const realDeps = {
  sourceAndBundle: (component: Component) => sourceAndBundle(component),
  live: liveFacts,
  admitted: (mode = "apply", requireOuter = true) => validateAdmission(mode, self(), requireOuter),
  managedUrls,
  collect,
  providerJson,
  readCandidateBindings,
  deploy: deployWorkerWithProvenance,
  runDeploymentCommand,
  now: () => Date.now(),
};
// Live execution always uses these maintained dependencies; there is no alternate runtime adapter.
const deps = realDeps;

const readbackName = (component: Component) => "worker-" + component + "-readback.json";
const markerName = (component: Component) => "worker-" + component + "-upload-attempt.json";
function selectedWorker(component: Component, review: any) {
  let selected = { marker: markerName(component), readback: readbackName(component), key: "worker-" + component };
  const continuations = review.worker_continuations?.[component] ?? [];
  assert.ok(Array.isArray(continuations) && continuations.length <= 4, "Unbounded Worker continuation");
  for (const continuation of continuations) {
    assert.ok(record(selected.marker), "Worker continuation lacks predecessor attempt");
    assert.equal(continuation.predecessor_attempt_sha256, recordDigest(selected.marker));
    assert.equal(resolution(selected.key, selected.marker, review)?.conclusion, "baseline_unchanged", "Worker continuation requires reviewed proof of unchanged baseline");
    assert.equal(continuation.accepted, true); assert.equal(continuation.reviewer_role, "independent_reviewer"); assert.deepEqual(continuation.findings, []);
    const key = "worker-" + component + "-" + continuation.predecessor_attempt_sha256;
    selected = { marker: key + "-attempt.json", readback: key + "-readback.json", key };
  }
  return selected;
}

const candidateIdentity = (component: Component, review: any) => ({ source: SOURCE, component,
  module_sha256: deps.sourceAndBundle(component).sha256, candidate_sha256: review.worker_bindings[component].candidate_sha256,
  candidate_settings_sha256: review.worker_bindings[component].candidate_settings_sha256 });

function validateAttempt(component: Component, attempt: any, review: any) {
  const selected = selectedWorker(component, review), resolved = resolution(selected.key, selected.marker, review);
  assert.notEqual(resolved?.conclusion, "baseline_unchanged", "Reviewed worker abort; explicit continuation is required");
  matches(attempt, { source: SOURCE, component }, selected.marker); acceptedExecutor(attempt, self(), review, component);
  assert.equal(attempt.before.version, targets[component].old);
  const expected = candidateIdentity(component, review), binding = review.worker_bindings[component];
  if (resolved?.conclusion === "candidate_verified") {
    // A new independent resolution may correct review metadata, never source/module identity or the retained attempt.
    matches(resolved.candidate_identity, expected, "resolved candidate identity");
    assert.equal(attempt.candidate_identity.source, expected.source); assert.equal(attempt.candidate_identity.module_sha256, expected.module_sha256);
    return { ...attempt.before, candidate_sha256: binding.candidate_sha256 };
  }
  matches(attempt.candidate_identity, expected, component + " candidate identity");
  for (const key of ["baseline_sha256", "candidate_sha256", "settings_sha256", "changes"]) assert.deepEqual(attempt.before[key], binding[key]);
  return attempt.before;
}
function validateReadback(component: Component, review: any) {
  const selected = selectedWorker(component, review);
  const attempt = record(selected.marker), readback = record(selected.readback);
  assert.ok(attempt || !readback, "Worker readback has no upload attempt");
  if (!readback) return false;
  validateAttempt(component, attempt, review);
  acceptedExecutor(readback, self(), review, selected.readback);
  matches(readback, { source: SOURCE, component, accepted: true, attempt_sha256: recordDigest(selected.marker) }, selected.readback);
  matches(readback.candidate_identity, candidateIdentity(component, review), component + " readback identity");
  assert.equal(readback.after.actual_comparable_sha256, review.worker_bindings[component].candidate_sha256);
  assert.equal(readback.after.settings_sha256, review.worker_bindings[component].candidate_settings_sha256);
  return true;
}

/** Verified immutable candidate identities survive a renewed review; foreign candidates never do. */
export function assertOrder(component: Component, review: any) {
  const expected = { accepted: true, unresolved: false, ledger: 333, source: SOURCE, runtime: RUNTIME,
    dance_plan_file_sha256: DANCE_PLAN_FILE, browser_plan_file_sha256: BROWSER_PLAN_FILE };
  assert.ok(Number.isInteger(review.database_verification_max_age_ms) && review.database_verification_max_age_ms > 0 && review.database_verification_max_age_ms <= 300_000);
  const verified = readdirSync(OPERATION_DIR).filter(name => name.startsWith("database-runtime-verification-")).some(name => {
    const row = record(name);
    if (!row || !Object.entries(expected).every(([key, value]) => row[key] === value)) return false;
    acceptedExecutor(row, databaseExecutorSha256(), review, name);
    const observed = Date.parse(row.at), now = deps.now();
    return Number.isFinite(observed) && observed <= now && now - observed <= review.database_verification_max_age_ms;
  });
  assert.ok(verified, "Fresh database and grant preconditions are not verified");
  assertDatabasePlansCommitted(review);
  for (const earlier of ORDER.slice(0, ORDER.indexOf(component))) assert.ok(validateReadback(earlier, review), "Worker order refused");
}

/** The separately owned website executor requires all four backend completions, not just jobs upload admission. */
export function assertWebsiteBackendPrerequisites(review: any) {
  assertOrder("jobs", review);
  assert.ok(validateReadback("jobs", review), "Final backend Worker readback is missing");
}

export async function main(mode = "preview", component: Component = "gateway") {
  assert.ok(Object.hasOwn(targets, component)); assert.ok(["preview", "snapshot", "apply", "reconcile"].includes(mode));
  const target = targets[component], build = deps.sourceAndBundle(component);
  if (mode === "preview") {
    const candidate = await deps.readCandidateBindings(REPO, target.config, "production");
    return { preview: true, local_only: true, component, worker: target.worker, source: SOURCE, module_sha256: build.sha256, candidate_declared_sha256: digest(candidate), writes: 0 };
  }
  assert.ok(!process.env.CLOUDFLARE_API_TOKEN, "Managed OAuth only");
  if (mode === "snapshot") return { read_only: true, component, evidence: evidenceDiagnostics(), ...(await deps.collect(component)) };
  const { review, admissionSha } = deps.admitted(mode, mode === "apply");
  assert.equal(review.worker_executor_sha256, self()); assertReviewedBinding(review.worker_bindings?.[component]);
  const live = deps.live(); bound(live); const reviewPath = live.whole_operational_review_path;
  const selected = selectedWorker(component, review);
  const marker = selected.marker, readback = selected.readback, attempt = record(marker);
  // Any downstream file without an attempt is corruption, never a fresh write opportunity.
  const downstream = readdirSync(OPERATION_DIR).some(name => name === readback || name.startsWith(selected.key + "-reconciled-"));
  assert.ok(attempt || !downstream, "Worker downstream evidence lacks upload attempt");
  if (attempt) {
    const reviewedBefore = validateAttempt(component, attempt, review);
    if (record(readback)) validateReadback(component, review);
    const after = await verifyCandidate(component, reviewedBefore, reviewPath);
    const urls = await deps.managedUrls(); await ownerRead(urls.owner, 333); // Includes current paused revision0.
    if (!record(readback)) save(readback, { at: new Date(deps.now()).toISOString(), source: SOURCE, component, accepted: true,
      executor_sha256: self(), attempt_sha256: recordDigest(marker), candidate_identity: candidateIdentity(component, review), reconciled: true, receipt: null, after });
    assert.ok(validateReadback(component, review));
    save(selected.key + "-reconciled-" + deps.now() + ".json", { at: new Date(deps.now()).toISOString(), after, attempt_sha256: recordDigest(marker), new_write: false });
    return { accepted: true, component, version: after.version, reconciled: true, new_write: false };
  }
  assert.notEqual(mode, "reconcile", "No upload attempt exists; snapshot remains available");
  assertOrder(component, review);
  const before = await deps.collect(component); assert.equal(before.version, target.old);
  const accepted = review.worker_bindings[component];
  for (const key of ["baseline_sha256", "candidate_sha256", "settings_sha256", "changes"] as const) assert.deepEqual(before[key], accepted[key]);
  const urls = await deps.managedUrls(); await ownerRead(urls.owner, 333);
  const environment: Record<string, string | undefined> = { ...process.env, RUNTIME_POSTGRES_URL: urls.runtime, CONTROL_PLANE_POSTGRES_RUNTIME_URL: urls.runtime, CONTROL_PLANE_POSTGRES_ADMIN_URL: urls.owner };
  delete environment.CLOUDFLARE_API_TOKEN;
  const runner = async (command: readonly string[], cwd: string, signal?: AbortSignal) => {
    if (command[0] === "bunx" && command[1] === "wrangler" && command[2] === "deploy") {
      assert.deepEqual(await deps.collect(component), before); deps.admitted("apply", true); signal?.throwIfAborted();
      save(marker, { at: new Date(deps.now()).toISOString(), source: SOURCE, component, before, executor_sha256: self(), admission_sha256: admissionSha,
        candidate_identity: candidateIdentity(component, review) });
    }
    return deps.runDeploymentCommand(command, cwd, signal, environment);
  };
  const receipt = await withManagedGuardEnvironment(urls, () => deps.deploy(REPO, { configPath: target.config, environment: "production", sourceRef: SOURCE,
    acceptedMainRef: "origin/main", toolingSourceRef: review.tooling_source }, runner, () => {}));
  const after = await verifyCandidate(component, before, reviewPath); assert.equal(after.version, receipt.worker_version_id);
  await ownerRead(urls.owner, 333);
  save(readback, { at: new Date(deps.now()).toISOString(), source: SOURCE, component, accepted: true, executor_sha256: self(),
    attempt_sha256: recordDigest(marker), candidate_identity: candidateIdentity(component, review), reconciled: false, receipt, after });
  return { accepted: true, component, version: after.version, new_write: true };
}

if (import.meta.main) main(Bun.argv[2], Bun.argv[3] as Component).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ success: false, name: error?.name, message: "Worker operation refused or unresolved. Preserve evidence; snapshot remains available. Provider output withheld." })); process.exitCode = 1;
});
