import { describe, expect, test } from "bun:test";
import {
  type CapacityObservation,
  capacityWindowSeconds,
  evaluatePayoutCapacity,
} from "./capacity-freshness";
import {
  fitsPayoutCapacity,
  orderSongHeads,
  payoutWaitSeconds,
  type RewardPayoutCandidate,
} from "./payout-fairness";

// Assertions carried from the old reward-payout-fairness.test.ts; the SQL
// candidate listing and env resolution stay in the application layer, so the
// capacity cases feed the pure evaluator with the same observation values the
// old test injected through a stub client.

const base: RewardPayoutCandidate = {
  effectId: "rpe_a",
  amountCents: 100,
  createdAt: "2026-07-26T10:00:00.000Z",
  communityId: "community_a",
  postId: "post_a",
  lastSelectedAt: null,
};

describe("reward payout fairness", () => {
  test("keeps only each song head and rotates least-recently selected songs first", () => {
    expect(
      orderSongHeads([
        { ...base, effectId: "rpe_a2", createdAt: "2026-07-26T10:01:00.000Z" },
        { ...base, effectId: "rpe_a1" },
        {
          ...base,
          effectId: "rpe_b",
          communityId: "community_b",
          postId: "post_b",
          lastSelectedAt: "2026-07-26T09:00:00.000Z",
        },
        {
          ...base,
          effectId: "rpe_c",
          communityId: "community_c",
          postId: "post_c",
          lastSelectedAt: "2026-07-26T09:30:00.000Z",
        },
      ]).map((candidate) => candidate.effectId),
    ).toEqual(["rpe_a1", "rpe_b", "rpe_c"]);
  });

  test("treats legacy effects as independent heads", () => {
    expect(
      orderSongHeads([
        { ...base, effectId: "legacy_1", communityId: null, postId: null },
        { ...base, effectId: "legacy_2", communityId: null, postId: null },
      ]),
    ).toHaveLength(2);
  });

  test("equal-timestamp heads break ties on effect id deterministically", () => {
    expect(
      orderSongHeads([
        { ...base, effectId: "rpe_b" },
        { ...base, effectId: "rpe_a" },
      ]).map((candidate) => candidate.effectId),
    ).toEqual(["rpe_a"]);
  });

  test("uses exact cents-to-USDC atomic capacity", () => {
    expect(fitsPayoutCapacity(base, 1_000_000n)).toBe(true);
    expect(fitsPayoutCapacity(base, 999_999n)).toBe(false);
  });

  test("computes a non-negative wait", () => {
    expect(payoutWaitSeconds(base, Date.parse("2026-07-26T10:01:30.000Z"))).toBe(90);
    expect(payoutWaitSeconds(base, Date.parse("2026-07-26T09:00:00.000Z"))).toBe(0);
  });
});

describe("reward payout capacity freshness", () => {
  const expected = {
    expectedChainId: "84532",
    expectedVaultAddress: "0x2000000000000000000000000000000000000002",
    maxAgeSeconds: 300,
  };

  function observation(overrides: Partial<CapacityObservation> = {}): CapacityObservation {
    return {
      chainId: "84532",
      vaultAddress: "0x2000000000000000000000000000000000000002",
      epochDurationSeconds: 3600n,
      currentEpoch: 7n,
      payoutEpochCapAtomic: 5_000_000n,
      payoutSpentAtomic: 1_250_000n,
      observedAt: new Date(7 * 3_600_000).toISOString(),
      ...overrides,
    };
  }

  test("returns remaining capacity from a fresh observation", () => {
    expect(
      evaluatePayoutCapacity({
        ...expected,
        observation: observation(),
        nowMs: 7 * 3_600_000 + 299_000,
      }),
    ).toEqual({
      currentEpoch: 7n,
      remainingAtomic: 3_750_000n,
      observedAt: new Date(7 * 3_600_000).toISOString(),
    });
  });

  test("fails closed on missing, stale, future, and invalid observations", () => {
    expect(() => evaluatePayoutCapacity({ ...expected, observation: null, nowMs: 0 })).toThrow(
      "missing",
    );
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({ payoutEpochCapAtomic: 5n, payoutSpentAtomic: 1n }),
        nowMs: 7 * 3_600_000 + 301_000,
      }),
    ).toThrow("stale");
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({
          payoutEpochCapAtomic: 5n,
          payoutSpentAtomic: 1n,
          observedAt: new Date(7 * 3_600_000 + 60_000).toISOString(),
        }),
        nowMs: 7 * 3_600_000,
      }),
    ).toThrow("stale");
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({ payoutEpochCapAtomic: 5n, payoutSpentAtomic: 6n }),
        nowMs: 7 * 3_600_000 + 1_000,
      }),
    ).toThrow("invalid");
  });

  test("fails closed on chain or vault mismatch and on wrong-epoch observations", () => {
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({ chainId: "1" }),
        nowMs: 7 * 3_600_000,
      }),
    ).toThrow("stale configuration");
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({
          vaultAddress: "0x3000000000000000000000000000000000000003",
        }),
        nowMs: 7 * 3_600_000,
      }),
    ).toThrow("stale configuration");
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({ currentEpoch: 6n }),
        nowMs: 7 * 3_600_000,
      }),
    ).toThrow("different epoch");
    expect(() =>
      evaluatePayoutCapacity({
        ...expected,
        observation: observation({ epochDurationSeconds: 0n }),
        nowMs: 7 * 3_600_000,
      }),
    ).toThrow("different epoch");
  });

  test("rejects an invalid freshness configuration instead of silently widening it", () => {
    expect(() => capacityWindowSeconds("invalid", 300)).toThrow("configuration is invalid");
    expect(() => capacityWindowSeconds("30", 300)).toThrow("configuration is invalid");
    expect(capacityWindowSeconds("", 300)).toBe(300);
    expect(capacityWindowSeconds("600", 300)).toBe(600);
    expect(capacityWindowSeconds(undefined, 86_400)).toBe(86_400);
  });
});
