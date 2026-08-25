// Phase 1 of the vertical video feed ranking scorer. Retained as a completed
// Lane B port (specs 000 §6 and 002 §4.2).
//
// Ranking for the vertical video feed. This module is pure and synchronous: no
// I/O, no clock, no environment. That is deliberate and load-bearing. Ordering
// previously lived in a SQL ORDER BY that had to be portable across the
// Postgres and D1/libsql control-plane runtimes, and the recency term was
// deleted outright when D1 rejected its date arithmetic
// (home-feed-service.ts:195-198). Keeping scoring out of the query plan makes
// that class of regression impossible and makes the scorer unit-testable.
//
// Nothing here may import from the serving path; the dependency points one way.

export const VIDEO_SCORER_VERSION = "v2";

export type VideoDurationBucket = "lt_10s" | "10_30s" | "30_60s" | "gt_60s";

/**
 * Behavioral aggregates for one post. Null until Phase 2 lands the Tinybird
 * feature sync; every consumer must treat absence as "no evidence", not as
 * "zero engagement".
 */
export type VideoCandidateStats = {
  validImpressions: number;
  validPlays: number;
  completions: number;
  longWatches: number;
  /**
   * Impressions that replayed at least once — NOT the sum of `replay_count`.
   *
   * The client emits `replay_count` per impression and it can exceed one, so a
   * Phase 2 pipe that sums it would make two loops on a single play
   * indistinguishable from one loop on every play once the value is clamped to
   * the denominator. The Tinybird pipe must therefore compute
   * `countIf(replay_count > 0)`. If replay *intensity* turns out to be worth
   * ranking on, it needs its own separately bounded feature rather than
   * overloading this one.
   */
  playsWithReplay: number;
  fastSkips: number;
};

export type VideoCandidateInput = {
  postId: string;
  communityId: string;
  authorUserId: string | null;
  createdAtMs: number;
  durationSeconds: number | null;
  upvotes: number;
  downvotes: number;
  comments: number;
  likes: number;
  stats: VideoCandidateStats | null;
};

/**
 * Every field is in [0,1]. This is a hard contract, not a convention: the
 * feature vector is logged per impression and compared across scorer versions,
 * so an unbounded field silently changes the meaning of every historical
 * comparison. `explicit` is the one feature whose natural form is unbounded —
 * see `explicitEngagement` below.
 */
export type VideoScorerFeatures = {
  completion: number;
  longWatch: number;
  replay: number;
  negative: number;
  explicit: number;
  disapproval: number;
  freshness: number;
  uncertainty: number;
};

export type ScoredVideoCandidate = {
  candidate: VideoCandidateInput;
  score: number;
  features: VideoScorerFeatures;
};

const WEIGHT_COMPLETION = 0.45;
const WEIGHT_LONG_WATCH = 0.3;
const WEIGHT_REPLAY = 0.15;
const WEIGHT_EXPLICIT = 0.1;
const WEIGHT_NEGATIVE = 0.45;

// Explicit disapproval is weighted well above explicit approval on purpose.
// `explicit` saturates, so a post can buy its way to the term's ceiling with
// comment volume alone; without a heavier disapproval weight that ceiling would
// let a heavily-downvoted post out-rank a neutral one. It also has to stand in
// for `negative` during Phase 1, where behavioral stats do not exist and the
// fast-skip term is the same constant for every item.
const WEIGHT_DISAPPROVAL = 0.35;
const DISAPPROVAL_PRIOR = 0.15;

// Additive and bounded, never multiplicative. A multiplicative decay term such
// as the surviving `(score + 1) / (age + 2)^1.5` drives evergreen content
// asymptotically to zero no matter how good it is; a bounded bonus expresses
// "new things get a leg up" without also expressing "old things are worthless".
const FRESHNESS_MAX = 0.15;
const FRESHNESS_TAU_HOURS = 24;

// Subsidises under-measured items. Tune this together with the exposure floor
// in the selector: they encode the same incentive, once in the score and once
// as a constraint, so raising both at once compounds.
const UNCERTAINTY_MAX = 0.1;
const UNCERTAINTY_K = 50;

// Beta prior strength for every smoothed rate, in units of pseudo-observations.
const PRIOR_WEIGHT = 20;

// Half-saturation constant for `explicit`: the engagement-per-impression ratio
// that maps to 0.5. Calibrate from the global median once Phase 2 supplies real
// impression denominators; changing it is a VIDEO_SCORER_VERSION bump.
const EXPLICIT_SATURATION_K = 0.5;

