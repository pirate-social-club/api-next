import { describe, expect, test } from "bun:test";
import { postgresGeneralSuiteCostEstimates } from "./postgres-test-suite-manifest.ts";
import {
  partitionPostgresRecoveryFiles,
  partitionPostgresTestFiles,
  postgresGeneralShardCount,
  postgresLockCapacityError,
  postgresLockTableEntries,
  postgresTestFileWeight,
  postgresTestSourceCallCount,
  postgresTestTimeoutMilliseconds,
  requiredPostgresLockTableEntries,
  shardPostgresTestFiles,
} from "./run-postgres-tests.ts";

describe("PostgreSQL lock capacity preflight", () => {
  test("a default postgres:17 server is refused before any suite starts", () => {
    const failure = postgresLockCapacityError({
      max_locks_per_transaction: 64,
      max_connections: 100,
      max_prepared_transactions: 0,
    });
    expect(failure).toContain("6400 entries");
    expect(failure).toContain(String(requiredPostgresLockTableEntries));
  });

  test("the CI and rehearsal setting passes exactly at the audited bound", () => {
    expect(
      postgresLockTableEntries({
        max_locks_per_transaction: 512,
        max_connections: 100,
        max_prepared_transactions: 0,
      }),
    ).toBe(requiredPostgresLockTableEntries);
    expect(
      postgresLockCapacityError({
        max_locks_per_transaction: 512,
        max_connections: 100,
        max_prepared_transactions: 0,
      }),
    ).toBeNull();
  });

  test("prepared transactions count toward capacity, as they do in the guard", () => {
    expect(
      postgresLockTableEntries({
        max_locks_per_transaction: 512,
        max_connections: 80,
        max_prepared_transactions: 20,
      }),
    ).toBe(requiredPostgresLockTableEntries);
  });
});

