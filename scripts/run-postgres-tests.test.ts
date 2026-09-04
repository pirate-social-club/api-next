import { describe, expect, test } from "bun:test";
import {
  partitionPostgresTestFiles,
  postgresGeneralShardCount,
  postgresTestFileWeight,
  postgresTestTimeoutMilliseconds,
  shardPostgresTestFiles,
} from "./run-postgres-tests.ts";

describe("PostgreSQL test discovery", () => {
  test("allows the complete general suite fifteen minutes", () => {
    expect(postgresTestTimeoutMilliseconds).toEqual({
      isolated: 120_000,
      general: 900_000,
    });
  });

  test("balances every general file across four independent CI shards", () => {
    expect(postgresGeneralShardCount).toBe(4);
    const files = [
      "heavy.pg.test.ts",
      "medium.pg.test.ts",
      "small-a.pg.test.ts",
      "small-b.pg.test.ts",
    ];
    const weights = {
      "heavy.pg.test.ts": 8,
      "medium.pg.test.ts": 6,
      "small-a.pg.test.ts": 2,
      "small-b.pg.test.ts": 2,
    };
    const shards = shardPostgresTestFiles(files, postgresGeneralShardCount, weights);

    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });

  test("weights reusable fixtures below fresh and migration-owned fixtures", () => {
    expect(
      postgresTestFileWeight(
        "packages/platform-cf/src/activity-qualification-repository.pg.test.ts",
        2,
      ),
    ).toBe(36);
    expect(
      postgresTestFileWeight("packages/platform-cf/src/data-registration-repository.pg.test.ts", 2),
    ).toBe(40);
    expect(
      postgresTestFileWeight("packages/platform-cf/src/community-route-migration.pg.test.ts", 2),
    ).toBe(40);
    expect(
      postgresTestFileWeight("packages/platform-cf/src/content-repository.pg.test.ts", 2),
    ).toBe(510);
    expect(
      postgresTestFileWeight("packages/platform-cf/src/community-route-repository.pg.test.ts", 2),
    ).toBe(280);
    expect(() => postgresTestFileWeight("unclassified.pg.test.ts", 2)).toThrow(
      "PostgreSQL test suite is not classified for shard weighting",
    );
  });

  test("keeps the CI matrix and runner shard count in lockstep", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    const generalJob = workflow.match(
      /\n {2}postgres17-general:\n([\s\S]*?)\n {2}postgres17:\n/u,
    )?.[1];
    const matrix = generalJob?.match(/shard:\s*\[([^\]]+)\]/u)?.[1];
    const configuredCount = generalJob?.match(
      /CONTROL_PLANE_POSTGRES_TEST_SHARD_COUNT:\s*"(\d+)"/u,
    )?.[1];

    expect(generalJob).toBeDefined();
    expect(matrix).toBeDefined();
    expect(configuredCount).toBeDefined();
    const matrixShards = matrix?.split(",").map((shard) => Number(shard.trim()));
    expect(matrixShards).toEqual(
      Array.from({ length: postgresGeneralShardCount }, (_, index) => index),
    );
    expect(Number(configuredCount)).toBe(postgresGeneralShardCount);
  });

  test("rejects invalid shard counts", () => {
    expect(() => shardPostgresTestFiles([], 0, {})).toThrow(
      "PostgreSQL test shard count must be a positive integer",
    );
  });

  test("isolates the namespace timing suite and retains every other tracked suite", async () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "*.pg.test.ts"]);
    expect(tracked.exitCode).toBe(0);
    const files = tracked.stdout
      .toString()
      .split("\0")
      .filter((file) => file.length > 0);
    const partition = partitionPostgresTestFiles(files);

    expect(files).toHaveLength(52);
    expect(partition.isolated).toEqual([
      "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts",
    ]);
    expect([...partition.isolated, ...partition.general].sort()).toEqual([...files].sort());
    expect(partition.general).not.toContain(partition.isolated[0]);
    expect(partition.general).toContain(
      "packages/platform-cf/src/hns-root-import-repository.pg.test.ts",
    );
  });
});
