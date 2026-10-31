import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPostgresMigrations } from "../postgres-migrations.ts";
import { object, exactKeys } from "./compatibility-contract.ts";
import { QUERIES } from "./inventory.ts";

export const APP_REPO = "/media/t42/codedrive/Code/pirate-workspace/.worktrees/api-next/v1-hns-browser-renewal-cookies-api-20261029";
export const APP_SOURCE = "a6bb14b7669ec5900d20b20d1fb077a5bead38bc";
export const PREFIX_LEDGER = "1f49f7e3d7b3323fc84e15ce365d47d00337fa8047abad9c67458e0b0c40d04b";
export const root = new URL("../../", import.meta.url);
export const packageRoot = new URL("./", import.meta.url);
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = (directory: string, args: string[]) => execFileSync("/usr/bin/git", args, { cwd: directory, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Called before credentials and after the read; does not alter a ref or checkout. */
export async function sourceInputs() {
  const toolingRoot = realpathSync(fileURLToPath(root));
  assert.equal(git(toolingRoot, ["rev-parse", "--show-toplevel"]), toolingRoot);
  const toolingSource = git(toolingRoot, ["rev-parse", "HEAD"]); assert.match(toolingSource, /^[a-f0-9]{40}$/u);
  assert.equal(git(toolingRoot, ["status", "--porcelain=v1"]), "");
  assert.equal(git(APP_REPO, ["rev-parse", "HEAD"]), APP_SOURCE);
  assert.equal(git(APP_REPO, ["status", "--porcelain=v1"]), "");
  const manifestBytes = readFileSync(new URL("source-manifest.json", packageRoot));
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  assert.equal(manifest.kind, "production-compatibility-source-v1"); assert.equal(manifest.api_source, APP_SOURCE);
  const files = object(manifest.files);
  const required = ["compatibility-contract.ts", "compatibility-contract.test.ts", "inventory.ts", "source-inputs.ts", "read-production-compatibility.ts", "source-bindings.json", ...QUERIES.map(query => query.file)];
  exactKeys(files, required);
  for (const name of required) assert.equal(sha256(readFileSync(new URL(name, packageRoot))), files[name], "Compatibility source changed");
  for (const name of ["postgres-migrations.ts", "postgres-connection-string.ts"]) {
    assert.equal(sha256(readFileSync(new URL("../" + name, packageRoot))), sha256(readFileSync(APP_REPO + "/scripts/" + name)), "Maintained helper source differs");
  }
  const migrations = await loadPostgresMigrations(pathToFileURL(APP_REPO + "/db/postgres/migrations/"));
  assert.equal(migrations.length, 333);
  const prefix = migrations.slice(0, 275).map(({ version, checksum }) => ({ version, checksum }));
  assert.equal(sha256(prefix.map(row => row.version + ":" + row.checksum).join("\n")), PREFIX_LEDGER);
  const bindings = object(JSON.parse(readFileSync(new URL("source-bindings.json", packageRoot), "utf8")));
  assert.equal(bindings.source, APP_SOURCE); assert.equal(bindings.predecessor_check_count, 148);
  assert.equal(bindings.pending_named_check_count, 24); assert.equal(bindings.introduced_table_count, 76);
  const pending = object(bindings.migration_inputs); assert.equal(Object.keys(pending).length, 58);
  for (const migration of migrations.slice(275)) assert.equal(pending["db/postgres/migrations/" + migration.version], migration.checksum);
  return { toolingRoot, toolingSource, appSource: APP_SOURCE, manifestSha256: sha256(manifestBytes), prefix,
    queries: QUERIES.map(query => ({ id: query.id, sql: readFileSync(new URL(query.file, packageRoot), "utf8") })) };
}
