import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHsdRegtest } from "../packages/platform-cf/src/hns-regtest-node.pg-fixture.ts";
import { verifyPostgresLockCapacity } from "./run-postgres-tests.ts";

export const hnsRegtestTargets = [
  {
    file: "packages/platform-cf/src/hns-lifecycle-composed-path.pg.test.ts",
    sentinelVariable: "HNS_REGTEST_COMPOSED_PATH_SENTINEL",
    sentinelFilename: "composed-path-suite-complete",
    sentinelContents: "api-next-hns-regtest-composed-path-suite-complete\n",
    expectedTestCount: 1,
    timeoutMilliseconds: 660_000,
  },
  {
    file: "packages/platform-cf/src/hns-service-loop-entrypoint.pg.test.ts",
    sentinelVariable: "HNS_REGTEST_SERVICE_LOOP_SENTINEL",
    sentinelFilename: "service-loop-suite-complete",
    sentinelContents: "api-next-hns-regtest-service-loop-suite-complete\n",
    expectedTestCount: 1,
    timeoutMilliseconds: 960_000,
  },
] as const;

export function hnsRegtestTargetError(files: readonly string[]): string | null {
  const expected = hnsRegtestTargets.map(({ file }) => file);
  if (files.length !== expected.length) {
    return `expected ${expected.length} HNS regtest targets, received ${files.length}`;
  }
  for (const file of expected) {
    if (!files.includes(file)) return `required HNS regtest target is missing: ${file}`;
  }
  return null;
}

export function sanitizeHnsRegtestDiagnostic(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, "postgres://[redacted]@");
}

export function hnsRegtestPostgresError(connectionString: string | undefined): string | null {
  return connectionString?.trim() ? null : "required HNS regtest PostgreSQL fixture is missing";
}

export function hnsRegtestChildError(file: string, exitCode: number): string | null {
  return exitCode === 0 ? null : `${file} failed with exit ${exitCode}`;
}

export function hnsRegtestReceiptError(
  file: string,
  actual: string,
  expected: string,
): string | null {
  return actual === expected ? null : `${file} did not write its required completion sentinel`;
}

export function hnsRegtestTestCountError(
  file: string,
  actual: number,
  expected: number,
): string | null {
  return actual === expected
    ? null
    : `${file} declares ${actual} tests; required gate expects exactly ${expected}`;
}

async function trackedTargets(): Promise<readonly string[]> {
  const child = Bun.spawn(["git", "ls-files", "-z", ...hnsRegtestTargets.map(({ file }) => file)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ls-files failed with exit ${exitCode}`);
  return stdout.split("\0").filter(Boolean);
}

async function sourceSha(): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `git rev-parse failed with exit ${exitCode}`);
  return stdout.trim();
}

async function runTarget(
  target: (typeof hnsRegtestTargets)[number],
  sentinelPath: string,
): Promise<void> {
  await rm(sentinelPath, { force: true });
  const child = Bun.spawn([process.execPath, "test", "--timeout", "15000", target.file], {
    env: {
      ...process.env,
      HNS_REGTEST_TEST_REQUIRED: "1",
      [target.sentinelVariable]: sentinelPath,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill(), target.timeoutMilliseconds);
  try {
    const exitCode = await child.exited;
    const childFailure = hnsRegtestChildError(target.file, exitCode);
    if (childFailure !== null) throw new Error(childFailure);
  } finally {
    clearTimeout(timer);
  }
  const marker = await readFile(sentinelPath, "utf8").catch(() => "");
  const receiptFailure = hnsRegtestReceiptError(target.file, marker, target.sentinelContents);
  if (receiptFailure !== null) throw new Error(receiptFailure);
}

export async function runHnsRegtestTests(): Promise<void> {
  const targetFailure = hnsRegtestTargetError(await trackedTargets());
  if (targetFailure !== null) throw new Error(targetFailure);
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL?.trim();
  const postgresFailure = hnsRegtestPostgresError(connectionString);
  if (postgresFailure !== null) throw new Error(postgresFailure);
  if (connectionString === undefined || connectionString === "") {
    throw new Error("required HNS regtest PostgreSQL fixture is missing");
  }
  for (const target of hnsRegtestTargets) {
    const source = await Bun.file(target.file).text();
    const testCount = source.match(/\btest(?:\.skip)?\s*\(/gu)?.length ?? 0;
    const countFailure = hnsRegtestTestCountError(target.file, testCount, target.expectedTestCount);
    if (countFailure !== null) throw new Error(countFailure);
  }
  await verifyPostgresLockCapacity(connectionString);
  await requireHsdRegtest();
  const receiptDirectory = await mkdtemp(join(tmpdir(), "api-next-hns-regtest-run-"));
  try {
    for (const target of hnsRegtestTargets) {
      await runTarget(target, join(receiptDirectory, target.sentinelFilename));
    }

    const report = {
      source_sha: await sourceSha(),
      executed_test_files: hnsRegtestTargets.map(({ file }) => file),
      executed_test_count: hnsRegtestTargets.reduce(
        (count, target) => count + target.expectedTestCount,
        0,
      ),
      completed_suite_count: hnsRegtestTargets.length,
      hsd_version: "8.0.0",
      hsd_image: process.env.HSD_REGTEST_IMAGE ?? "unrecorded",
      postgres_image: process.env.CONTROL_PLANE_POSTGRES_IMAGE ?? "unrecorded",
    };
    const reportPath = process.env.HNS_REGTEST_REPORT_PATH ?? join(receiptDirectory, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally {
    if (process.env.HNS_REGTEST_PRESERVE_RECEIPTS !== "1") {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  try {
    await runHnsRegtestTests();
  } catch (error) {
    console.error(
      sanitizeHnsRegtestDiagnostic(
        error instanceof Error ? error.message : "HNS regtest runner failed",
      ),
    );
    process.exitCode = 1;
  }
}
