import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registeredDirectories = new Set<string>();
let exitCleanupInstalled = false;

function removeRegisteredDirectories(): void {
  for (const directory of registeredDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort process-exit cleanup; a failed removal must not mask the
      // run result.
    }
  }
  registeredDirectories.clear();
}

/**
 * Creates a private fixture directory whose removal is deferred to process
 * exit. A test body that outlives its timeout must never have its files
 * deleted underneath it, so per-test fixture disposal cannot remove these
 * directories while the process is still running. The directories stay
 * isolated per fixture; only their cleanup timing changes.
 */
export function makeProcessLifetimeTestDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registeredDirectories.add(directory);
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.on("exit", removeRegisteredDirectories);
  }
  return directory;
}
