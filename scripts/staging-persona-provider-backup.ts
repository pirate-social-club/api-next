import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const databasePath = "organizations/{org}/databases/pirate-staging";
const databaseId = "mvydkmmwh5x4";
const branchId = "syu03e00w3ux";
type ProviderRead = (path: string) => Promise<unknown>;

async function readProvider(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "pscale",
    ["api", path, "--method", "GET", "--api-url", "https://api.planetscale.com/"],
    { timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function instant(value: unknown): number {
  if (typeof value !== "string") throw new Error();
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error();
  return result;
}

/**
 * Metadata observation only. Does not verify SQL connections, fences, retention,
 * contents or restore health. An injected reader is for unit tests, not authority.
 */
export async function observeStagingProviderBackup(
  backupId: string,
  read: ProviderRead = readProvider,
) {
  try {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(backupId)) throw new Error();
    const database = object(await read(databasePath));
    if (
      database.id !== databaseId ||
      database.name !== "pirate-staging" ||
      database.kind !== "postgresql"
    )
      throw new Error();
    const branch = object(await read(`${databasePath}/branches/main`));
    if (
      branch.id !== branchId ||
      branch.name !== "main" ||
      branch.kind !== "postgresql" ||
      branch.ready !== true ||
      branch.state !== "ready"
    )
      throw new Error();
    const backup = object(await read(`${databasePath}/branches/main/backups/${backupId}`));
    const source = object(backup.database_branch);
    if (
      backup.id !== backupId ||
      backup.state !== "success" ||
      source.id !== branchId ||
      source.name !== "main" ||
      typeof backup.protected !== "boolean" ||
      !Array.isArray(backup.restored_branches)
    )
      throw new Error();
    const createdAt = instant(backup.created_at);
    const startedAt = instant(backup.started_at);
    const completedAt = instant(backup.completed_at);
    const expiresAt = instant(backup.expires_at);
    if (createdAt > startedAt || startedAt > completedAt || completedAt >= expiresAt)
      throw new Error();
    const restoredBranches = backup.restored_branches.map((entry) => {
      const restored = object(entry);
      if (
        typeof restored.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(restored.id) ||
        restored.id === branchId
      )
        throw new Error();
      return restored.id;
    });
    if (new Set(restoredBranches).size !== restoredBranches.length) throw new Error();
    return Object.freeze({
      observation_version: 1 as const,
      database_id: databaseId,
      source_branch_id: branchId,
      backup_id: backupId,
      created_at: createdAt,
      started_at: startedAt,
      completed_at: completedAt,
      expires_at: expiresAt,
      deletion_protected: backup.protected,
      restored_branch_ids: Object.freeze(restoredBranches),
      sql_target_verified: false as const,
      recovery_verified: false as const,
      execution_authorized: false as const,
    });
  } catch {
    // CLI diagnostics and provider JSON may contain identities or credentials.
    throw new Error("staging_provider_backup_unproven");
  }
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3) throw new Error();
    const backupId = Bun.argv[2];
    if (backupId === undefined) throw new Error();
    console.log(JSON.stringify(await observeStagingProviderBackup(backupId)));
  } catch {
    console.error("staging_provider_backup_unproven");
    process.exitCode = 1;
  }
}
