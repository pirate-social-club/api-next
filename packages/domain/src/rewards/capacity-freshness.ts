// Capacity-freshness fail-closed rules, ported pure from the old
// rewards/reward-payout-fairness.ts `readFreshPayoutCapacity`. The SQL read
// and env resolution stay in the application layer; every fail-closed
// decision — missing, mismatched, stale, future-dated, arithmetically
// invalid, or wrong-epoch observations, and invalid freshness configuration
// — is evaluated here over plain values. Errors carry the old message
// vocabulary ("missing" / "stale" / "invalid" / "configuration is invalid" /
// "stale configuration" / "different epoch") so the old suite's assertions
// port unweakened.

export type RewardPayoutCapacity = {
  remainingAtomic: bigint;
  observedAt: string;
  currentEpoch: bigint;
};

export type CapacityObservation = {
  chainId: string;
  vaultAddress: string;
  epochDurationSeconds: bigint;
  currentEpoch: bigint;
  payoutEpochCapAtomic: bigint;
  payoutSpentAtomic: bigint;
  observedAt: string;
};

export const DEFAULT_CAPACITY_MAX_AGE_SECONDS = 300;
export const DEFAULT_MAX_WAIT_SECONDS = 86_400;

/** Future-dated tolerance for clock skew between observer and scheduler. */
const FUTURE_SKEW_ALLOWANCE_MS = 30_000;

/**
 * Freshness/wait windows must be explicit positive integers of at least 60
 * seconds; anything else is a configuration error, never a silent widening.
 */
export function capacityWindowSeconds(raw: string | undefined, fallback: number): number {
  const normalized = String(raw ?? "").trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 60) {
    throw new Error("Reward payout scheduler freshness or wait configuration is invalid");
  }
  return parsed;
}

/**
 * Fail-closed evaluation of one capacity observation. Throws unless the
 * observation targets the expected chain and vault, is fresh, arithmetically
 * consistent, and belongs to the current epoch at `nowMs`.
 */
export function evaluatePayoutCapacity(input: {
  observation: CapacityObservation | null;
  expectedChainId: string;
  expectedVaultAddress: string;
  maxAgeSeconds: number;
  nowMs: number;
}): RewardPayoutCapacity {
  const observation = input.observation;
  if (!observation) {
    throw new Error("Reward vault payout capacity observation is missing");
  }
  if (
    observation.chainId !== input.expectedChainId.trim() ||
    observation.vaultAddress.toLowerCase() !== input.expectedVaultAddress.trim().toLowerCase()
  ) {
    throw new Error("Reward vault payout capacity observation targets stale configuration");
  }
  const observedMs = Date.parse(observation.observedAt);
  const maxAgeMs = input.maxAgeSeconds * 1000;
  if (
    !Number.isFinite(observedMs) ||
    observedMs > input.nowMs + FUTURE_SKEW_ALLOWANCE_MS ||
    input.nowMs - observedMs > maxAgeMs
  ) {
    throw new Error("Reward vault payout capacity observation is stale");
  }
  const cap = observation.payoutEpochCapAtomic;
  const spent = observation.payoutSpentAtomic;
  if (cap < 0n || spent < 0n || spent > cap) {
    throw new Error("Reward vault payout capacity observation is invalid");
  }
  if (
    observation.epochDurationSeconds <= 0n ||
    observation.currentEpoch !==
      BigInt(Math.floor(input.nowMs / 1000)) / observation.epochDurationSeconds
  ) {
    throw new Error("Reward vault payout capacity observation is from a different epoch");
  }
  return {
    remainingAtomic: cap - spent,
    observedAt: observation.observedAt,
    currentEpoch: observation.currentEpoch,
  };
}
