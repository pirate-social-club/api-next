// Reward payout fairness (dedup + rotation) and exact cents-to-atomic
// capacity, ported pure from the old rewards/reward-payout-fairness.ts. The
// candidate-listing SQL and scheduler-state writes stay in the application
// layer; the head selection, rotation order, and capacity arithmetic that the
// old table-driven tests pin down live here.

export const CENTS_TO_USDC_ATOMIC = 10_000n;

export type RewardPayoutCandidate = {
  effectId: string;
  amountCents: number;
  createdAt: string;
  communityId: string | null;
  postId: string | null;
  lastSelectedAt: string | null;
};

/**
 * One head per song participates in a round. A cashout spanning songs is
 * attributed to its oldest campaign-backed allocation; this preserves the
 * same FIFO order used when reserving reward-event liabilities. Songs are
 * then rotated least-recently-selected first (never-selected songs lead).
 */
export function orderSongHeads(candidates: RewardPayoutCandidate[]): RewardPayoutCandidate[] {
  const heads = new Map<string, RewardPayoutCandidate>();
  for (const candidate of candidates) {
    const key =
      candidate.communityId && candidate.postId
        ? `${candidate.communityId}\u0000${candidate.postId}`
        : `legacy\u0000${candidate.effectId}`;
    const existing = heads.get(key);
    if (
      !existing ||
      Date.parse(candidate.createdAt) < Date.parse(existing.createdAt) ||
      (candidate.createdAt === existing.createdAt &&
        candidate.effectId.localeCompare(existing.effectId) < 0)
    ) {
      heads.set(key, candidate);
    }
  }
  return [...heads.values()].sort((left, right) => {
    const leftSelected = left.lastSelectedAt
      ? Date.parse(left.lastSelectedAt)
      : Number.NEGATIVE_INFINITY;
    const rightSelected = right.lastSelectedAt
      ? Date.parse(right.lastSelectedAt)
      : Number.NEGATIVE_INFINITY;
    return (
      leftSelected - rightSelected ||
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.effectId.localeCompare(right.effectId)
    );
  });
}

/** Exact cents-to-USDC-atomic conversion; a candidate never partially fits. */
export function fitsPayoutCapacity(
  candidate: RewardPayoutCandidate,
  remainingAtomic: bigint,
): boolean {
  return BigInt(candidate.amountCents) * CENTS_TO_USDC_ATOMIC <= remainingAtomic;
}

/** Whole seconds a candidate has waited; never negative. */
export function payoutWaitSeconds(candidate: RewardPayoutCandidate, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(candidate.createdAt)) / 1000));
}
