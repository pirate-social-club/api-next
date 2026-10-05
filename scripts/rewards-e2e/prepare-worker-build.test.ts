import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { workerConfigurations } from "./prepare-worker-build.mjs";

const root = resolve(import.meta.dir, "../..");

// The isolated plans are derived from the ordinary Worker configurations, so a
// change there must regenerate the tracked files in the same commit.
test("tracked isolated Worker plans match the current configurations", async () => {
  const plans = await workerConfigurations(root);
  for (const [kind, plan] of Object.entries(plans)) {
    const tracked = Bun.JSONC.parse(
      await readFile(resolve(root, `tests/rewards-e2e/${kind}.wrangler.jsonc`), "utf8"),
    );
    expect(JSON.stringify(tracked), kind).toBe(JSON.stringify(plan));
  }
});
