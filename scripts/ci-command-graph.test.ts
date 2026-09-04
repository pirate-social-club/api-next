import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly scripts: Readonly<Record<string, string>> };
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("CI command graph", () => {
  test("runs contract freshness through check only", () => {
    expect(packageJson.scripts.check?.match(/bun run check:fresh/g)).toHaveLength(1);
    expect(workflow).not.toContain("- run: bun run check:fresh");
  });

  test("runs the Knip ratchet implementation through check only", () => {
    expect(packageJson.scripts["check:knip"]).toBe("node scripts/knip-ratchet.mjs");
  });

  test("keeps script behavior tests in the unit discovery graph", () => {
    expect(packageJson.scripts["test:unit"]).toContain("scripts");
  });
});
