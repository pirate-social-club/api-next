import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKaraokeReleaseCli } from "./staging-karaoke-record-release-cli.ts";
import { makeKaraokeDatabaseRelease } from "./staging-karaoke-release-database.ts";
import { assertKaraokeRepositoryRoot } from "./staging-karaoke-repository-root.ts";

const directories: string[] = [];
const root = realpathSync(join(import.meta.dir, ".."));
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), "karaoke-root-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

test("release requires the exact api-next root with approved history", () => {
  expect(assertKaraokeRepositoryRoot(root)).toBe(root);
  expect(() => assertKaraokeRepositoryRoot(join(root, "scripts"))).toThrow(
    "karaoke_release_repository_root_denied",
  );
  const foreign = temporary();
  expect(() => assertKaraokeRepositoryRoot(foreign)).toThrow(
    "karaoke_release_repository_root_denied",
  );
  execFileSync("git", ["init", "--quiet", foreign]);
  writeFileSync(join(foreign, "package.json"), '{"name":"foreign","private":true}');
  expect(() => assertKaraokeRepositoryRoot(foreign)).toThrow(
    "karaoke_release_repository_root_denied",
  );
  writeFileSync(join(foreign, "package.json"), '{"name":"api-next","private":true}');
  expect(() => assertKaraokeRepositoryRoot(foreign)).toThrow(
    "karaoke_release_repository_root_denied",
  );
});

test("wrong cwd refuses parent and database factory before private configuration or provider access", async () => {
  const original = process.cwd();
  try {
    process.chdir(temporary());
    await expect(runKaraokeReleaseCli("absent-config", "absent-assertion")).rejects.toThrow(
      "karaoke_release_repository_root_denied",
    );
    expect(() =>
      makeKaraokeDatabaseRelease({
        reviewedGrantDigest: "a".repeat(64),
        targetBindingDigest: "b".repeat(64),
        restoreRuntimeConnect: true,
      }),
    ).toThrow("karaoke_release_repository_root_denied");
  } finally {
    process.chdir(original);
  }
});
