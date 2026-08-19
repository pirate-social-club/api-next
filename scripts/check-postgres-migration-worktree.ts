import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPostgresMigrations } from "./postgres-migrations.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationDirectory = "db/postgres/migrations";

function untrackedMigrationSql(): readonly string[] {
  const result = spawnSync(
    "git",
    ["-C", repositoryRoot, "ls-files", "--others", "--exclude-standard", "--", migrationDirectory],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw new Error(`Unable to inspect migration worktree: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Unable to inspect migration worktree: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path.endsWith(".sql"));
}

export async function main(): Promise<void> {
  const untracked = untrackedMigrationSql();
  if (untracked.length > 0) {
    throw new Error(
      [
        "Untracked Postgres migration SQL detected; migration files and checksums.json must be checkpointed together:",
        ...untracked.map((path) => `- ${path}`),
      ].join("\n"),
    );
  }

  const migrations = await loadPostgresMigrations();
  console.log(`Postgres migration worktree is consistent (${migrations.length} migrations).`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Postgres migration worktree check failed",
    );
    process.exitCode = 1;
  });
}