/**
 * Shrinkage targets per duration bucket.
 *
 * Phase 1 seeds every bucket with the SAME value on purpose. Completion is
 * strongly duration-dependent, so per-bucket targets are the right long-term
 * shape — but with no observations yet, every posterior collapses onto its
 * prior, and differing priors would rank short videos above long ones purely
 * for being short. That is exactly the bias the buckets exist to remove. Phase
 * 2 replaces these with measured per-bucket means, at which point the structure
 * is already in place and the change is a constants edit.
 */
const COMPLETION_PRIOR: Record<VideoDurationBucket, number> = {
  lt_10s: 0.3,
  "10_30s": 0.3,
  "30_60s": 0.3,
  gt_60s: 0.3,
};

const LONG_WATCH_PRIOR: Record<VideoDurationBucket, number> = {
  lt_10s: 0.35,
  "10_30s": 0.35,
  "30_60s": 0.35,
  gt_60s: 0.35,
};

const REPLAY_PRIOR = 0.06;
const NEGATIVE_PRIOR = 0.35;

/**
 * Coerces any numeric input to a finite, non-negative value.
 *
 * The [0,1] feature contract is only as good as its inputs: NaN and Infinity
 * propagate through every arithmetic path here and, worse, poison the sort
 * comparator — a NaN comparison returns false in both directions and silently
 * destroys the total-order guarantee that makes a page reproducible. Phase 1
 * reads counters that are already parsed, but Phase 2 feeds this module
 * externally aggregated stats over a network boundary, which is exactly where
 * a null, a string, or a division by zero turns into NaN.
 */
export function finiteCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function videoDurationBucket(durationSeconds: number | null): VideoDurationBucket {
  // Unknown duration takes the short-form bucket rather than a bucket of its
  // own: it is the modal case for this surface, and an unknown-duration bucket
  // would become a dumping ground whose prior means nothing.
  if (durationSeconds == null || !Number.isFinite(durationSeconds)) return "10_30s";
  if (durationSeconds < 10) return "lt_10s";
  if (durationSeconds < 30) return "10_30s";
  if (durationSeconds < 60) return "30_60s";
  return "gt_60s";
}

/**
 * Beta-smoothed rate. Counts are never used directly: a count rewards traffic,
 * and traffic is a function of past ranking, which is the loop that ossifies a
 * feed.
 */
export function posteriorRate(
  successes: number,
  trials: number,
  priorMean: number,
  priorWeight: number = PRIOR_WEIGHT,
): number {
  const safeTrials = finiteCount(trials);
  const safeSuccesses = Math.min(finiteCount(successes), safeTrials);
  const safePriorMean = Math.min(1, finiteCount(priorMean));
  const safePriorWeight = Math.max(1, finiteCount(priorWeight));
  return (safeSuccesses + safePriorMean * safePriorWeight) / (safeTrials + safePriorWeight);
}

/**
 * Downvote share among cast votes, smoothed toward a global prior.
 *
 * Modelled as its own bounded feature rather than by netting votes off against
 * each other: `upvotes - downvotes` throws away the denominator, so 30-up/0-down
 * and 130-up/100-down collapse to the same number despite describing very
 * different reception. Unlike `explicit`, this one has a real denominator —
 * total votes cast — so a plain smoothed rate is correct here and saturation is
 * unnecessary.
 */
export function disapprovalRate(input: { upvotes: number; downvotes: number }): number {
  const downvotes = finiteCount(input.downvotes);
  const upvotes = finiteCount(input.upvotes);
  return posteriorRate(downvotes, upvotes + downvotes, DISAPPROVAL_PRIOR);
}

/**
 * Votes, comments, and likes are read from the projection counters and are not
 * impression-attributed, so no denominator bounds them: a posterior rate here
 * can exceed 1 whenever engagement outruns impressions. Saturating the raw
 * ratio maps [0, inf) to [0, 1) monotonically instead.
 *
 * Clamping to 1 was rejected — it discards ordering among exactly the
 * most-engaged items in the corpus, the opposite of what the term is for.
 */
export function explicitEngagement(input: {
  upvotes: number;
  comments: number;
  likes: number;
  validImpressions: number;
}): number {
  const points =
    finiteCount(input.upvotes) + 2 * finiteCount(input.comments) + finiteCount(input.likes);
  const ratio = points / (finiteCount(input.validImpressions) + PRIOR_WEIGHT);
  return ratio / (ratio + EXPLICIT_SATURATION_K);
}

