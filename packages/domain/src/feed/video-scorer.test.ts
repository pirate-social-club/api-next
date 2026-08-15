import { describe, expect, test } from "bun:test";

import {
  disapprovalRate,
  explicitEngagement,
  finiteCount,
  freshnessBonus,
  posteriorRate,
  scoreVideoCandidate,
  scoreVideoCandidates,
  uncertaintyBonus,
  VIDEO_SCORER_VERSION,
  type VideoCandidateInput,
  type VideoCandidateStats,
  videoDurationBucket,
  videoScorerFeatures,
} from "./video-scorer";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const HOUR = 3_600_000;

function candidate(overrides: Partial<VideoCandidateInput> = {}): VideoCandidateInput {
  return {
    postId: "pst_a",
    communityId: "cmt_a",
    authorUserId: "usr_a",
    createdAtMs: NOW - 24 * HOUR,
    durationSeconds: 20,
    upvotes: 0,
    downvotes: 0,
    comments: 0,
    likes: 0,
    stats: null,
    ...overrides,
  };
}

function stats(overrides: Partial<VideoCandidateStats> = {}): VideoCandidateStats {
  return {
    validImpressions: 0,
    validPlays: 0,
    completions: 0,
    longWatches: 0,
    playsWithReplay: 0,
    fastSkips: 0,
    ...overrides,
  };
}

describe("videoDurationBucket", () => {
  test("buckets by duration and treats unknown duration as short-form", () => {
    expect(videoDurationBucket(5)).toBe("lt_10s");
    expect(videoDurationBucket(20)).toBe("10_30s");
    expect(videoDurationBucket(45)).toBe("30_60s");
    expect(videoDurationBucket(120)).toBe("gt_60s");
    expect(videoDurationBucket(null)).toBe("10_30s");
    expect(videoDurationBucket(Number.NaN)).toBe("10_30s");
  });
});

describe("posteriorRate", () => {
  test("returns the prior when there is no evidence", () => {
    expect(posteriorRate(0, 0, 0.3)).toBeCloseTo(0.3, 10);
  });

  test("shrinks toward the prior in proportion to sample size", () => {
    const small = posteriorRate(1, 1, 0.3);
    const large = posteriorRate(100, 100, 0.3);
    expect(small).toBeLessThan(large);
    expect(large).toBeGreaterThan(0.8);
  });

  test("clamps successes to trials and stays within [0,1]", () => {
    expect(posteriorRate(50, 10, 0.3)).toBeLessThanOrEqual(1);
    expect(posteriorRate(-5, 10, 0.3)).toBeGreaterThanOrEqual(0);
    expect(posteriorRate(5, -10, 0.3)).toBeGreaterThanOrEqual(0);
  });
});

describe("explicitEngagement", () => {
  test("stays inside [0,1) when engagement far outruns impressions", () => {
    // The defect this replaces: a posterior rate over an impression
    // denominator returned ~3 for this input and broke the feature contract.
    const value = explicitEngagement({ upvotes: 30, comments: 0, likes: 0, validImpressions: 5 });
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });

  test("is monotonic in engagement, so ordering survives saturation", () => {
    const low = explicitEngagement({ upvotes: 5, comments: 0, likes: 0, validImpressions: 100 });
    const mid = explicitEngagement({ upvotes: 50, comments: 0, likes: 0, validImpressions: 100 });
    const high = explicitEngagement({ upvotes: 500, comments: 0, likes: 0, validImpressions: 100 });
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeLessThan(1);
  });

  test("weights a comment twice a vote", () => {
    expect(
      explicitEngagement({ upvotes: 2, comments: 0, likes: 0, validImpressions: 0 }),
    ).toBeCloseTo(
      explicitEngagement({ upvotes: 0, comments: 1, likes: 0, validImpressions: 0 }),
      10,
    );
  });

  test("keeps projected likes as an explicit positive signal", () => {
    expect(
      explicitEngagement({ upvotes: 0, comments: 0, likes: 2, validImpressions: 0 }),
    ).toBeCloseTo(
      explicitEngagement({ upvotes: 2, comments: 0, likes: 0, validImpressions: 0 }),
      10,
    );
  });

  test("is zero with no engagement", () => {
    expect(explicitEngagement({ upvotes: 0, comments: 0, likes: 0, validImpressions: 10 })).toBe(0);
  });
});

