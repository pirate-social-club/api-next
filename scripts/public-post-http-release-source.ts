import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerDeploymentInput } from "./deploy-worker-with-provenance.ts";
import { gitEnvironment } from "./production-release/production-managed-environment.ts";
import {
  HTTP_RELEASE,
  type HttpCandidate,
  type HttpReview,
  requireRelease,
  sha256,
} from "./public-post-http-release-core.ts";

export const HTTP_PATHS = {
  tooling: fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""),
  application:
    "/media/t42/codedrive/Code/pirate-workspace/.worktrees/api-next/api-public-post-community-context-20261102",
  packet:
    "/home/t42/Documents/agents/handoffs/public-post-community-storybook-handoff-2026-11-02/release-preparation-20261102/api",
  evidence:
    "/home/t42/Documents/agents/handoffs/public-post-community-storybook-handoff-2026-11-02/release-execution-20261102/api",
} as const;
export const UPLOADER_SHA256 = "e832d95232c2fbc1f5eb0ef427676c8d3be87c68911da9ff38bf55949a4c4ee0";
const origin = "https://github.com/pirate-social-club/api-next.git";
const applicationBranch = "release/production-public-post-context-20261102";
const paths = [
  "apps/http-worker/src/composition.ts",
  "apps/http-worker/src/public-post-route-handlers.test.ts",
  "packages/application/src/use-cases/content/public-post-routes.test.ts",
  "packages/application/src/use-cases/content/public-post-routes.ts",
  "packages/platform-cf/src/text-submission-repository.pg.test.ts",
  "packages/platform-cf/src/video-detail-repository.test.ts",
  "packages/platform-cf/src/video-detail-repository.ts",
] as const;
export const fileHash = (path: string) => sha256(readFileSync(path));
function git(root: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", args, {
    cwd: root,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function publication(root: string, branch: string, source: string) {
  requireRelease(git(root, "remote", "get-url", "origin") === origin, "unexpected-git-origin");
  requireRelease(
    git(root, "ls-remote", "origin", `refs/heads/${branch}`) === `${source}\trefs/heads/${branch}`,
    "frozen-ref-not-published",
  );
  git(root, "fetch", "--no-tags", "origin", "refs/heads/main");
}
export function assertToolingSource(expected?: string) {
  const root = HTTP_PATHS.tooling,
    source = git(root, "rev-parse", "HEAD");
  const branch = git(root, "branch", "--show-current");
  requireRelease(
    /^release\/production-[a-z0-9-]+$/.test(branch),
    "tooling-needs-published-production-release-ref",
  );
  requireRelease(!expected || source === expected, "tooling-source-differs");
  requireRelease(
    git(root, "status", "--porcelain=v1", "--untracked-files=all") === "",
    "tooling-checkout-dirty",
  );
  publication(root, branch, source);
  requireRelease(
    git(root, "merge-base", source, "FETCH_HEAD") === source,
    "tooling-source-not-accepted",
  );
  return source;
}
/** The exception admits only this reviewed patch-derived tree, never a floating main application. */
export function assertFixedHttpInput(root: string, input: WorkerDeploymentInput) {
  requireRelease(
    root === HTTP_PATHS.application &&
      input.configPath === HTTP_RELEASE.config &&
      input.environment === "production" &&
      input.sourceRef === HTTP_RELEASE.source &&
      input.acceptedMainRef === "origin/main" &&
      input.bindingReviewPath === undefined &&
      input.toolingSourceRef === undefined,
    "fixed-http-source-input-required",
  );
}
export async function verifyFixedPublicPostSource(root: string, input: WorkerDeploymentInput) {
  assertFixedHttpInput(realpathSync(root), input);
  requireRelease(
    git(root, "rev-parse", "--path-format=absolute", "--git-common-dir") ===
      "/media/t42/codedrive/Code/pirate-workspace/api-next/.git",
    "unregistered-application-repository",
  );
  requireRelease(
    git(root, "branch", "--show-current") === applicationBranch &&
      git(root, "rev-parse", "HEAD") === HTTP_RELEASE.source &&
      git(root, "rev-parse", "HEAD^{tree}") === HTTP_RELEASE.tree &&
      git(root, "rev-parse", "HEAD^") === HTTP_RELEASE.base,
    "fixed-application-tree-differs",
  );
  requireRelease(
    git(root, "status", "--porcelain=v1", "--untracked-files=all") === "",
    "application-checkout-dirty",
  );
  for (const name of [".env", ".env.production", ".dev.vars", ".dev.vars.production"]) {
    requireRelease(!existsSync(resolve(root, name)), "local-environment-file-refused");
  }
  publication(root, applicationBranch, HTTP_RELEASE.source);
  requireRelease(
    git(root, "merge-base", HTTP_RELEASE.accepted, "FETCH_HEAD") === HTTP_RELEASE.accepted,
    "reviewed-application-merge-not-accepted",
  );
  const changed = git(root, "diff", "--name-only", HTTP_RELEASE.base, HTTP_RELEASE.source)
    .split("\n")
    .sort();
  requireRelease(
    JSON.stringify(changed) === JSON.stringify([...paths].sort()),
    "application-delta-outside-reviewed-seven-files",
  );
  for (const path of paths) {
    requireRelease(
      git(root, "rev-parse", `${HTTP_RELEASE.source}:${path}`) ===
        git(root, "rev-parse", `${HTTP_RELEASE.accepted}:${path}`),
      "application-file-differs-from-exact-accepted-merge",
    );
  }
  return { sourceSha: HTTP_RELEASE.source, configPath: HTTP_RELEASE.config };
}
interface InputFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface Packet {
  readonly source: string;
  readonly source_tree: string;
  readonly serving_base: string;
  readonly source_inputs: readonly InputFile[];
  readonly virtual_inputs: readonly unknown[];
  readonly bundle_files: readonly InputFile[];
}
function inputPath(root: string, path: string) {
  const absolute = resolve(root, path);
  requireRelease(
    path !== "" &&
      !path.startsWith("/") &&
      absolute.startsWith(`${root}/`) &&
      realpathSync(absolute).startsWith(`${root}/`),
    "artifact-input-outside-qualified-root",
  );
  return absolute;
}
export function assertQualifiedInputFile(root: string, row: InputFile) {
  const path = inputPath(root, row.path),
    bytes = readFileSync(path);
  requireRelease(
    bytes.length === row.bytes && sha256(bytes) === row.sha256,
    "qualified-input-or-bundle-changed",
  );
}
export async function qualifiedHttpCandidate(review?: HttpReview): Promise<HttpCandidate> {
  const tooling = assertToolingSource(review?.tooling_source);
  await verifyFixedPublicPostSource(HTTP_PATHS.application, {
    configPath: HTTP_RELEASE.config,
    environment: "production",
    sourceRef: HTTP_RELEASE.source,
    acceptedMainRef: "origin/main",
  });
  const bytes = readFileSync(resolve(HTTP_PATHS.packet, "candidate.json"));
  requireRelease(sha256(bytes) === HTTP_RELEASE.packet, "qualified-packet-changed");
  const packet = JSON.parse(bytes.toString("utf8")) as Packet;
  requireRelease(
    packet.source === HTTP_RELEASE.source &&
      packet.source_tree === HTTP_RELEASE.tree &&
      packet.serving_base === HTTP_RELEASE.base &&
      packet.source_inputs.length === 2993 &&
      packet.virtual_inputs.length === 11,
    "qualified-packet-tuple-differs",
  );
  for (const row of packet.source_inputs) assertQualifiedInputFile(HTTP_PATHS.application, row);
  const bundle = resolve(HTTP_PATHS.packet, "bundle");
  requireRelease(
    JSON.stringify(readdirSync(bundle).sort()) ===
      JSON.stringify(["README.md", "index.js", "index.js.map"]),
    "unexpected-bundle-sidecar",
  );
  for (const row of packet.bundle_files) assertQualifiedInputFile(bundle, row);
  requireRelease(
    fileHash(resolve(bundle, "index.js")) === HTTP_RELEASE.module,
    "compiled-entry-differs",
  );
  for (const root of [HTTP_PATHS.application, HTTP_PATHS.tooling]) {
    const installed = JSON.parse(
      readFileSync(resolve(root, "node_modules/wrangler/package.json"), "utf8"),
    );
    requireRelease(
      installed.version === "4.123.0" &&
        fileHash(resolve(root, "node_modules/wrangler/wrangler-dist/cli.js")) === UPLOADER_SHA256,
      "qualified-uploader-differs",
    );
  }
  return {
    source: HTTP_RELEASE.source,
    tree: HTTP_RELEASE.tree,
    module_sha256: HTTP_RELEASE.module,
    tooling_source: tooling,
  };
}
export function readHttpReview(path: string, expectedHash: string): HttpReview {
  requireRelease(
    path.startsWith("/") && /^[a-f0-9]{64}$/.test(expectedHash),
    "absolute-reviewed-file-and-digest-required",
  );
  const bytes = readFileSync(path);
  requireRelease(sha256(bytes) === expectedHash, "operation-review-file-changed");
  return JSON.parse(bytes.toString("utf8")) as HttpReview;
}
export function assertExecutionTools(review: HttpReview) {
  const tools = review.execution_tools;
  requireRelease(
    process.execPath === tools.bun_path &&
      fileHash(process.execPath) === tools.bun_sha256 &&
      fileHash("/usr/bin/timeout") === tools.timeout_sha256 &&
      tools.node_path.startsWith("/") &&
      fileHash(tools.node_path) === tools.node_sha256 &&
      tools.wrangler_cli_sha256 === UPLOADER_SHA256,
    "reviewed-execution-tools-differ",
  );
  requireRelease(
    execFileSync(tools.node_path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: gitEnvironment(),
    }).trim() === "v24.14.0",
    "qualified-node-version-differs",
  );
}
export function publicPostExecutionTools() {
  const node = execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    timeout: 5_000,
    env: gitEnvironment(),
  }).trim();
  return {
    bun_path: process.execPath,
    bun_sha256: fileHash(process.execPath),
    timeout_sha256: fileHash("/usr/bin/timeout"),
    node_path: node,
    node_sha256: fileHash(node),
    wrangler_cli_sha256: UPLOADER_SHA256,
  };
}
