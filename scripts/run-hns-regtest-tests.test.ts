import { describe, expect, test } from "bun:test";
import {
  hnsRegtestChildError,
  hnsRegtestPostgresError,
  hnsRegtestReceiptError,
  hnsRegtestTargetError,
  hnsRegtestTargets,
  hnsRegtestTestCountError,
  sanitizeHnsRegtestDiagnostic,
} from "./run-hns-regtest-tests.ts";

describe("HNS regtest target gate", () => {
  test("requires exactly the maintained target suites", () => {
    const files = hnsRegtestTargets.map(({ file }) => file);
    expect(hnsRegtestTargetError(files)).toBeNull();
    expect(hnsRegtestTargetError(files.slice(1))).toContain("expected 2");
    expect(hnsRegtestTargetError([files[0] ?? "", "replacement.pg.test.ts"])).toContain(
      "required HNS regtest target is missing",
    );
  });

  test("redacts PostgreSQL credentials from diagnostics", () => {
    expect(
      sanitizeHnsRegtestDiagnostic(
        "connect postgres://fixture-user:fixture-password@127.0.0.1:5432/postgres failed",
      ),
    ).toBe("connect postgres://[redacted]@127.0.0.1:5432/postgres failed");
  });

  test("refuses missing PostgreSQL and failed child execution", () => {
    expect(hnsRegtestPostgresError(undefined)).toContain("PostgreSQL fixture is missing");
    expect(hnsRegtestPostgresError("  ")).toContain("PostgreSQL fixture is missing");
    expect(hnsRegtestPostgresError("postgres://fixture")).toBeNull();
    expect(hnsRegtestChildError("suite.ts", 1)).toBe("suite.ts failed with exit 1");
    expect(hnsRegtestChildError("suite.ts", 0)).toBeNull();
  });

  test("refuses missing, stale and malformed completion evidence", async () => {
    const target = hnsRegtestTargets[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(hnsRegtestReceiptError(target.file, "", target.sentinelContents)).toContain(
      "completion sentinel",
    );
    expect(hnsRegtestReceiptError(target.file, "stale\n", target.sentinelContents)).toContain(
      "completion sentinel",
    );
    expect(
      hnsRegtestReceiptError(target.file, target.sentinelContents, target.sentinelContents),
    ).toBeNull();
    expect(hnsRegtestTestCountError(target.file, 0, target.expectedTestCount)).toContain(
      "declares 0 tests",
    );
    expect(hnsRegtestTestCountError(target.file, 1, target.expectedTestCount)).toBeNull();

    // Keep the fixture source tied to the one-test receipt assumption.
    const source = await Bun.file(target.file).text();
    const count = source.match(/\btest(?:\.skip)?\s*\(/gu)?.length ?? 0;
    expect(count).toBe(target.expectedTestCount);
  });

  test("wires a standalone CI job with receipts and unconditional cleanup", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    const job = workflow.match(/\n {2}hns-regtest:\n([\s\S]*?)\n {2}postgres17-general:\n/u)?.[1];
    expect(job).toBeDefined();
    expect(job).toContain("run: bun run test:hns-regtest");
    expect(job).toContain("authority.ts --execute-local --with-chain");
    expect(job).toContain("set -euo pipefail");
    expect(job).toContain("/tmp/api-next-hns-authority-fixture.log");
    expect(job).toContain("- name: Upload HNS regtest receipts\n        if: always()");
    expect(job).toContain('docker rm -f -v "$HNS_REGTEST_CONTAINER_NAME"');
    expect(job).toContain("/tmp/api-next-hns-regtest-run-*/composed-path-suite-complete");
    expect(job).toContain("/tmp/api-next-hns-regtest-run-*/service-loop-suite-complete");
    expect(job).toContain("if: always() && env.HNS_REGTEST_CONTAINER_NAME != ''");
    const aggregate = workflow.match(/\n {2}postgres17:\n([\s\S]*?)$/u)?.[1] ?? "";
    expect(aggregate).not.toContain("hns-regtest");
  });
});
