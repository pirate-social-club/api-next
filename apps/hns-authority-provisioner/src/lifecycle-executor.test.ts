import { describe, expect, test } from "bun:test";
import {
  type HnsLifecycleClaimV1,
  runHnsRootImportLifecycleJobOnce,
} from "./lifecycle-executor.ts";

/**
 * The job-kind dispatch dispositions. A declared job without a performer is
 * failed with a bounded reason; it is never read as observation work and never
 * marked successfully performed.
 */

function claim(kind: HnsLifecycleClaimV1["job_kind"]): HnsLifecycleClaimV1 {
  return {
    lifecycle_job_id: "7",
    root_import_session_id: "session-1",
    job_kind: kind,
    lease_fence: 1,
    generation: 1,
  };
}

describe("HNS lifecycle job dispatch", () => {
  test("a reconcile job without a performer fails with a bounded disposition", async () => {
    const finalized: readonly string[][] = [];
    const result = await runHnsRootImportLifecycleJobOnce("executor-1", 60, {
      claim: async () => claim("reconcile_provider"),
      identity: async () => {
        throw new Error("reconciliation must not read an operation identity");
      },
      observe: async () => {
        throw new Error("reconciliation must not observe the chain");
      },
      withTransaction: async () => {
        throw new Error("reconciliation must not transact without a performer");
      },
      now_epoch_ms: () => Date.now(),
      finalize: async (_job, _executorId, outcome, failureCode) => {
        (finalized as string[][]).push([outcome, failureCode ?? ""]);
        return { outcome };
      },
    });
    expect(result).toEqual({
      claimed: true,
      outcome: "failed",
      reason: "reconcile_performer_absent",
    });
    expect(finalized).toEqual([["failed", "reconcile_performer_absent"]]);
  });

  test("a readiness job without a performer fails with a bounded disposition", async () => {
    const finalized: readonly string[][] = [];
    const result = await runHnsRootImportLifecycleJobOnce("executor-1", 60, {
      claim: async () => claim("observe_readiness"),
      identity: async () => {
        throw new Error("readiness dispatch must not read an operation identity");
      },
      observe: async () => {
        throw new Error("readiness dispatch must not observe the chain");
      },
      withTransaction: async () => {
        throw new Error("readiness must not transact without a performer");
      },
      now_epoch_ms: () => Date.now(),
      finalize: async (_job, _executorId, outcome, failureCode) => {
        (finalized as string[][]).push([outcome, failureCode ?? ""]);
        return { outcome };
      },
    });
    expect(result).toEqual({
      claimed: true,
      outcome: "failed",
      reason: "readiness_performer_absent",
    });
    expect(finalized).toEqual([["failed", "readiness_performer_absent"]]);
  });

  test("a reconcile performer is dispatched and its outcome returned", async () => {
    const result = await runHnsRootImportLifecycleJobOnce("executor-1", 60, {
      claim: async () => claim("reconcile_provider"),
      identity: async () => {
        throw new Error("reconciliation must not read an operation identity");
      },
      observe: async () => {
        throw new Error("reconciliation must not observe the chain");
      },
      withTransaction: async () => {
        throw new Error("the performer owns its transaction");
      },
      finalize: async () => {
        throw new Error("the performer owns finalization");
      },
      now_epoch_ms: () => Date.now(),
      reconcile: async () => ({
        outcome: "completed",
        reason: "reconcile_current_to_observe_current",
      }),
    });
    expect(result).toEqual({
      claimed: true,
      outcome: "completed",
      reason: "reconcile_current_to_observe_current",
    });
  });
});
