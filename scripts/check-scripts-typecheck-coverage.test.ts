import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  entryPointsFromTexts,
  findUncovered,
  programTypechecks,
  reachableScripts,
  unwiredPrograms,
} from "./check-scripts-typecheck-coverage.ts";

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

  describe("entry point discovery", () => {
    test("finds literal script paths in package and workflow text", () => {
      expect(entryPointsFromTexts(["bun scripts/alpha.ts --flag", "node scripts/beta.ts"])).toEqual(
        ["scripts/alpha.ts", "scripts/beta.ts"],
      );
    });

    test("excludes test paths and deduplicates across sources", () => {
      expect(
        entryPointsFromTexts([
          "bun scripts/alpha.ts && bun scripts/alpha.ts",
          "run: bun test scripts/gamma.pg18.test.ts",
        ]),
      ).toEqual(["scripts/alpha.ts"]);
    });

    test("does not discover dynamically constructed commands", () => {
      const interpolation = ["bun scripts/", "$", "{name}.ts"].join("");
      expect(entryPointsFromTexts([interpolation, "bun $(ls scripts)/tool.ts"])).toEqual([]);
    });
  });

  describe("check chain wiring", () => {
    const baseline: Readonly<Record<string, string>> = {
      check: "tsc --noEmit -p tsconfig.a.json && bun run check:scripts",
      "check:scripts":
        "tsc --noEmit -p tsconfig.scripts.json && bun scripts/check-scripts-typecheck-coverage.ts",
    };
    const programs: ReadonlyMap<string, readonly string[]> = new Map([
      ["tsconfig.a.json", ["check"]],
      ["tsconfig.scripts.json", ["check:scripts"]],
    ]);

    test("accepts a fully wired chain", () => {
      expect(unwiredPrograms(programs, baseline)).toEqual([]);
    });

    test("reports a program whose script is no longer reached from check", () => {
      const scripts = { ...baseline, check: "tsc --noEmit -p tsconfig.a.json" };
      expect(unwiredPrograms(programs, scripts)).toEqual(["tsconfig.scripts.json"]);
    });

    test("reports a program whose semantic typecheck was removed", () => {
      const scripts = {
        ...baseline,
        "check:scripts": "bun scripts/check-scripts-typecheck-coverage.ts",
      };
      expect(unwiredPrograms(programs, scripts)).toEqual(["tsconfig.scripts.json"]);
    });

    test("reports a program wired only to an unreached script", () => {
      const scripts = {
        ...baseline,
        "check:orphan": "tsc --noEmit -p tsconfig.orphan.json",
      };
      const extended = new Map<string, readonly string[]>([
        ...programs,
        ["tsconfig.orphan.json", ["check:orphan"]],
      ]);
      expect(unwiredPrograms(extended, scripts)).toEqual(["tsconfig.orphan.json"]);
    });

    test("follows only literal bun run references", () => {
      const reached = reachableScripts(
        {
          check: "bun run a && bun run b",
          a: "bun run c",
          b: "echo done",
          c: "echo done",
        },
        ["check"],
      );
      expect([...reached].sort()).toEqual(["a", "b", "c", "check"]);
    });

    test("the real check chain executes every credited program", () => {
      expect(unwiredPrograms(programTypechecks, packageJson.scripts)).toEqual([]);
    });
  });

  test("runs the scripts program and the coverage regression through check", () => {
    expect(packageJson.scripts["check:scripts"]).toBe(
      "tsc --noEmit -p tsconfig.scripts.json && bun scripts/check-scripts-typecheck-coverage.ts",
    );
    expect(packageJson.scripts.check?.match(/bun run check:scripts/g)).toHaveLength(1);
  });
});
