const namespaceOwnershipTest =
  "packages/platform-cf/src/namespace-ownership-persistence.pg.test.ts";

export const postgresTestTimeoutMilliseconds = {
  isolated: 120_000,
  general: 900_000,
} as const;

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
  maxConcurrency?: number,
): Promise<void> {
  const command = [
    process.execPath,
    "test",
    "--timeout",
    "15000",
    ...(maxConcurrency === undefined ? [] : ["--max-concurrency", String(maxConcurrency)]),
    ...files,
  ];
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

export async function runPostgresTests(): Promise<void> {
  if (process.env.CONTROL_PLANE_POSTGRES_TEST_URL?.trim() === "") {
    throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
  }
  if (process.env.CONTROL_PLANE_POSTGRES_TEST_URL === undefined) {
    throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
  }
  const partition = partitionPostgresTestFiles(await trackedPostgresTestFiles());
  await runBunTests(
    "isolated namespace-ownership PostgreSQL suite",
    partition.isolated,
    postgresTestTimeoutMilliseconds.isolated,
  );
  await runBunTests(
    "general PostgreSQL suite",
    partition.general,
    postgresTestTimeoutMilliseconds.general,
    4,
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