describe("disapprovalRate", () => {
  test("rises with downvote share and stays inside [0,1]", () => {
    const clean = disapprovalRate({ upvotes: 30, downvotes: 0 });
    const mixed = disapprovalRate({ upvotes: 30, downvotes: 30 });
    const hated = disapprovalRate({ upvotes: 30, downvotes: 300 });
    expect(clean).toBeLessThan(mixed);
    expect(mixed).toBeLessThan(hated);
    expect(hated).toBeLessThan(1);
    expect(clean).toBeGreaterThan(0);
  });

  test("distinguishes reception that a net vote score collapses", () => {
    // `upvotes - downvotes` scores 130-up/100-down the same as 30-up/0-down.
    // A share keeps its denominator, so it does not.
    expect(disapprovalRate({ upvotes: 130, downvotes: 100 })).toBeGreaterThan(
      disapprovalRate({ upvotes: 30, downvotes: 0 }),
    );
  });

  test("returns the prior with no votes cast, so it cannot rank unvoted posts", () => {
    expect(disapprovalRate({ upvotes: 0, downvotes: 0 })).toBeCloseTo(0.15, 10);
  });
});

describe("downvote semantics", () => {
  const at = (overrides: Partial<VideoCandidateInput>) =>
    scoreVideoCandidate(candidate({ createdAtMs: NOW - 12 * HOUR, ...overrides }), NOW).score;

  test("more downvotes at equal upvotes scores strictly lower", () => {
    // The regression this guards: the outgoing SQL score carried
    // (upvote_count - downvote_count), so dropping downvotes from the scorer
    // would have made these two posts identical.
    expect(at({ upvotes: 30, downvotes: 100 })).toBeLessThan(at({ upvotes: 30, downvotes: 0 }));
  });

  test("a net-negative post ranks below a comparable post with no votes", () => {
    expect(at({ upvotes: 5, downvotes: 30 })).toBeLessThan(at({ upvotes: 0, downvotes: 0 }));
  });

  test("comment volume cannot erase overwhelming negative feedback", () => {
    // `explicit` saturates, so comments alone must not buy a way past the
    // disapproval term's reach.
    expect(at({ upvotes: 0, downvotes: 100, comments: 1_000 })).toBeLessThan(
      at({ upvotes: 0, downvotes: 0, comments: 0 }),
    );
  });

  test("downvotes do not invert a genuinely well-received post", () => {
    expect(at({ upvotes: 500, downvotes: 20 })).toBeGreaterThan(at({ upvotes: 0, downvotes: 0 }));
  });
});

