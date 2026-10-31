import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnvironment } from "./production-managed-environment.ts";
import {
  API_APP_SOURCE,
  API_APP_TREE,
  APP_REPO,
  SOURCE_DIRECTORY,
  TOOLING_REPO,
} from "./production-release-paths.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (root: string, args: readonly string[]) =>
  execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: gitEnvironment(),
  }).trim();
const relative = "scripts/production-release/";
const manifestName = "source-manifest.json";
export const TOOLING_RELEASE_REF =
  "refs/heads/release/v1-website-qualified-tooling-r2-20261031";
const publicationPaths = {
  "scripts/production-release": "tree",
  "scripts/production-compatibility": "tree",
  "tsconfig.scripts.json": "blob",
} as const;
type PublicationObject = {
  source_oid: string;
  main_oid: string;
  source_type: string;
  main_type: string;
};
export type ToolingPublicationSnapshot = {
  source: string;
  main: string;
  source_is_ancestor: boolean;
  application_is_ancestor: boolean;
  release_ref?: string;
  release_tip?: string;
  objects?: Record<string, PublicationObject>;
};

/** Exactly one advertised branch, never an ambiguous or caller-selected ref. */
export function publishedTip(output: string, ref: string) {
  const rows = output.trim().split("\n");
  assert.equal(rows.length, 1, "Published branch is absent or ambiguous");
  const row = rows[0];
  assert.ok(row);
  const fields = row.split("\t");
  assert.equal(fields.length, 2);
  const tip = fields[0];
  assert.ok(tip);
  assert.match(tip, /^[a-f0-9]{40}$/u);
  assert.equal(fields[1], ref);
  return tip;
}

/** The fallback accepts only published tooling content; application inputs remain M. */
export function validateToolingPublication(snapshot: ToolingPublicationSnapshot) {
  assert.match(snapshot.source, /^[a-f0-9]{40}$/u);
  assert.match(snapshot.main, /^[a-f0-9]{40}$/u);
  assert.equal(typeof snapshot.source_is_ancestor, "boolean");
  if (snapshot.source_is_ancestor) return;
  assert.equal(snapshot.application_is_ancestor, true, "Accepted main does not contain M");
  assert.equal(snapshot.release_ref, TOOLING_RELEASE_REF);
  assert.equal(snapshot.release_tip, snapshot.source, "Frozen release ref moved or is unpublished");
  assert.deepEqual(Object.keys(snapshot.objects ?? {}).sort(), Object.keys(publicationPaths).sort());
  for (const [path, type] of Object.entries(publicationPaths)) {
    const object = snapshot.objects![path]!;
    assert.equal(object.source_type, type, "Frozen publication object type differs: " + path);
    assert.equal(object.main_type, type, "Accepted publication object type differs: " + path);
    assert.match(object.source_oid, /^[a-f0-9]{40}$/u);
    assert.match(object.main_oid, /^[a-f0-9]{40}$/u);
    assert.equal(object.source_oid, object.main_oid, "Accepted tooling content differs: " + path);
  }
}

function ancestor(source: string, main: string) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", source, main], {
    cwd: TOOLING_REPO, encoding: "utf8", timeout: 30_000, env: gitEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, "Git ancestry check failed");
  return result.status === 0;
}

/** No unrelated Git error is treated as permission to use the content witness. */
export function assertPublishedToolingSource(source: string) {
  assert.equal(git(TOOLING_REPO, ["remote", "get-url", "origin"]), "https://github.com/pirate-social-club/api-next.git");
  const tip = (ref: string) => publishedTip(git(TOOLING_REPO, ["ls-remote", "--refs", "origin", ref]), ref);
  const main = tip("refs/heads/main");
  git(TOOLING_REPO, ["fetch", "--no-tags", "origin", "refs/heads/main"]);
  assert.equal(git(TOOLING_REPO, ["rev-parse", "FETCH_HEAD"]), main, "Accepted main changed during fetch");
  const sourceIsAncestor = ancestor(source, main);
  const snapshot: ToolingPublicationSnapshot = {
    source, main, source_is_ancestor: sourceIsAncestor,
    application_is_ancestor: sourceIsAncestor || ancestor(API_APP_SOURCE, main),
  };
  if (!sourceIsAncestor) {
    snapshot.release_ref = TOOLING_RELEASE_REF;
    snapshot.release_tip = tip(TOOLING_RELEASE_REF);
    snapshot.objects = Object.fromEntries(Object.keys(publicationPaths).map(path => [path, {
      source_oid: git(TOOLING_REPO, ["rev-parse", "--verify", source + ":" + path]),
      main_oid: git(TOOLING_REPO, ["rev-parse", "--verify", main + ":" + path]),
      source_type: git(TOOLING_REPO, ["cat-file", "-t", source + ":" + path]),
      main_type: git(TOOLING_REPO, ["cat-file", "-t", main + ":" + path]),
    }]));
  }
  validateToolingPublication(snapshot);
  assert.equal(tip("refs/heads/main"), main, "Accepted main moved during publication check");
  if (!sourceIsAncestor) assert.equal(tip(TOOLING_RELEASE_REF), source, "Frozen release ref moved during publication check");
  return snapshot;
}

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
      env: gitEnvironment(),
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
  assertPublishedToolingSource(review.tooling_source);
  assertCommittedToolingSource(review);
  assert.equal(checkSourceManifest(), review.adapter_manifest_sha256);
}