export function freshnessBonus(ageHours: number): number {
  return FRESHNESS_MAX * Math.exp(-finiteCount(ageHours) / FRESHNESS_TAU_HOURS);
}

export function uncertaintyBonus(validImpressions: number): number {
  const impressions = finiteCount(validImpressions);
  return UNCERTAINTY_MAX * (1 - impressions / (impressions + UNCERTAINTY_K));
}

export function videoScorerFeatures(
  candidate: VideoCandidateInput,
  nowMs: number,
): VideoScorerFeatures {
  const bucket = videoDurationBucket(candidate.durationSeconds);
  const stats = candidate.stats;
  const validPlays = finiteCount(stats?.validPlays);
  const validImpressions = finiteCount(stats?.validImpressions);
  // A non-finite createdAtMs must not become a non-finite age. Treating it as
  // maximally old is the safe direction: an unparseable timestamp forfeits the
  // freshness bonus rather than winning the whole feed with NaN.
  const createdAtMs = Number.isFinite(candidate.createdAtMs) ? candidate.createdAtMs : 0;
  const ageHours = Math.max(0, (finiteCount(nowMs) - createdAtMs) / 3_600_000);

  return {
    completion: posteriorRate(stats?.completions ?? 0, validPlays, COMPLETION_PRIOR[bucket]),
    longWatch: posteriorRate(stats?.longWatches ?? 0, validPlays, LONG_WATCH_PRIOR[bucket]),
    replay: posteriorRate(stats?.playsWithReplay ?? 0, validPlays, REPLAY_PRIOR),
    negative: posteriorRate(stats?.fastSkips ?? 0, validImpressions, NEGATIVE_PRIOR),
    explicit: explicitEngagement({
      comments: candidate.comments,
      likes: candidate.likes,
      upvotes: candidate.upvotes,
      validImpressions,
    }),
    disapproval: disapprovalRate({
      downvotes: candidate.downvotes,
      upvotes: candidate.upvotes,
    }),
    freshness: freshnessBonus(ageHours) / FRESHNESS_MAX,
    uncertainty: uncertaintyBonus(validImpressions) / UNCERTAINTY_MAX,
  };
}

/**
 * Until Phase 2 supplies behavioral denominators every candidate carries
 * `stats: null`, so completion/longWatch/replay/negative all collapse onto
 * their shared priors and contribute an identical constant to every score.
 * Ranking in Phase 1 is therefore driven by `explicit`, `disapproval`, and
 * `freshness` — which is precisely the decayed-engagement ordering this phase
 * is meant to deliver, and which preserves the downvote signal the outgoing
 * `(upvote_count - downvote_count)` SQL score carried. The behavioral terms
 * start discriminating on their own the moment real denominators arrive, with
 * no interface change.
 */
export function scoreVideoCandidate(
  candidate: VideoCandidateInput,
  nowMs: number,
): ScoredVideoCandidate {
  const features = videoScorerFeatures(candidate, nowMs);
  const quality =
    WEIGHT_COMPLETION * features.completion +
    WEIGHT_LONG_WATCH * features.longWatch +
    WEIGHT_REPLAY * features.replay +
    WEIGHT_EXPLICIT * features.explicit -
    WEIGHT_NEGATIVE * features.negative -
    WEIGHT_DISAPPROVAL * features.disapproval;
  const score =
    quality + FRESHNESS_MAX * features.freshness + UNCERTAINTY_MAX * features.uncertainty;
  // Belt and braces over the input sanitisation: a non-finite score would
  // break the comparator's total order rather than merely misrank one item.
  return { candidate, features, score: Number.isFinite(score) ? score : 0 };
}

export function scoreVideoCandidates(
  candidates: readonly VideoCandidateInput[],
  nowMs: number,
): ScoredVideoCandidate[] {
  return candidates
    .map((candidate) => scoreVideoCandidate(candidate, nowMs))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Total order, so a page is reproducible for a fixed candidate set and
      // clock even when scores tie exactly.
      if (right.candidate.createdAtMs !== left.candidate.createdAtMs) {
        return right.candidate.createdAtMs - left.candidate.createdAtMs;
      }
      return right.candidate.postId.localeCompare(left.candidate.postId);
    });
}
