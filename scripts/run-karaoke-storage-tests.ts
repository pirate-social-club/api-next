import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
// Each suite owns a fresh Bun module cache. The actual DO suite deliberately
// mocks the Cloudflare base/runtime factory and cannot share another test VM.
const suites = [
  "verification/karaoke-storage/karaoke-captured.storage.test.ts",
  "verification/karaoke-storage/karaoke-captured-do.storage.test.ts",
] as const;
for (const suite of suites) {
  const result = spawnSync(process.execPath, ["test", "--timeout", "15000", `./${suite}`], {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: 45000,
    killSignal: "SIGKILL",
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    console.error(
      `Isolated Karaoke storage suite failed: ${suite}`,
      result.error?.message ?? result.signal ?? result.status,
    );
    process.exitCode = result.status !== null && result.status > 0 ? result.status : 1;
    break;
  }
}
