import { describe, expect, test } from "bun:test";
import {
  classifiedPostgresTestSuites,
  freshSchemaPostgresTestSuites,
  noBaselinePostgresTestSuites,
  reusablePostgresTestSuites,
} from "./postgres-test-suite-manifest.ts";

describe("PostgreSQL test suite isolation manifest", () => {
  test("classifies every tracked suite exactly once", () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "*.pg.test.ts"]);
    expect(tracked.exitCode).toBe(0);
    const files = tracked.stdout.toString().split("\n").filter(Boolean).sort();
    const classified = [...classifiedPostgresTestSuites].sort();

    expect(new Set(classified).size).toBe(classified.length);
    expect(classified).toEqual(files);
  });

  test("keeps reusable, fresh-schema, and no-baseline suites disjoint", () => {
    const reusable = new Set<string>(reusablePostgresTestSuites);
    const fresh = new Set<string>(freshSchemaPostgresTestSuites);
    const noBaseline = new Set<string>(noBaselinePostgresTestSuites);

    expect([...reusable].filter((file) => fresh.has(file) || noBaseline.has(file))).toEqual([]);
    expect([...fresh].filter((file) => noBaseline.has(file))).toEqual([]);
  });

  test("requires every reusable suite to opt into the reusable fixture", async () => {
    const missing: string[] = [];
    for (const file of reusablePostgresTestSuites) {
      const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      if (
        !source.includes("withReusablePostgresTestSchema") &&
        !source.includes("resetPostgresTestBaseline")
      ) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});