describe("finite input enforcement", () => {
  test("finiteCount rejects NaN, infinities, negatives, and nullish input", () => {
    expect(finiteCount(Number.NaN)).toBe(0);
    expect(finiteCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(finiteCount(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(finiteCount(-7)).toBe(0);
    expect(finiteCount(null)).toBe(0);
    expect(finiteCount(undefined)).toBe(0);
    expect(finiteCount(3.5)).toBe(3.5);
  });

  test("a fully poisoned candidate still yields a finite in-range feature vector", () => {
    // Phase 2 feeds this module externally aggregated stats across a network
    // boundary — the boundary where a null, a string, or a divide-by-zero
    // becomes NaN. A NaN feature also breaks the sort comparator, which is why
    // this is enforced rather than merely documented.
    const poisoned = candidate({
      createdAtMs: Number.NaN,
      durationSeconds: Number.NaN,
      upvotes: Number.NaN,
      downvotes: Number.POSITIVE_INFINITY,
      comments: Number.NaN,
      stats: {
        validImpressions: Number.NaN,
        validPlays: Number.NEGATIVE_INFINITY,
        completions: Number.NaN,
        longWatches: Number.NaN,
        playsWithReplay: Number.NaN,
        fastSkips: Number.NaN,
      },
    });
    const features = videoScorerFeatures(poisoned, NOW);
    for (const [name, value] of Object.entries(features)) {
      expect(Number.isFinite(value), `${name} is not finite`).toBe(true);
      expect(value, `${name} below range`).toBeGreaterThanOrEqual(0);
      expect(value, `${name} above range`).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(scoreVideoCandidate(poisoned, NOW).score)).toBe(true);
  });

  test("a poisoned candidate cannot destroy the total order of a page", () => {
    const ranked = scoreVideoCandidates(
      [
        candidate({ postId: "pst_ok_a", upvotes: 10 }),
        candidate({ postId: "pst_nan", upvotes: Number.NaN, createdAtMs: Number.NaN }),
        candidate({ postId: "pst_ok_b", upvotes: 5 }),
      ],
      NOW,
    );
    expect(ranked).toHaveLength(3);
    expect(ranked.every((entry) => Number.isFinite(entry.score))).toBe(true);
    expect(new Set(ranked.map((entry) => entry.candidate.postId)).size).toBe(3);
  });

  test("a non-finite clock does not produce a non-finite score", () => {
    expect(Number.isFinite(scoreVideoCandidate(candidate(), Number.NaN).score)).toBe(true);
  });
});

describe("replay aggregation semantics", () => {
  test("replay is a rate of plays that replayed, not a count of loops", () => {
    // playsWithReplay is countIf(replay_count > 0), not sum(replay_count).
    // Summing would make two loops on one play indistinguishable from one loop
    // on every play once the value is clamped to the denominator.
    const everyPlayLoopedOnce = videoScorerFeatures(
      candidate({ stats: stats({ validPlays: 100, playsWithReplay: 100 }) }),
      NOW,
    );
    const onePlayLoopedTwice = videoScorerFeatures(
      candidate({ stats: stats({ validPlays: 100, playsWithReplay: 1 }) }),
      NOW,
    );
    expect(everyPlayLoopedOnce.replay).toBeGreaterThan(onePlayLoopedTwice.replay);
  });

  test("a summed replay_count that overruns the denominator cannot exceed the contract", () => {
    const features = videoScorerFeatures(
      candidate({ stats: stats({ validPlays: 10, playsWithReplay: 400 }) }),
      NOW,
    );
    expect(features.replay).toBeLessThanOrEqual(1);
  });
});

describe("freshnessBonus and uncertaintyBonus", () => {
  test("freshness decays but never inverts, and is bounded", () => {
    expect(freshnessBonus(0)).toBeCloseTo(0.15, 10);
    expect(freshnessBonus(24)).toBeLessThan(freshnessBonus(0));
    expect(freshnessBonus(24 * 365)).toBeGreaterThan(0);
    expect(freshnessBonus(-5)).toBeCloseTo(0.15, 10);
  });

  test("evergreen content keeps most of its quality, unlike a decay multiplier", () => {
    // A year-old item loses at most FRESHNESS_MAX. Under the multiplicative
    // (score + 1) / (age + 2)^1.5 form it would have lost essentially all of it.
    const fresh = scoreVideoCandidate(candidate({ createdAtMs: NOW }), NOW);
    const old = scoreVideoCandidate(candidate({ createdAtMs: NOW - 365 * 24 * HOUR }), NOW);
    expect(fresh.score - old.score).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  test("uncertainty is bounded and shrinks as impressions accumulate", () => {
    expect(uncertaintyBonus(0)).toBeCloseTo(0.1, 10);
    expect(uncertaintyBonus(50)).toBeCloseTo(0.05, 10);
    expect(uncertaintyBonus(1_000_000)).toBeGreaterThan(0);
    expect(uncertaintyBonus(1_000_000)).toBeLessThan(0.001);
  });
});

describe("videoScorerFeatures", () => {
  test("every feature honours the [0,1] contract across extreme inputs", () => {
    const extremes: VideoCandidateInput[] = [
      candidate(),
      candidate({ upvotes: 100_000, comments: 100_000, stats: stats({ validImpressions: 1 }) }),
      candidate({ createdAtMs: NOW + 10 * HOUR }),
      candidate({ createdAtMs: 0 }),
      candidate({ durationSeconds: null }),
      candidate({
        stats: stats({
          validImpressions: 1_000,
          validPlays: 900,
          completions: 900,
          longWatches: 900,
          playsWithReplay: 900,
          fastSkips: 1_000,
        }),
      }),
    ];
    for (const input of extremes) {
      const features = videoScorerFeatures(input, NOW);
      for (const [name, value] of Object.entries(features)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value, `${name} below range`).toBeGreaterThanOrEqual(0);
        expect(value, `${name} above range`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("behavioral features collapse onto a shared constant without stats", () => {
    // Phase 1 reality: no behavioral denominators exist yet, so these terms must
    // not differentiate items — in particular not by duration bucket, which
    // would rank short videos higher purely for being short.
    const short = videoScorerFeatures(candidate({ durationSeconds: 5 }), NOW);
    const long = videoScorerFeatures(candidate({ durationSeconds: 300 }), NOW);
    expect(short.completion).toBeCloseTo(long.completion, 10);
    expect(short.longWatch).toBeCloseTo(long.longWatch, 10);
    expect(short.replay).toBeCloseTo(long.replay, 10);
    expect(short.negative).toBeCloseTo(long.negative, 10);
  });
});

describe("scoreVideoCandidate", () => {
  test("a brand-new post with no engagement is not ranked below an engaged one", () => {
    // The cold-start trap this replaces: `CASE WHEN score > 0 THEN 1 ELSE 0 END`
    // put every new post below anything holding a single upvote, and a new post
    // could not earn one without first being shown.
    const fresh = scoreVideoCandidate(candidate({ postId: "pst_new", createdAtMs: NOW }), NOW);
    const engaged = scoreVideoCandidate(
      candidate({ postId: "pst_old", createdAtMs: NOW - 72 * HOUR, upvotes: 1 }),
      NOW,
    );
    expect(fresh.score).toBeGreaterThan(engaged.score);
  });

  test("engagement still wins once it is substantial", () => {
    const fresh = scoreVideoCandidate(candidate({ postId: "pst_new", createdAtMs: NOW }), NOW);
    const popular = scoreVideoCandidate(
      candidate({ postId: "pst_hit", createdAtMs: NOW - 6 * HOUR, upvotes: 200, comments: 40 }),
      NOW,
    );
    expect(popular.score).toBeGreaterThan(fresh.score);
  });

  test("strong watch behavior outranks equal explicit engagement", () => {
    const base = { createdAtMs: NOW - 12 * HOUR, upvotes: 10 };
    const watched = scoreVideoCandidate(
      candidate({
        ...base,
        postId: "pst_watched",
        stats: stats({
          validImpressions: 400,
          validPlays: 400,
          completions: 320,
          longWatches: 340,
          playsWithReplay: 60,
          fastSkips: 20,
        }),
      }),
      NOW,
    );
    const skipped = scoreVideoCandidate(
      candidate({
        ...base,
        postId: "pst_skipped",
        stats: stats({
          validImpressions: 400,
          validPlays: 400,
          completions: 10,
          longWatches: 15,
          playsWithReplay: 0,
          fastSkips: 300,
        }),
      }),
      NOW,
    );
    expect(watched.score).toBeGreaterThan(skipped.score);
  });

  test("is deterministic for a fixed candidate and clock", () => {
    const input = candidate({ upvotes: 7, comments: 3 });
    expect(scoreVideoCandidate(input, NOW).score).toBe(scoreVideoCandidate(input, NOW).score);
  });

  test("exposes a stable version for telemetry", () => {
    expect(VIDEO_SCORER_VERSION).toBe("v2");
  });
});

describe("scoreVideoCandidates", () => {
  test("orders by score and breaks ties totally", () => {
    const items = [
      candidate({ postId: "pst_a", createdAtMs: NOW - 40 * HOUR }),
      candidate({ postId: "pst_b", createdAtMs: NOW - 2 * HOUR }),
      candidate({ postId: "pst_c", createdAtMs: NOW - 40 * HOUR }),
    ];
    const ranked = scoreVideoCandidates(items, NOW).map((entry) => entry.candidate.postId);
    expect(ranked[0]).toBe("pst_b");
    expect(ranked.slice(1)).toEqual(["pst_c", "pst_a"]);
  });

  test("is stable across repeated evaluation, so a page is reproducible", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      candidate({
        postId: `pst_${index}`,
        createdAtMs: NOW - (index % 4) * HOUR,
        upvotes: index % 3,
      }),
    );
    const first = scoreVideoCandidates(items, NOW).map((entry) => entry.candidate.postId);
    const second = scoreVideoCandidates([...items].reverse(), NOW).map(
      (entry) => entry.candidate.postId,
    );
    expect(second).toEqual(first);
  });

  test("does not mutate its input", () => {
    const items = [candidate({ postId: "pst_a" }), candidate({ postId: "pst_b" })];
    scoreVideoCandidates(items, NOW);
    expect(items.map((item) => item.postId)).toEqual(["pst_a", "pst_b"]);
  });
});
