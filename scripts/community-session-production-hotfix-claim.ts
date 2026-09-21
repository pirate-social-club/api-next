import { type FileHandle, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const CLAIM_FILE = "community-session-production-hotfix.claim";

export type HotfixClaimRunner = <T>(
  directory: string,
  identity: string,
  action: () => Promise<T>,
) => Promise<T>;

export async function withDurableHotfixClaim<T>(
  directory: string,
  identity: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!isAbsolute(directory)) throw new Error("hotfix claim directory must be absolute");
  const canonical = await realpath(directory);
  const directoryStat = await lstat(canonical);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("hotfix claim directory must be a private directory");
  }

  const path = join(canonical, CLAIM_FILE);
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new Error("hotfix operation claim already exists; reconcile it before proceeding");
    }
    throw error;
  }

  const opened = await handle.stat();
  await handle.writeFile(
    `${JSON.stringify({ schema_version: 1, identity, pid: process.pid, claimed_at: new Date().toISOString() })}\n`,
    { encoding: "utf8" },
  );
  await handle.sync();

  const outcome = await action().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  await handle.close();
  const current = await lstat(path);
  if (current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new Error("hotfix operation claim identity changed during execution");
  }
  await unlink(path);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
