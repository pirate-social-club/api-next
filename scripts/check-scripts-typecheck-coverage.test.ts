import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findUncovered } from "./check-scripts-typecheck-coverage.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly scripts: Readonly<Record<string, string>> };

describe("scripts typecheck coverage", () => {
  test("reports entry points that no program typechecks", () => {
    const { uncovered, staleDeferred } = findUncovered(
      ["scripts/a.ts", "scripts/b.ts"],
      new Set(["scripts/a.ts"]),
      new Set(),
    );
    expect(uncovered).toEqual(["scripts/b.ts"]);
    expect(staleDeferred).toEqual([]);
  });

  test("accepts a deferred entry point and reports it once it becomes typechecked", () => {
    const deferred = new Set(["scripts/c.ts"]);
    expect(findUncovered(["scripts/c.ts"], new Set(), deferred)).toEqual({
      uncovered: [],
      staleDeferred: [],
    });
    expect(findUncovered(["scripts/c.ts"], new Set(["scripts/c.ts"]), deferred)).toEqual({
      uncovered: [],
      staleDeferred: ["scripts/c.ts"],
    });
  });

  test("runs the scripts program and the coverage regression through check", () => {
    expect(packageJson.scripts["check:scripts"]).toBe(
      "tsc --noEmit -p tsconfig.scripts.json && bun scripts/check-scripts-typecheck-coverage.ts",
    );
    expect(packageJson.scripts.check?.match(/bun run check:scripts/g)).toHaveLength(1);
  });
});
