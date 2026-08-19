import { describe, expect, test } from "bun:test";
import {
  COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
  nextReconciliationAttemptDelayMs,
  reconciliationEscalated,
} from "./reconciliation-backoff";

const OPERATION_A = "money:v1:community_purchase:community_1:quote_a:purchase_a:3";
const OPERATION_B = "money:v1:community_purchase:community_1:quote_b:purchase_b:3";

describe("reconciliation backoff policy", () => {
  test("grows exponentially from the class base and respects the cap", () => {
    const policy = {
      ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
      jitterPercent: 0,
      baseDelayMs: {
        ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF.baseDelayMs,
        chain_timeout: 1_000,
      },
    };
    expect(
      nextReconciliationAttemptDelayMs({
        failureClass: "chain_timeout",
        consecutiveFailures: 1,
        operationId: OPERATION_A,
        policy,
      }),
    ).toBe(1_000);
    expect(
      nextReconciliationAttemptDelayMs({
        failureClass: "chain_timeout",
        consecutiveFailures: 4,
        operationId: OPERATION_A,
        policy,
      }),
    ).toBe(8_000);
    expect(
      nextReconciliationAttemptDelayMs({
        failureClass: "chain_timeout",
        consecutiveFailures: 40,
        operationId: OPERATION_A,
        policy,
      }),
    ).toBe(policy.maxDelayMs);
  });

  test("jitter is deterministic per operation and bounded by the policy percent", () => {
    const policy = COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF;
    const first = nextReconciliationAttemptDelayMs({
      failureClass: "chain_unavailable",
      consecutiveFailures: 1,
      operationId: OPERATION_A,
    });
    const second = nextReconciliationAttemptDelayMs({
      failureClass: "chain_unavailable",
      consecutiveFailures: 1,
      operationId: OPERATION_A,
    });
    const other = nextReconciliationAttemptDelayMs({
      failureClass: "chain_unavailable",
      consecutiveFailures: 1,
      operationId: OPERATION_B,
    });
    expect(first).toBe(second);
    const base = policy.baseDelayMs.chain_unavailable;
    for (const delay of [first, other]) {
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
      expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.1));
    }
  });

  test("the cap clamps the final jittered delay, not just the pre-jitter value", () => {
    const policy = {
      ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
      maxDelayMs: 60_000,
      baseDelayMs: {
        ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF.baseDelayMs,
        chain_timeout: 60_000,
      },
    };
    for (const operationId of [OPERATION_A, OPERATION_B, "money:v1:community_purchase:c:q:p:9"]) {
      expect(
        nextReconciliationAttemptDelayMs({
          failureClass: "chain_timeout",
          consecutiveFailures: 1,
          operationId,
          policy,
        }),
      ).toBeLessThanOrEqual(policy.maxDelayMs);
    }
  });

  test("escalates only at the reviewed consecutive-failure threshold", () => {
    const threshold = COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF.escalationThreshold;
    expect(reconciliationEscalated(threshold - 1)).toBe(false);
    expect(reconciliationEscalated(threshold)).toBe(true);
    expect(reconciliationEscalated(threshold + 5)).toBe(true);
  });

  test("rejects invalid failure counts and malformed policies", () => {
    expect(() =>
      nextReconciliationAttemptDelayMs({
        failureClass: "chain_timeout",
        consecutiveFailures: 0,
        operationId: OPERATION_A,
      }),
    ).toThrow("reconciliation_consecutive_failures_invalid");
    expect(() =>
      nextReconciliationAttemptDelayMs({
        failureClass: "chain_timeout",
        consecutiveFailures: 1,
        operationId: OPERATION_A,
        policy: { ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF, jitterPercent: 101 },
      }),
    ).toThrow("reconciliation_backoff_jitter_invalid");
  });
});
