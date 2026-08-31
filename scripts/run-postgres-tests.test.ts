import { describe, expect, test } from "bun:test";
import { partitionPostgresTestFiles } from "./run-postgres-tests.ts";

describe("PostgreSQL test discovery", () => {
  test("isolates the namespace timing suite and retains every other tracked suite", async () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "*.pg.test.ts"]);
    expect(tracked.exitCode).toBe(0);
    const files = tracked.stdout
      .toString()
      .split("\0")
      .filter((file) => file.length > 0);
    const partition = partitionPostgresTestFiles(files);

    expect(files).toHaveLength(40);
    expect(partition.isolated).toEqual([
      "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts",
    ]);
    expect([...partition.isolated, ...partition.general].sort()).toEqual([...files].sort());
    expect(partition.general).not.toContain(partition.isolated[0]);
  });
});
