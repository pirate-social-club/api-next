import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PAIRED_STAGING_RELEASE_TARGET,
  type ReleaseGitReader,
  readReviewedReleaseMigrations,
} from "./staging-hns-paired-release-target.ts";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_DATABASE_ID,
} from "./staging-hns-post-migration-contract.ts";
import { matchStagingRole } from "./staging-persona-target-binding.ts";

test("paired release role binding cannot retarget historical reset defaults", () => {
  expect(HNS_STAGING_DATABASE_ID).toBe("mvydkmmwh5x4");
  expect(HNS_STAGING_BRANCH_ID).toBe("syu03e00w3ux");
  const branch = PAIRED_STAGING_RELEASE_TARGET.branchId;
  const role = {
    id: "reader",
    username: `reader.${branch}`,
    base_username: "reader",
    access_host_url: "fixture.example",
    database_name: "postgres",
    expired: false,
    branch: { id: branch, name: "main" },
  };
  const url = `postgresql://reader.${branch}:fixture@fixture.example/postgres?sslmode=verify-full&sslrootcert=system`;
  expect(matchStagingRole(role, url, "runtime", branch).sqlRole).toBe("reader");
  expect(() => matchStagingRole(role, url, "runtime")).toThrow("staging_role_target_mismatch");
  expect(() =>
    matchStagingRole(
      { ...role, branch: { id: "production", name: "main" } },
      url,
      "runtime",
      branch,
    ),
  ).toThrow("staging_role_target_mismatch");
});

const source = "a".repeat(40);
const manifest = JSON.stringify({ api_next_source_commit: source });
const directory = "db/postgres/migrations/";
const version = "0001_fixture.sql";
const sql = "SELECT 1;\n";
const checksum = createHash("sha256").update(sql).digest("hex");

function reader(
  patch: { unpublished?: boolean; inventory?: string; sql?: string } = {},
): ReleaseGitReader {
  return async (args) => {
    expect(args.includes(source) || args.some((arg) => arg.startsWith(`${source}:`))).toBe(true);
    if (args[0] === "merge-base") {
      expect(args).toEqual(["merge-base", "--is-ancestor", source, "origin/main"]);
      if (patch.unpublished) throw Error("unaccepted_source");
      return "";
    }
    if (args[0] === "ls-tree") return patch.inventory ?? `${directory}${version}\n`;
    if (args[1] === `${source}:${directory}checksums.json`)
      return JSON.stringify({ algorithm: "sha256", migrations: { [version]: checksum } });
    if (args[1] === `${source}:${directory}${version}`) return patch.sql ?? sql;
    throw Error("unexpected_git_read");
  };
}

test("probe tooling binds the exact historical release ledger and verifies its SQL", async () => {
  expect(await readReviewedReleaseMigrations(manifest, reader())).toEqual([{ version, checksum }]);
  await expect(
    readReviewedReleaseMigrations(manifest, reader({ unpublished: true })),
  ).rejects.toThrow("unaccepted_source");
  await expect(
    readReviewedReleaseMigrations(
      manifest,
      reader({ inventory: `${directory}${version}\n${directory}0002_unlisted.sql\n` }),
    ),
  ).rejects.toThrow("release_ledger_inventory_mismatch");
  await expect(
    readReviewedReleaseMigrations(manifest, reader({ sql: "SELECT 2;\n" })),
  ).rejects.toThrow("release_migration_checksum_mismatch");
});

test("a missing or non-commit manifest source never reaches Git or a database", async () => {
  for (const value of [{}, { api_next_source_commit: "main" }, { api_next_source_commit: "-a" }]) {
    await expect(
      readReviewedReleaseMigrations(JSON.stringify(value), async () => {
        throw Error("must_not_read_git");
      }),
    ).rejects.toThrow("release_source_invalid");
  }
});
