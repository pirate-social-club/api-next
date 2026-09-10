import { Client } from "pg";
import {
  freshSchemaPostgresTestSuites,
  noBaselinePostgresTestSuites,
  reusablePostgresTestSuites,
} from "./postgres-test-suite-manifest.ts";

/**
 * The staging rehearsal established this lower bound: a full removal plus the
 * complete migration replay holds both object sets until commit, and the
 * persona reset suite refuses to run below it with
 * `reset_lock_capacity_below_rehearsal`. A default `postgres:17` container
 * gives 64 * 100 = 6,400 entries, which presents as three test failures that
 * look like code defects. CI provisions 512 * 100 = 51,200 through
 * `POSTGRES_INITDB_ARGS=--set=max_locks_per_transaction=512`; local runs need
 * the same capacity or this preflight refuses before any suite starts.
 */
export const requiredPostgresLockTableEntries = 51_200;

export type PostgresLockSettings = Readonly<{
  readonly max_locks_per_transaction: number;
  readonly max_connections: number;
  readonly max_prepared_transactions: number;
}>;

export function postgresLockTableEntries(settings: PostgresLockSettings): number {
  return (
    settings.max_locks_per_transaction *
    (settings.max_connections + settings.max_prepared_transactions)
  );
}

export function postgresLockCapacityError(settings: PostgresLockSettings): string | null {
  const entries = postgresLockTableEntries(settings);
  if (Number.isSafeInteger(entries) && entries >= requiredPostgresLockTableEntries) return null;
  return [
    `PostgreSQL lock-table capacity is ${entries} entries, below the required ${requiredPostgresLockTableEntries}.`,
    "Start the server with a larger lock table before running this gate, for example",
    "`docker run ... -e POSTGRES_INITDB_ARGS=--set=max_locks_per_transaction=512 postgres:17`",
    "(512 * 100 = 51,200) or add `-c max_locks_per_transaction=1024 -c max_connections=200`",
    "to the server's start arguments. A capacity failure is configuration, not a code defect.",
  ].join(" ");
}

export async function verifyPostgresLockCapacity(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(
      `SELECT current_setting('max_locks_per_transaction')::bigint AS max_locks_per_transaction,
              current_setting('max_connections')::bigint AS max_connections,
              current_setting('max_prepared_transactions')::bigint AS max_prepared_transactions`,
    );
    const row = result.rows[0];
    const settings: PostgresLockSettings = {
      max_locks_per_transaction: Number(row?.max_locks_per_transaction),
      max_connections: Number(row?.max_connections),
      max_prepared_transactions: Number(row?.max_prepared_transactions),
    };
    const failure = postgresLockCapacityError(settings);
    if (failure !== null) throw new Error(failure);
    console.log(
      `PostgreSQL lock capacity: ${postgresLockTableEntries(settings)} entries ` +
        `(max_locks_per_transaction=${settings.max_locks_per_transaction}, ` +
        `max_connections=${settings.max_connections}, ` +
        `max_prepared_transactions=${settings.max_prepared_transactions})`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

const namespaceOwnershipTest =
  "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts";
const dockerRecoveryTests = [
  "scripts/staging-persona-phased-reset.pg.test.ts",
  "scripts/staging-persona-recovery.pg.test.ts",
] as const;

/** CI's audited runners cannot use Docker. Local general/all partitions
 * still cover every file; CI splits exactly these recovery transport suites
 * into a separately required job, never an optional skip flag. */
export function partitionPostgresRecoveryFiles(files: readonly string[]) {
  for (const file of dockerRecoveryTests) {
    if (!files.includes(file))
      throw new Error(`tracked PostgreSQL recovery suite is missing ${file}`);
  }
  return {
    recovery: [...dockerRecoveryTests],
    audited: files.filter((file) => !dockerRecoveryTests.some((recovery) => recovery === file)),
  };
}

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

// Minimums capture suites whose first required-CI timing materially exceeded the category
// estimate. New and ordinary suites continue to use the fixture-aware model above.
const measuredMinimumWeights: Readonly<Record<string, number>> = {
  "packages/platform-cf/src/community-route-repository.pg.test.ts": 280,
  "packages/platform-cf/src/content-repository.pg.test.ts": 510,
  "packages/platform-cf/src/handle-sales-repository.pg.test.ts": 215,
  "packages/platform-cf/src/hns-control-observer-repository.pg.test.ts": 272,
  "packages/platform-cf/src/postgres.pg.test.ts": 102,
  "packages/platform-cf/src/text-submission-repository.pg.test.ts": 165,
};

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
  let estimatedWeight: number;
  if (reusableSuites.has(file)) {
    estimatedWeight = reusableBaselineInstallWeight + reusableTestWeight * normalizedTestCount;
  } else if (freshSchemaSuites.has(file) || noBaselineSuites.has(file)) {
    estimatedWeight = independentTestWeight * normalizedTestCount;
  } else {
    throw new Error(`PostgreSQL test suite is not classified for shard weighting: ${file}`);
  }
  return Math.max(estimatedWeight, measuredMinimumWeights[file] ?? 0);
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
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
  }
  await verifyPostgresLockCapacity(connectionString);
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
  if (mode === "recovery") {
    await runBunTests(
      "PostgreSQL recovery suite",
      partitionPostgresRecoveryFiles(partition.general).recovery,
      postgresTestTimeoutMilliseconds.general,
    );
    return;
  }
  if (mode !== "general-shard" && mode !== "audited-general-shard") {
    throw new Error(`Unknown PostgreSQL test partition: ${mode}`);
  }

  const shardIndex = requiredShardCoordinate("CONTROL_PLANE_POSTGRES_TEST_SHARD_INDEX");
  const shardCount = requiredShardCoordinate("CONTROL_PLANE_POSTGRES_TEST_SHARD_COUNT");
  if (shardCount < 1 || shardIndex >= shardCount) {
    throw new Error("PostgreSQL test shard index must be less than the positive shard count");
  }
  const shards = shardPostgresTestFiles(
    mode === "audited-general-shard"
      ? partitionPostgresRecoveryFiles(partition.general).audited
      : partition.general,
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
