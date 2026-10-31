import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_APP_SOURCE,
  API_APP_TREE,
  APP_REPO,
  SOURCE_DIRECTORY,
  TOOLING_REPO,
} from "./production-release-paths.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (root: string, args: readonly string[]) =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
const relative = "scripts/production-release/";
const manifestName = "source-manifest.json";

export function assertApplicationSource() {
  assert.equal(git(APP_REPO, ["rev-parse", "HEAD"]), API_APP_SOURCE);
  assert.equal(git(APP_REPO, ["rev-parse", "HEAD^{tree}"]), API_APP_TREE);
  assert.equal(git(APP_REPO, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
}

/** No maintained dependency, application source or configuration changes with this tooling port. */
export function assertMaintainedSourceEquality() {
  const changed = git(TOOLING_REPO, [
    "diff",
    "--name-only",
    "--no-renames",
    API_APP_SOURCE,
    "HEAD",
    "--",
  ])
    .split("\n")
    .filter(Boolean);
  assert.ok(
    changed.every(
      (path) =>
        path.startsWith(relative) ||
        path.startsWith("scripts/production-compatibility/") ||
        path === "tsconfig.scripts.json",
    ),
    "Tooling changed maintained application inputs",
  );
  for (const name of [
    "postgres-migrations.ts",
    "postgres-connection-string.ts",
    "serving-function-privileges-preflight.ts",
    "dance-serving-permissions-preflight.ts",
    "deploy-worker-with-provenance.ts",
    "worker-deployment-bindings.ts",
    "worker-binding-drift.ts",
    "rewards-e2e/cloudflare-api.mjs",
  ]) {
    const path = "scripts/" + name;
    const accepted = execFileSync("git", ["show", API_APP_SOURCE + ":" + path], {
      cwd: TOOLING_REPO,
      timeout: 30_000,
    });
    assert.equal(
      sha(readFileSync(join(TOOLING_REPO, path))),
      sha(accepted),
      "Maintained import differs: " + path,
    );
  }
}

/** The committed tree supplies the closure; a live-facts file is never a source input. */
export function checkSourceManifest() {
  const bytes = readFileSync(join(SOURCE_DIRECTORY, manifestName));
  const manifest: { files: Record<string, string> } = JSON.parse(bytes.toString("utf8"));
  const tracked = git(TOOLING_REPO, ["ls-files", "--", relative])
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(relative.length))
    .filter((path) => path !== manifestName)
    .sort();
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    tracked,
    "Committed tooling closure differs",
  );
  for (const name of tracked)
    assert.equal(
      sha(readFileSync(join(SOURCE_DIRECTORY, name))),
      manifest.files[name],
      "Changed tooling source: " + name,
    );
  return sha(bytes);
}

export function assertCommittedToolingSource(review: {
  tooling_source: string;
  tooling_tree: string;
}) {
  assert.match(review.tooling_source, /^[a-f0-9]{40}$/u);
  assert.match(review.tooling_tree, /^[a-f0-9]{40}$/u);
  assert.equal(git(TOOLING_REPO, ["rev-parse", "HEAD"]), review.tooling_source);
  assert.equal(git(TOOLING_REPO, ["rev-parse", "HEAD^{tree}"]), review.tooling_tree);
  assert.equal(git(TOOLING_REPO, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assertApplicationSource();
  assertMaintainedSourceEquality();
}

export function assertToolingSource(review: {
  tooling_source: string;
  tooling_tree: string;
  adapter_manifest_sha256: string;
}) {
  assertCommittedToolingSource(review);
  assert.equal(
    git(TOOLING_REPO, ["remote", "get-url", "origin"]),
    "https://github.com/pirate-social-club/api-next.git",
  );
  const remote = git(TOOLING_REPO, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0];
  assert.ok(remote && /^[a-f0-9]{40}$/u.test(remote));
  git(TOOLING_REPO, ["merge-base", "--is-ancestor", review.tooling_source, remote]);
  assert.equal(checkSourceManifest(), review.adapter_manifest_sha256);
}
