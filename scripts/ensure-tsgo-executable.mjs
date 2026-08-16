// CI bun installs can drop the executable bit on @effect/tsgo's platform
// binary (spawnSync EACCES on the runner). Restore it before diagnostics.
// Plain readdir walk: fs.globSync matches nothing under bun.
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const store = "node_modules/.bun";
let restored = 0;
let found = 0;
let entries = [];
try {
  entries = readdirSync(store);
} catch {
  entries = [];
}
for (const entry of entries) {
  if (!entry.startsWith("@effect+tsgo-")) continue;
  const inner = join(store, entry, "node_modules", "@effect");
  let platforms = [];
  try {
    platforms = readdirSync(inner);
  } catch {
    continue;
  }
  for (const platform of platforms) {
    const tsc = join(inner, platform, "lib", "tsc");
    try {
      const mode = statSync(tsc).mode;
      found += 1;
      if ((mode & 0o111) === 0) {
        chmodSync(tsc, mode | 0o755);
        restored += 1;
      }
    } catch {
      // no lib/tsc in this platform package
    }
  }
}
if (found === 0) {
  console.warn("ensure-tsgo-executable: no tsgo platform binary found");
} else if (restored > 0) {
  console.log(
    `ensure-tsgo-executable: restored exec bit on ${restored} binar${restored === 1 ? "y" : "ies"}`,
  );
}