describe("PostgreSQL test discovery", () => {
  test("allows the complete general suite fifteen minutes", () => {
    expect(postgresTestTimeoutMilliseconds).toEqual({
      isolated: 120_000,
      general: 900_000,
    });
  });

  test("balances every general file across five independent CI shards", () => {
    expect(postgresGeneralShardCount).toBe(5);
    const files = [
      "heavy.pg.test.ts",
      "medium.pg.test.ts",
      "small-a.pg.test.ts",
      "small-b.pg.test.ts",
      "small-c.pg.test.ts",
    ];
    const weights = {
      "heavy.pg.test.ts": 8,
      "medium.pg.test.ts": 6,
      "small-a.pg.test.ts": 2,
      "small-b.pg.test.ts": 2,
      "small-c.pg.test.ts": 1,
    };
    const shards = shardPostgresTestFiles(files, postgresGeneralShardCount, weights);

    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });

  test("uses observed whole-file costs while source growth and unmeasured profiles stay bounded", () => {
    const file = "packages/platform-cf/src/data-registration-repository.pg.test.ts";
    const cost = postgresGeneralSuiteCostEstimates[file];
    if (cost === undefined) throw new Error("Required historical cost was missing");
    expect(postgresTestFileWeight(file, cost.sourceCallCount)).toBe(
      Math.ceil(cost.milliseconds / 100),
    );
    expect(postgresTestFileWeight(file, 1)).toBe(Math.ceil(cost.milliseconds / 100));
    expect(postgresTestFileWeight(file, cost.sourceCallCount * 2)).toBe(
      Math.ceil(cost.milliseconds / 50),
    );
    expect(
      postgresTestFileWeight("packages/platform-cf/src/hns-incident-evidence.pg.test.ts", 1),
    ).toBe(20);
    expect(() => postgresTestFileWeight("unclassified.pg.test.ts", 2)).toThrow(
      "PostgreSQL test suite is not classified for shard weighting",
    );
  });

  test("redistributes the observed required workload across five shards without losing any tracked file", async () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "*.pg.test.ts"]);
    expect(tracked.exitCode).toBe(0);
    const files = tracked.stdout
      .toString()
      .split("\0")
      .filter((file) => file.length > 0);
    const audited = partitionPostgresRecoveryFiles(
      partitionPostgresTestFiles(files).general,
    ).audited;
    const entries = await Promise.all(
      audited.map(
        async (file) =>
          [
            file,
            postgresTestFileWeight(file, postgresTestSourceCallCount(await Bun.file(file).text())),
          ] as const,
      ),
    );
    const weights = Object.fromEntries(entries);
    const shards = shardPostgresTestFiles(audited, postgresGeneralShardCount, weights);
    expect(shards).toHaveLength(5);
    expect(shards.flat().sort()).toEqual([...audited].sort());
    expect(new Set(shards.flat()).size).toBe(audited.length);
    const media = "packages/platform-cf/src/media-persistence.pg.test.ts";
    const video = "packages/platform-cf/src/video-workflow-composed.pg.test.ts";
    expect(shards.findIndex((shard) => shard.includes(media))).not.toBe(
      shards.findIndex((shard) => shard.includes(video)),
    );
    const totals = shards.map((shard) =>
      shard.reduce((sum, file) => sum + (weights[file] ?? 0), 0),
    );
    // Reviewed current observations + explicit tail bounds leave about192s per
    // shard. Historical planning cannot substitute for five actual green runs.
    expect(Math.max(...totals) * 100).toBeLessThanOrEqual(720_000);
    const four = shardPostgresTestFiles(audited, 4, weights);
    const fourTotals = four.map((shard) =>
      shard.reduce((sum, file) => sum + (weights[file] ?? 0), 0),
    );
    expect(Math.max(...fourTotals) * 100).toBeGreaterThanOrEqual(880_000);
    for (const [file, cost] of Object.entries(postgresGeneralSuiteCostEstimates)) {
      expect(audited).toContain(file);
      expect(Number.isSafeInteger(cost.milliseconds) && cost.milliseconds > 0).toBe(true);
      expect(Number.isSafeInteger(cost.sourceCallCount) && cost.sourceCallCount > 0).toBe(true);
    }
  });

  test("counts native pgTest aliases in the same shard model as ordinary calls", async () => {
    const source = [
      "const pgTest = pgUrl ? test : test.skip;",
      'test("ordinary", () => undefined);',
      'pgTest("native", () => undefined);',
      'pgTest.skip("native absent", () => undefined);',
    ].join("\n");
    expect(postgresTestSourceCallCount(source)).toBe(3);
    expect(postgresTestSourceCallCount("const pgTest = pgUrl ? test : test.skip;")).toBe(0);
    // These exact new groups must reach the normal required PostgreSQL shard,
    // keeping real pgTest discovery and the existing independent category model.
    for (const file of [
      "packages/platform-cf/src/owner-megapot-creator.pg.test.ts",
      "apps/http-worker/src/owner-financial-default-worker.pg.test.ts",
    ]) {
      const nativeSource = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      const nativeCount = postgresTestSourceCallCount(nativeSource);
      expect(nativeCount).toBe(3);
      expect(postgresTestFileWeight(file, nativeCount)).toBe(60);
    }
    // The full current four-case readiness group is measured as one complete
    // file; alias discovery never restores the old one-call weight20.
    expect(
      postgresTestFileWeight(
        "packages/platform-cf/src/guest-study-managed-readiness.pg.test.ts",
        4,
      ),
    ).toBe(810);
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

    expect(partition.isolated).toEqual([
      "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts",
    ]);
    expect([...partition.isolated, ...partition.general].sort()).toEqual([...files].sort());
    expect(partition.general).not.toContain(partition.isolated[0]);
    const ci = partitionPostgresRecoveryFiles(partition.general);
    expect(ci.recovery).toEqual(["scripts/staging-persona-phased-reset.pg.test.ts"]);
    expect(ci.hnsRegtest).toEqual([
      "packages/platform-cf/src/hns-lifecycle-composed-path.pg.test.ts",
      "packages/platform-cf/src/hns-service-loop-entrypoint.pg.test.ts",
    ]);
    expect([...partition.isolated, ...ci.recovery, ...ci.hnsRegtest, ...ci.audited].sort()).toEqual(
      [...files].sort(),
    );
    expect(ci.recovery.some((file) => ci.audited.includes(file))).toBe(false);
    expect(ci.hnsRegtest.some((file) => ci.audited.includes(file))).toBe(false);
    expect(() => partitionPostgresRecoveryFiles(ci.audited)).toThrow("recovery suite is missing");
    expect(partition.general).toContain("scripts/hns-continuity/promotion.pg.test.ts");
    expect(partition.general).toContain(
      "packages/platform-cf/src/hns-root-import-repository.pg.test.ts",
    );
    expect(partition.general).toContain(
      "packages/platform-cf/src/hns-community-root-import-repository.pg.test.ts",
    );
  });

  test("CI requires Docker recovery separately without removing general egress auditing", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    const recovery =
      workflow.match(/\n {2}postgres17-recovery:\n([\s\S]*?)\n {2}postgres17-general:\n/u)?.[1] ??
      "";
    expect(recovery).toContain("CONTROL_PLANE_POSTGRES_TEST_PARTITION: recovery");
    expect(recovery).toContain(
      "CONTROL_PLANE_POSTGRES_RECOVERY_TEST_CONTAINER: " + "$" + "{{ job.services.postgres.id }}",
    );
    expect(recovery).toContain("fetch-depth: 0");
    expect(recovery).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("CONTROL_PLANE_POSTGRES_TEST_PARTITION: audited-general-shard");
    expect(workflow).toContain(
      "needs: [postgres17-namespace, postgres17-recovery, postgres17-general, postgres18-shape]",
    );
    expect(workflow).toContain('[[ "$RECOVERY_RESULT" == "success" ]]');
    expect(workflow).toContain('[[ "$PG18_SHAPE_RESULT" == "success" ]]');
  });

  test("assigns each song-video sentinel to exactly one shard without pinning its upload", async () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "*.pg.test.ts"]);
    expect(tracked.exitCode).toBe(0);
    const files = tracked.stdout
      .toString()
      .split("\0")
      .filter((file) => file.length > 0);
    const partition = partitionPostgresTestFiles(files);
    const audited = partitionPostgresRecoveryFiles(partition.general).audited;
    const weights: Record<string, number> = {};
    for (const file of partition.general) {
      const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      const testCount = postgresTestSourceCallCount(source);
      weights[file] = postgresTestFileWeight(file, testCount);
    }
    const shards = shardPostgresTestFiles(audited, postgresGeneralShardCount, weights);
    expect(shards.flat().sort()).toEqual([...audited].sort());
    expect(new Set(shards.flat()).size).toBe(audited.length);
    const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    for (const target of [
      {
        file: "scripts/song-video-composed-flow.pg.test.ts",
        step: "song-video composed flow",
        output: "composed_flow",
      },
      {
        file: "scripts/song-video-render-host.pg.test.ts",
        step: "song-video render host",
        output: "render_host",
      },
    ]) {
      const owner = shards.findIndex((shard) => shard.includes(target.file));
      expect(owner).toBeGreaterThanOrEqual(0);
      expect(shards.filter((shard) => shard.includes(target.file))).toHaveLength(1);
      console.log(`${target.step} sentinel owner: general-${owner}`);
      expect(workflow).toContain(
        `- name: Upload ${target.step} sentinel\n        if: steps.song-video-sentinels.outputs.${target.output} == 'true'`,
      );
    }
  });
});
