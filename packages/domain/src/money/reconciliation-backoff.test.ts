import { describe, expect, test } from "bun:test";
import {
  COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
  nextReconciliationAttemptDelayMs,
  reconciliationEscalated,
} from "./reconciliation-backoff";

const OPERATION_A = "money:v1:community_purchase:community_1:quote_a:purchase_a:3";

describe("reconciliation backoff policy", () => {
  test("grows exponentially from the failure-class base and respects the cap", () => {
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

  test("clamps the final jittered delay to maxDelayMs", () => {
    const policy = {
      ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
      maxDelayMs: 60_000,
      baseDelayMs: {
        ...COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF.baseDelayMs,
        chain_timeout: 60_000,
      },
    };
    expect(
      nextReconciliationAttemptDelayMs({
        failureClass: "chain_timeout",
        consecutiveFailures: 1,
        operationId: OPERATION_A,
        policy,
      }),
    ).toBeLessThanOrEqual(policy.maxDelayMs);
  });

  test("escalates only at the configured consecutive-failure threshold", () => {
    const threshold = COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF.escalationThreshold;
    expect(reconciliationEscalated(threshold - 1)).toBe(false);
    expect(reconciliationEscalated(threshold)).toBe(true);
  });
});
