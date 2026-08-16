// CI bun installs can drop the executable bit on @effect/tsgo's platform
// binary (spawnSync EACCES on the runner; unreproducible locally where the
// bun store already carries the bit). Restore it before diagnostics run.
import { chmodSync, globSync, statSync } from "node:fs";

const candidates = globSync("node_modules/.bun/@effect+tsgo-*/node_modules/@effect/tsgo-*/lib/tsc");
for (const path of candidates) {
  const mode = statSync(path).mode;
  if ((mode & 0o111) === 0) chmodSync(path, mode | 0o755);
}
if (candidates.length === 0) {
  console.warn("ensure-tsgo-executable: no tsgo platform binary found");
}
