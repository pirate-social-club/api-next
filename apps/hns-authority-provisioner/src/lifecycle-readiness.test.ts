import { describe, expect, test } from "bun:test";
import type { HnsLifecycleClaimV1 } from "./lifecycle-executor.ts";
import {
  HnsLifecycleReadinessContextError,
  type HnsLifecycleReadinessContextV1,
  runHnsRootImportReadinessOnce,
} from "./lifecycle-readiness.ts";
import { HnsRootReadinessObservationError } from "./observe-root.ts";

/**
 * The readiness performer's outcome handling. The probes are stubbed so the
 * performer itself is exercised — request construction, the atomic record
 * call and the translation of refusals — without a live DNS authority or
 * gateway; the real probes run in the joint proof.
 */

const context: HnsLifecycleReadinessContextV1 = {
  lifecycle_revision: 1,
  phase: "checking_authority",
  namespace_session_id: "namespace-1",
  root_label: "exampleroot",
  challenge_txt_value: "pirate-verification=exampleroot",
  ownership_result_sha256: "a".repeat(64),
  publish_plan_sha256: "b".repeat(64),
  publish_plan_bytes: new Uint8Array([1]),
  provision_result_sha256: "c".repeat(64),
  provision_result_bytes: new Uint8Array([2]),
  effective_plan_encoded_resource_sha256: "e".repeat(64),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};

const job: HnsLifecycleClaimV1 = {
  lifecycle_job_id: "42",
  root_import_session_id: "readiness-session",
  job_kind: "observe_readiness",
  lease_fence: 3,
  generation: 1,
};

const artifact = {
  result_bytes: new Uint8Array([9]),
  result_sha256: "d".repeat(64),
} as never;

function ports(overrides: Record<string, unknown> = {}) {
  const recorded: Record<string, unknown>[] = [];
  const finalized: Record<string, unknown>[] = [];
  return {
    recorded,
    finalized,
    ports: {
      context: async () => context,
      observe: {} as never,
      config: { environment: "test", valid_for_seconds: 3_600 },
      observe_readiness: async () => artifact,
      record: async (input: Record<string, unknown>) => {
        recorded.push(input);
        return { outcome: "ready", revision: 2 };
      },
      finalize: async (
        _job: unknown,
        _executor: string,
        outcome: string,
        failureCode: string | null,
      ) => {
        finalized.push({ outcome, failureCode });
        return { outcome };
      },
      now_epoch_ms: () => Date.now(),
      ...overrides,
    } as never,
  };
}

