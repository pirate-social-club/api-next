import {
  freshSchemaPostgresTestSuites,
  noBaselinePostgresTestSuites,
  reusablePostgresTestSuites,
} from "./postgres-test-suite-manifest.ts";

const namespaceOwnershipTest =
  "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts";

const reusableSuites = new Set<string>(reusablePostgresTestSuites);
const freshSchemaSuites = new Set<string>(freshSchemaPostgresTestSuites);
const noBaselineSuites = new Set<string>(noBaselinePostgresTestSuites);

export const postgresTestTimeoutMilliseconds = {
  isolated: 120_000,
  general: 900_000,
} as const;

export const postgresGeneralShardCount = 4;

// Weight units approximate tenths of a second from the first baseline-reuse benchmark:
// reusable suites pay once for installation, then once per reset and test; other suites
// conservatively retain the pre-reuse per-test cost. The values only balance shards.
const reusableBaselineInstallWeight = 14;
const reusableTestWeight = 11;
const independentTestWeight = 20;

type PostgresTestPartition = {
  readonly isolated: readonly string[];
  readonly general: readonly string[];
};

export function partitionPostgresTestFiles(files: readonly string[]): PostgresTestPartition {
  const postgresTests = [...new Set(files)].filter((file) => file.endsWith(".pg.test.ts")).sort();
  if (!postgresTests.includes(namespaceOwnershipTest)) {
    throw new Error(`tracked PostgreSQL suite is missing ${namespaceOwnershipTest}`);
  }
  return {
    isolated: [namespaceOwnershipTest],
    general: postgresTests.filter((file) => file !== namespaceOwnershipTest),
  };
}

async function trackedPostgresTestFiles(): Promise<readonly string[]> {
  const child = Bun.spawn(["git", "ls-files", "-z", "*.pg.test.ts"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ls-files failed with exit ${exitCode}`);
  }
  return stdout.split("\0").filter((file) => file.length > 0);
}

async function runBunTests(
  label: string,
  files: readonly string[],
  timeoutMilliseconds: number,
): Promise<void> {
  const command = [process.execPath, "test", "--timeout", "15000", ...files];
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      CONTROL_PLANE_POSTGRES_TEST_REQUIRED: "1",
      CONTROL_PLANE_POSTGRES_BACKFILL_TEST_REQUIRED: "1",
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  const timeout = setTimeout(() => child.kill(), timeoutMilliseconds);
  try {
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${label} failed with exit ${exitCode}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function shardPostgresTestFiles(
  files: readonly string[],
  shardCount: number,
  weights: Readonly<Record<string, number>>,
): readonly (readonly string[])[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("PostgreSQL test shard count must be a positive integer");
  }
  const shards = Array.from({ length: shardCount }, () => [] as string[]);
  const shardWeights = Array.from({ length: shardCount }, () => 0);
  const weightedFiles = [...files].sort((left, right) => {
    const difference = (weights[right] ?? 1) - (weights[left] ?? 1);
    return difference === 0 ? left.localeCompare(right) : difference;
  });
  for (const file of weightedFiles) {
    let lightestShardIndex = 0;
    for (let index = 1; index < shardWeights.length; index += 1) {
      if ((shardWeights[index] ?? 0) < (shardWeights[lightestShardIndex] ?? 0)) {
        lightestShardIndex = index;
      }
    }
    shards[lightestShardIndex]?.push(file);
    shardWeights[lightestShardIndex] =
      (shardWeights[lightestShardIndex] ?? 0) + (weights[file] ?? 1);
  }
  return shards;
}

export function postgresTestFileWeight(file: string, testCount: number): number {
  const normalizedTestCount = Math.max(testCount, 1);
  if (reusableSuites.has(file)) {
    return reusableBaselineInstallWeight + reusableTestWeight * normalizedTestCount;
  }
  if (freshSchemaSuites.has(file) || noBaselineSuites.has(file)) {
    return independentTestWeight * normalizedTestCount;
  }
  throw new Error(`PostgreSQL test suite is not classified for shard weighting: ${file}`);
}

async function postgresTestWeights(
  files: readonly string[],
): Promise<Readonly<Record<string, number>>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const source = await Bun.file(file).text();
      const testCount = source.match(/\btest(?:\.skip)?\s*\(/gu)?.length ?? 0;
      return [file, postgresTestFileWeight(file, testCount)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function requiredShardCoordinate(name: string): number {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export async function runPostgresTests(): Promise<void> {
  if (process.env.CONTROL_PLANE_POSTGRES_TEST_URL?.trim() === "") {
    throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
  }
  if (process.env.CONTROL_PLANE_POSTGRES_TEST_URL === undefined) {
    throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
  }
  const partition = partitionPostgresTestFiles(await trackedPostgresTestFiles());
  const mode = process.env.CONTROL_PLANE_POSTGRES_TEST_PARTITION?.trim() || "all";
  if (mode === "all" || mode === "isolated") {
    await runBunTests(
      "isolated namespace-ownership PostgreSQL suite",
      partition.isolated,
      postgresTestTimeoutMilliseconds.isolated,
    );
  }
  if (mode === "all") {
    await runBunTests(
      "general PostgreSQL suite",
      partition.general,
      postgresTestTimeoutMilliseconds.general,
    );
    return;
  }
  if (mode === "isolated") return;
  if (mode !== "general-shard") {
    throw new Error(`Unknown PostgreSQL test partition: ${mode}`);
  }

  const shardIndex = requiredShardCoordinate("CONTROL_PLANE_POSTGRES_TEST_SHARD_INDEX");
  const shardCount = requiredShardCoordinate("CONTROL_PLANE_POSTGRES_TEST_SHARD_COUNT");
  if (shardCount < 1 || shardIndex >= shardCount) {
    throw new Error("PostgreSQL test shard index must be less than the positive shard count");
  }
  const shards = shardPostgresTestFiles(
    partition.general,
    shardCount,
    await postgresTestWeights(partition.general),
  );
  await runBunTests(
    `general PostgreSQL shard ${shardIndex + 1}/${shardCount}`,
    shards[shardIndex] ?? [],
    postgresTestTimeoutMilliseconds.general,
  );
}

if (import.meta.main) {
  try {
    await runPostgresTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "PostgreSQL test runner failed");
    process.exitCode = 1;
  }
}
