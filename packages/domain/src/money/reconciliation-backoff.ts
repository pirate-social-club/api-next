// Reviewed retry policy for money-flow reconciliation (spec 004 §6: retry
// scheduling changes liveness metadata, never economic identity). Pure and
// deterministic: the database clock supplies "now" at the call site and the
// operation identity supplies deterministic jitter. No wall clock, no
// randomness, no I/O.

/** Bounded failure vocabulary for reconciliation attempt metadata. */
export type ReconciliationFailureClass =
  | "lease_contention"
  | "chain_unavailable"
  | "chain_timeout"
  | "transaction_not_found"
  | "invalid_evidence"
  | "reorg"
  | "identity_conflict";

export const RECONCILIATION_FAILURE_CLASSES: readonly ReconciliationFailureClass[] = [
  "lease_contention",
  "chain_unavailable",
  "chain_timeout",
  "transaction_not_found",
  "invalid_evidence",
  "reorg",
  "identity_conflict",
];

export type ReconciliationBackoffPolicy = Readonly<{
  readonly baseDelayMs: Readonly<Record<ReconciliationFailureClass, number>>;
  readonly multiplier: number;
  readonly maxDelayMs: number;
  readonly jitterPercent: number;
  /** Consecutive failures at or beyond this count stop automatic selection. */
  readonly escalationThreshold: number;
}>;

export const COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF: ReconciliationBackoffPolicy = {
  baseDelayMs: {
    lease_contention: 5_000,
    chain_timeout: 15_000,
    chain_unavailable: 30_000,
    transaction_not_found: 30_000,
    invalid_evidence: 60_000,
    reorg: 60_000,
    identity_conflict: 60_000,
  },
  multiplier: 2,
  maxDelayMs: 15 * 60_000,
  jitterPercent: 10,
  escalationThreshold: 12,
};

function assertPolicy(policy: ReconciliationBackoffPolicy): void {
  for (const failureClass of RECONCILIATION_FAILURE_CLASSES) {
    const base = policy.baseDelayMs[failureClass];
    if (!Number.isSafeInteger(base) || base < 1) {
      throw new Error(`reconciliation_backoff_base_invalid:${failureClass}`);
    }
  }
  if (!Number.isSafeInteger(policy.multiplier) || policy.multiplier < 1) {
    throw new Error("reconciliation_backoff_multiplier_invalid");
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < 1) {
    throw new Error("reconciliation_backoff_cap_invalid");
  }
  if (
    !Number.isSafeInteger(policy.jitterPercent) ||
    policy.jitterPercent < 0 ||
    policy.jitterPercent > 100
  ) {
    throw new Error("reconciliation_backoff_jitter_invalid");
  }
  if (!Number.isSafeInteger(policy.escalationThreshold) || policy.escalationThreshold < 1) {
    throw new Error("reconciliation_backoff_escalation_invalid");
  }
}

/** Deterministic jitter in [-100, +100] basis points, stable per operation. */
function jitterBasisPoints(operationId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < operationId.length; index += 1) {
    hash ^= operationId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 201) - 100;
}

/**
 * Delay before the next eligible attempt after `consecutiveFailures`
 * (1-based, i.e. the count after the failure being recorded). Exponential
 * growth from the class base, capped, with deterministic per-operation jitter.
 */
export function nextReconciliationAttemptDelayMs(input: {
  readonly failureClass: ReconciliationFailureClass;
  readonly consecutiveFailures: number;
  readonly operationId: string;
  readonly policy?: ReconciliationBackoffPolicy;
}): number {
  const policy = input.policy ?? COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF;
  assertPolicy(policy);
  if (!Number.isSafeInteger(input.consecutiveFailures) || input.consecutiveFailures < 1) {
    throw new Error("reconciliation_consecutive_failures_invalid");
  }
  const base = policy.baseDelayMs[input.failureClass];
  const exponent = Math.min(input.consecutiveFailures - 1, 10);
  const scaled = base * policy.multiplier ** exponent;
  const capped = Math.min(scaled, policy.maxDelayMs);
  const jitter =
    (capped * policy.jitterPercent * jitterBasisPoints(input.operationId)) / (100 * 100);
  // The cap is authoritative over the final jittered delay, not just the
  // pre-jitter value: positive jitter must never push past maxDelayMs.
  return Math.min(Math.max(1, Math.round(capped + jitter)), policy.maxDelayMs);
}

export function reconciliationEscalated(
  consecutiveFailures: number,
  policy: ReconciliationBackoffPolicy = COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
): boolean {
  assertPolicy(policy);
  return (
    Number.isSafeInteger(consecutiveFailures) && consecutiveFailures >= policy.escalationThreshold
  );
}
