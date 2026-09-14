import { describe, expect, test } from "bun:test";

describe("rating reconciliation CLI", () => {
  test("documents the read-only default without opening a database", () => {
    const run = Bun.spawnSync([process.execPath, "scripts/reconcile-content-ratings.ts", "--help"]);
    expect(run.exitCode).toBe(0);
    expect(new TextDecoder().decode(run.stdout)).toContain("Defaults to a read-only plan");
  });
  test("rejects ambiguous or unpinned writes before connection", () => {
    for (const args of [
      ["--apply"],
      ["--database-url-env", "TEST_DATABASE", "--apply"],
      ["--database-url-env", "TEST_DATABASE", "--limit", "101"],
      ["--database-url-env", "TEST_DATABASE", "--limit", "1", "--limit", "2"],
      ["--database-url-env", "TEST_DATABASE", "--plan-hash", "a".repeat(64)],
    ]) {
      const run = Bun.spawnSync(
        [process.execPath, "scripts/reconcile-content-ratings.ts", ...args],
        {
          env: {
            ...process.env,
            TEST_DATABASE: "postgres://secret:private@unreachable.invalid/db",
          },
        },
      );
      expect(run.exitCode).toBe(1);
      expect(new TextDecoder().decode(run.stderr)).not.toContain("secret");
      expect(new TextDecoder().decode(run.stderr)).not.toContain("private@");
    }
  });
});