describe("the readiness performer", () => {
  test("pending ownership finalizes a retry before reading the incomplete context", async () => {
    const {
      ports: configured,
      finalized,
      recorded,
    } = ports({
      prepare_ownership: async () => "pending",
      context: async () => {
        throw new Error("incomplete context must not be read");
      },
    });
    expect(await runHnsRootImportReadinessOnce(job, "executor-a", configured)).toEqual({
      outcome: "retry",
      reason: "readiness_ownership_pending",
    });
    expect(finalized).toEqual([{ outcome: "retry", failureCode: "readiness_ownership_pending" }]);
    expect(recorded).toHaveLength(0);
  });

  for (const prepared of ["revision_conflict", "stale_proof"] as const) {
    test(`transient ownership ${prepared} records a retry instead of killing readiness`, async () => {
      const {
        ports: configured,
        finalized,
        recorded,
      } = ports({
        prepare_ownership: async () => prepared,
        context: async () => {
          throw new Error("stale preparation must not proceed to context");
        },
      });
      expect(await runHnsRootImportReadinessOnce(job, "executor-a", configured)).toEqual({
        outcome: "retry",
        reason: `readiness_ownership_${prepared}`,
      });
      expect(finalized).toEqual([
        { outcome: "retry", failureCode: `readiness_ownership_${prepared}` },
      ]);
      expect(recorded).toHaveLength(0);
    });
  }

  test("a lost lease cannot claim that its context failure was recorded", async () => {
    const { ports: configured } = ports({
      context: async () => {
        throw new HnsLifecycleReadinessContextError();
      },
      finalize: async () => ({ outcome: "conflict" }),
    });
    await expect(runHnsRootImportReadinessOnce(job, "executor-a", configured)).rejects.toThrow(
      "HNS readiness lease finalization refused",
    );
  });

  test("invalid context finalizes the claimed lease with a visible failure", async () => {
    const {
      ports: configured,
      finalized,
      recorded,
    } = ports({
      context: async () => {
        throw new HnsLifecycleReadinessContextError();
      },
      observe_readiness: async () => {
        throw new Error("probe must not run");
      },
    });
    expect(await runHnsRootImportReadinessOnce(job, "executor-a", configured)).toEqual({
      outcome: "failed",
      reason: "readiness_context_invalid",
    });
    expect(finalized).toEqual([{ outcome: "failed", failureCode: "readiness_context_invalid" }]);
    expect(recorded).toHaveLength(0);
  });

  test("a context storage outage records a retry without disclosing the error", async () => {
    const {
      ports: configured,
      finalized,
      recorded,
    } = ports({
      context: async () => {
        throw new Error("private connection details");
      },
    });
    expect(await runHnsRootImportReadinessOnce(job, "executor-a", configured)).toEqual({
      outcome: "retry",
      reason: "readiness_context_unavailable",
    });
    expect(finalized).toEqual([{ outcome: "retry", failureCode: "readiness_context_unavailable" }]);
    expect(recorded).toHaveLength(0);
  });

  test("a refused finalization is not reported as successfully recorded", async () => {
    const { ports: configured } = ports({
      context: async () => {
        throw new HnsLifecycleReadinessContextError();
      },
      finalize: async () => {
        throw new Error("finalization unavailable");
      },
    });
    await expect(runHnsRootImportReadinessOnce(job, "executor-a", configured)).rejects.toThrow(
      "finalization unavailable",
    );
  });

  test("accepts fresh readiness through the atomic writer", async () => {
    const { ports: configured, recorded } = ports();
    const result = await runHnsRootImportReadinessOnce(job, "executor-a", configured);
    expect(result).toEqual({ outcome: "completed", reason: "readiness_ready" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      root_import_session_id: "readiness-session",
      lifecycle_job_id: "42",
      expected_revision: 1,
      result_sha256: "d".repeat(64),
    });
  });

  test("accepts a ready refresh at the operation's current revision", async () => {
    const { ports: configured, recorded } = ports();
    const refreshed = await runHnsRootImportReadinessOnce(job, "executor-a", {
      ...(configured as object),
      context: async () => ({ ...context, lifecycle_revision: 2, phase: "ready" }),
    } as never);
    expect(refreshed).toEqual({ outcome: "completed", reason: "readiness_ready" });
    expect(recorded[0]).toMatchObject({ expected_revision: 2 });
  });

  test("an owner update still pending retries without inventing success", async () => {
    const { ports: configured, finalized } = ports({
      observe_readiness: async () => {
        throw new HnsRootReadinessObservationError("owner_update_pending");
      },
    });
    const result = await runHnsRootImportReadinessOnce(job, "executor-a", configured);
    expect(result).toEqual({ outcome: "retry", reason: "readiness_owner_update_pending" });
    expect(finalized).toEqual([
      { outcome: "retry", failureCode: "readiness_owner_update_pending" },
    ]);
  });

  test("a pending policy outcome retries and a phase conflict is terminal", async () => {
    const pending = ports({ record: async () => ({ outcome: "readiness_pending", revision: 2 }) });
    expect(await runHnsRootImportReadinessOnce(job, "executor-a", pending.ports)).toEqual({
      outcome: "retry",
      reason: "readiness_readiness_pending",
    });
    const conflicted = ports({ record: async () => ({ outcome: "phase_conflict", revision: 1 }) });
    expect(await runHnsRootImportReadinessOnce(job, "executor-a", conflicted.ports)).toEqual({
      outcome: "failed",
      reason: "readiness_phase_conflict",
    });
  });

  test("an absent operation fails without a probe", async () => {
    const { ports: configured } = ports({ context: async () => null });
    const result = await runHnsRootImportReadinessOnce(job, "executor-a", configured);
    expect(result).toEqual({ outcome: "failed", reason: "lifecycle_absent" });
  });
});
