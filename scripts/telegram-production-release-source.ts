import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { gitEnvironment } from "./production-release/production-managed-environment.ts";
import { sha256 } from "./public-post-http-release-core.ts";
import {
  assertExecutionTools,
  assertQualifiedInputFile,
  assertToolingSource,
  fileHash,
  UPLOADER_SHA256,
} from "./public-post-http-release-source.ts";
import { type TelegramReview, telegramJson } from "./telegram-production-release-admission.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
} from "./telegram-production-release-policy.ts";

interface InputFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface Closure {
  readonly source: string;
  readonly servingBase: string;
  readonly moduleSha256: string;
  readonly sourceInputs: readonly InputFile[];
  readonly dependencyInputs: readonly InputFile[];
  readonly virtualInputs: readonly string[];
}
interface Candidate {
  readonly source: string;
  readonly tree: string;
  readonly workers: Readonly<
    Record<
      "http" | "jobs",
      {
        readonly closureSha256: string;
        readonly metafileSha256: string;
        readonly sourceConfigSha256: string;
      }
    >
  >;
}
function git(root: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixedJson<T>(path: string, expected: string): T {
  const bytes = readFileSync(path);
  requireTelegram(sha256(bytes) === expected, "qualified-input-digest-changed");
  return JSON.parse(bytes.toString("utf8")) as T;
}
const dependencyAliases = ["node_modules/pg/package.json", "node_modules/effect/package.json"];
// Each phase gets a fresh supervised process. Keep its conservative1.5GB qualification
// in that process only; repeated source callbacks still recheck Git, tools and application bytes.
let dependencyVerification: { source: string; sha256: string; at: number } | undefined;
function dependencyNames(root: string) {
  const paths: string[] = [],
    links: { path: string; target: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) links.push({ path, target: readlinkSync(resolve(root, path)) });
      else if (entry.isDirectory()) {
        if (![".cache", ".vite", ".tmp"].includes(entry.name)) visit(path);
      } else if (entry.isFile()) paths.push(path);
      else requireTelegram(false, "unsupported-operator-dependency-input");
    }
  };
  visit("node_modules");
  return {
    paths: [...new Set([...paths, ...dependencyAliases])].sort(),
    links: links.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
/** A conservative installed-file inventory also pins dynamic and native dependencies. No provider I/O. */
export function telegramDependencyInventory() {
  const root = policy.paths.tooling,
    names = dependencyNames(root);
  return {
    kind: "telegram-operator-dependency-closure-v1",
    tooling_source: git(root, "rev-parse", "HEAD"),
    lock_sha256: fileHash(resolve(root, "bun.lock")),
    links: names.links,
    excluded_cache_directory_names: [".cache", ".vite", ".tmp"],
    inputs: names.paths.map((path) => ({
      path,
      bytes: statSync(resolve(root, path)).size,
      sha256: fileHash(resolve(root, path)),
    })),
  };
}

/** Local files and local Git objects only. This never obtains credentials or contacts a provider. */
export function qualifiedTelegramApplication() {
  const root = policy.paths.application;
  requireTelegram(
    fileHash(resolve(policy.paths.submission, "APPLICATION-SUBMISSION-SHA256SUMS")) ===
      policy.submissionSha256 &&
      fileHash(
        resolve(
          policy.paths.preparation,
          "COORDINATOR-APPLICATION-BOUNDARY-ACCEPTED-20261103.json",
        ),
      ) === "bb911b8aa2e3d23a431d00528051e50552ef07a9252986b6f574782039b056a5",
    "accepted-application-evidence-changed",
  );
  requireTelegram(realpathSync(root) === root, "application-path-changed");
  requireTelegram(git(root, "rev-parse", "HEAD") === policy.source, "application-source-changed");
  requireTelegram(
    git(root, "rev-parse", "HEAD^{tree}") === policy.tree,
    "application-tree-changed",
  );
  requireTelegram(
    git(root, "branch", "--show-current") === policy.applicationBranch,
    "application-branch-changed",
  );
  requireTelegram(
    git(root, "status", "--porcelain=v1", "--untracked-files=all") === "",
    "application-checkout-dirty",
  );
  for (const parent of [root, resolve(root, "apps/http-worker"), resolve(root, "apps/jobs-worker")])
    for (const name of [".env", ".env.production", ".dev.vars", ".dev.vars.production"])
      requireTelegram(!existsSync(resolve(parent, name)), "local-environment-file-refused");
  const candidate = fixedJson<Candidate>(
    resolve(policy.paths.artifacts, "candidate.json"),
    policy.candidateSha256,
  );
  requireTelegram(
    candidate.source === policy.source && candidate.tree === policy.tree,
    "candidate-source-tuple-changed",
  );
  const workers = [];
  for (const kind of ["http", "jobs"] as const) {
    const target = policy.workers[kind];
    const directory = resolve(policy.paths.artifacts, kind);
    const closure = fixedJson<Closure>(
      resolve(directory, "qualified-input-closure.json"),
      candidate.workers[kind].closureSha256,
    );
    requireTelegram(
      closure.source === policy.source &&
        closure.servingBase === target.source &&
        closure.moduleSha256 === target.module,
      "worker-closure-tuple-changed",
    );
    const expected = kind === "http" ? [786, 2208, 11] : [639, 689, 10];
    requireTelegram(
      JSON.stringify([
        closure.sourceInputs.length,
        closure.dependencyInputs.length,
        closure.virtualInputs.length,
      ]) === JSON.stringify(expected),
      "worker-input-partition-changed",
    );
    for (const input of [...closure.sourceInputs, ...closure.dependencyInputs])
      assertQualifiedInputFile(root, input);
    requireTelegram(
      fileHash(resolve(directory, "bundle/index.js")) === target.module,
      "compiled-module-changed",
    );
    requireTelegram(
      fileHash(resolve(directory, "bundle-meta.json")) === candidate.workers[kind].metafileSha256,
      "worker-metafile-changed",
    );
    requireTelegram(
      fileHash(resolve(root, target.config)) === candidate.workers[kind].sourceConfigSha256,
      "frozen-application-config-changed",
    );
    workers.push({ kind, worker: target.name, moduleSha256: target.module });
  }
  return {
    source: policy.source,
    tree: policy.tree,
    candidateSha256: policy.candidateSha256,
    workers,
  };
}

/** Live admission additionally requires accepted tooling and the exact published application ref. */
export function publishedTelegramTooling(review: TelegramReview) {
  assertExecutionTools(review);
  assertToolingSource(review.tooling_source, {
    tooling: policy.paths.tooling,
    application: policy.paths.application,
    packet: policy.paths.artifacts,
    evidence: policy.paths.operation,
  });
  for (const root of [policy.paths.tooling, policy.paths.application]) {
    requireTelegram(
      fileHash(resolve(root, "node_modules/wrangler/wrangler-dist/cli.js")) === UPLOADER_SHA256 &&
        JSON.parse(readFileSync(resolve(root, "node_modules/wrangler/package.json"), "utf8"))
          .version === "4.123.0",
      "installed-qualified-uploader-changed",
    );
    for (const name of [".env", ".env.production", ".dev.vars", ".dev.vars.production"])
      requireTelegram(!existsSync(resolve(root, name)), "local-environment-file-refused");
  }
  const dependencies = telegramJson<{
    kind: string;
    tooling_source: string;
    lock_sha256: string;
    inputs: readonly InputFile[];
    links: readonly { path: string; target: string }[];
  }>(review.tooling_dependencies);
  if (
    dependencyVerification?.source === review.tooling_source &&
    dependencyVerification.sha256 === review.tooling_dependencies.sha256 &&
    Date.now() - dependencyVerification.at < 180_000
  )
    return;
  const installed = dependencyNames(policy.paths.tooling);
  requireTelegram(
    dependencies.kind === "telegram-operator-dependency-closure-v1" &&
      dependencies.tooling_source === review.tooling_source &&
      dependencies.lock_sha256 === fileHash(resolve(policy.paths.tooling, "bun.lock")) &&
      dependencies.inputs.length > 0 &&
      new Set(dependencies.inputs.map((row) => row.path)).size === dependencies.inputs.length &&
      JSON.stringify(dependencies.inputs.map((row) => row.path).sort()) ===
        JSON.stringify(installed.paths) &&
      JSON.stringify(dependencies.links) === JSON.stringify(installed.links) &&
      ["node_modules/pg/package.json", "node_modules/effect/package.json"].every((path) =>
        dependencies.inputs.some((r) => r.path === path),
      ),
    "qualified-operator-dependency-closure-required",
  );
  for (const row of dependencies.inputs) {
    requireTelegram(row.path.startsWith("node_modules/"), "operator-dependency-path-refused");
    assertQualifiedInputFile(policy.paths.tooling, row);
  }
  dependencyVerification = {
    source: review.tooling_source,
    sha256: review.tooling_dependencies.sha256,
    at: Date.now(),
  };
}
export function publishedTelegramSources(review: TelegramReview) {
  publishedTelegramTooling(review);
  for (const source of [
    "e7d7e625da02b298adff693df2a53c94f7e5a9c4",
    "fa101b220a108bfa044805289823916ec1c06d0a",
  ])
    requireTelegram(
      git(policy.paths.tooling, "merge-base", source, "FETCH_HEAD") === source,
      "application-producer-not-accepted",
    );
  const root = policy.paths.application;
  const ref = `refs/heads/${policy.applicationBranch}`;
  requireTelegram(
    git(root, "remote", "get-url", "origin") ===
      "https://github.com/pirate-social-club/api-next.git",
    "application-origin-changed",
  );
  requireTelegram(
    git(root, "ls-remote", "origin", ref) === `${policy.source}\t${ref}`,
    "application-ref-not-published",
  );
  return qualifiedTelegramApplication();
}
