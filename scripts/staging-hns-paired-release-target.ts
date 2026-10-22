import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

/** The paired operator-recovery branch. This module grants no reset capability. */
export const PAIRED_STAGING_RELEASE_TARGET = {
  databaseId: "yk4dth90j7px",
  databaseName: "staging",
  branchId: "ojbnlrgihio8",
  hyperdriveId: "8cb7658a0f7143359c1becfec6a15c23",
} as const;

export async function collectPairedStagingReleaseTarget() {
  const binding = await collectStagingProviderBinding(PAIRED_STAGING_RELEASE_TARGET);
  return {
    database_id: binding.database_id,
    branch_id: binding.branch_id,
    migrator_role: binding.admin.sqlRole,
  };
}

const execute = promisify(execFile);
export type ReleaseGitReader = (args: readonly string[]) => Promise<string>;
const git: ReleaseGitReader = async (args) =>
  (await execute("git", [...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 8_388_608 }))
    .stdout;

/** Bind the live ledger to the manifest's accepted release, not newer tooling.
 * SQL bytes and their complete file inventory are verified without executing SQL.
 */
export async function readReviewedReleaseMigrations(manifestText: string, readGit = git) {
  const source: unknown = JSON.parse(manifestText)?.api_next_source_commit;
  if (typeof source !== "string" || !/^[0-9a-f]{40}$/u.test(source))
    throw Error("release_source_invalid");
  await readGit(["merge-base", "--is-ancestor", source, "origin/main"]);
  const directory = "db/postgres/migrations/";
  const manifest: unknown = JSON.parse(
    await readGit(["show", `${source}:${directory}checksums.json`]),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("algorithm" in manifest) ||
    manifest.algorithm !== "sha256" ||
    !("migrations" in manifest) ||
    typeof manifest.migrations !== "object" ||
    manifest.migrations === null ||
    Array.isArray(manifest.migrations)
  )
    throw Error("release_ledger_invalid");
  const checksums = manifest.migrations as Record<string, unknown>;
  const names = Object.keys(checksums).sort();
  const actual = (await readGit(["ls-tree", "-r", "--name-only", source, "--", directory]))
    .trim()
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(directory.length))
    .sort();
  if (names.length === 0 || JSON.stringify(names) !== JSON.stringify(actual))
    throw Error("release_ledger_inventory_mismatch");
  const migrations = [];
  for (const version of names) {
    const checksum = checksums[version];
    if (
      !/^\d{4}_[a-z0-9_]+\.sql$/u.test(version) ||
      typeof checksum !== "string" ||
      !/^[0-9a-f]{64}$/u.test(checksum)
    )
      throw Error("release_ledger_invalid");
    const sql = await readGit(["show", `${source}:${directory}${version}`]);
    if (createHash("sha256").update(sql).digest("hex") !== checksum)
      throw Error("release_migration_checksum_mismatch");
    migrations.push({ version, checksum });
  }
  return migrations;
}
