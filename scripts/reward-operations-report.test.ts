import { expect, test } from "bun:test";
import {
  createRewardOperationsReport,
  printableRewardReadiness,
  RewardOperationsRefusal,
  sanitizeRewardOperationsFailure,
} from "./reward-operations-report.ts";

test("reports preserve original stage and cleanup failures without arbitrary provider or PG content", () => {
  const diagnostics = createRewardOperationsReport("fixture");
  diagnostics.enter("mutation");
  diagnostics.fail(
    Object.assign(new Error("password=private https://private SQL SELECT"), {
      code: "PR002",
      body: "private",
      status: 503,
    }),
  );
  diagnostics.enter("guard-rollback");
  diagnostics.cleanup("database-end", Object.assign(new Error("private"), { code: "ECONNRESET" }));
  const report = JSON.stringify(diagnostics.report);
  expect(diagnostics.report.stage).toBe("mutation");
  expect(diagnostics.report.failure?.sqlstate).toBe("PR002");
  expect(diagnostics.report.cleanupFailures[0]?.failure.transport).toBe("ECONNRESET");
  expect(report).not.toContain("private");
  expect(sanitizeRewardOperationsFailure(new RewardOperationsRefusal("revision")).reason).toBe(
    "revision",
  );
  expect(printableRewardReadiness(["leg_liabilities", "private", "leg_liabilities"])).toEqual([
    "leg_liabilities",
  ]);
});
