import { describe, expect, test } from "bun:test";

import {
  AUTHOR_CAP_PER_PAGE,
  COMMUNITY_CAP_PER_PAGE,
  NEW_CONTENT_SLOTS_PER_PAGE,
  SINGLE_COMMUNITY_VIDEO_FEED_SELECTION_POLICY,
  selectVideoFeedPage,
  takeVideoFeedPage,
} from "./video-feed-selection";
import type { ScoredVideoCandidate } from "./video-scorer";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

function scored(input: {
  postId: string;
  score: number;
  authorUserId?: string | null;
  communityId?: string;
  validImpressions?: number;
}): ScoredVideoCandidate {
  return {
    candidate: {
      postId: input.postId,
      communityId: input.communityId ?? `cmt_${input.postId}`,
      authorUserId: input.authorUserId === undefined ? `usr_${input.postId}` : input.authorUserId,
      createdAtMs: NOW,
      durationSeconds: 20,
      upvotes: 0,
      downvotes: 0,
      comments: 0,
      likes: 0,
      stats:
        input.validImpressions === undefined
          ? null
          : {
              validImpressions: input.validImpressions,
              validPlays: input.validImpressions,
              completions: 0,
              longWatches: 0,
              playsWithReplay: 0,
              fastSkips: 0,
            },
    },
    features: {
      completion: 0,
      longWatch: 0,
      replay: 0,
      negative: 0,
      explicit: 0,
      disapproval: 0,
      freshness: 0,
      uncertainty: 0,
    },
    score: input.score,
  };
}

function ladder(
  count: number,
  options: Partial<Parameters<typeof scored>[0]> = {},
): ScoredVideoCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    scored({
      postId: `pst_${String(index).padStart(3, "0")}`,
      score: 1 - index / 1000,
      ...options,
    }),
  );
}

const ids = (items: ScoredVideoCandidate[]) => items.map((item) => item.candidate.postId);

describe("takeVideoFeedPage", () => {
  test("fills a page in score order and consumes the selected candidates", () => {
    const remaining = ladder(10);
    const page = takeVideoFeedPage(remaining, 4);
    expect(ids(page)).toEqual(["pst_000", "pst_001", "pst_002", "pst_003"]);
    expect(remaining).toHaveLength(6);
  });

  test("caps one community at three per page and leaves the rest for later", () => {
    const remaining = [
      ...ladder(6, { communityId: "cmt_loud" }),
      scored({ postId: "pst_other", score: 0.1, communityId: "cmt_quiet" }),
    ];
    const page = takeVideoFeedPage(remaining, 5);
    const fromLoud = page.filter((item) => item.candidate.communityId === "cmt_loud");
    expect(fromLoud).toHaveLength(COMMUNITY_CAP_PER_PAGE);
    expect(ids(page)).toContain("pst_other");
    // Skip-and-continue, not a filter: the capped items are still available.
    expect(remaining.length).toBeGreaterThan(0);
  });

  test("caps one author at two per page", () => {
    const remaining = ladder(6, { authorUserId: "usr_prolific", communityId: "cmt_shared" });
    const page = takeVideoFeedPage(remaining, 5);
    expect(page).toHaveLength(Math.min(AUTHOR_CAP_PER_PAGE, COMMUNITY_CAP_PER_PAGE));
  });

  test("drops community and author caps for a single-community feed", () => {
    const remaining = Array.from({ length: 6 }, (_, index) =>
      scored({
        postId: `pst_scoped_${index}`,
        score: 1 - index / 100,
        authorUserId: "usr_only_creator",
        communityId: "cmt_single",
      }),
    );
    const page = takeVideoFeedPage(remaining, 5, SINGLE_COMMUNITY_VIDEO_FEED_SELECTION_POLICY);
    expect(page).toHaveLength(5);
  });

  test("does not cap anonymous posts against a shared author identity", () => {
    const remaining = ladder(6, { authorUserId: null, communityId: "cmt_anon" });
    const page = takeVideoFeedPage(remaining, 5);
    expect(page).toHaveLength(COMMUNITY_CAP_PER_PAGE);
  });

  test("reserves slots for under-measured items over higher-scoring measured ones", () => {
    const measured = Array.from({ length: 20 }, (_, index) =>
      scored({
        postId: `pst_hit_${index}`,
        score: 10 - index / 100,
        validImpressions: 5_000,
      }),
    );
    const fresh = Array.from({ length: 8 }, (_, index) =>
      scored({
        postId: `pst_new_${index}`,
        score: 0.01 - index / 10_000,
        validImpressions: 0,
      }),
    );
    const page = takeVideoFeedPage([...measured, ...fresh], 25);
    const admitted = page.filter((item) => item.candidate.postId.startsWith("pst_new_"));
    expect(admitted).toHaveLength(NEW_CONTENT_SLOTS_PER_PAGE);
  });

  test("returns unfilled reserved slots to the general pool", () => {
    const measured = Array.from({ length: 10 }, (_, index) =>
      scored({
        postId: `pst_hit_${index}`,
        score: 10 - index,
        validImpressions: 5_000,
      }),
    );
    const page = takeVideoFeedPage(
      [
        ...measured,
        scored({
          postId: "pst_new",
          score: 0.01,
          validImpressions: 0,
        }),
      ],
      6,
    );
    expect(page).toHaveLength(6);
    expect(ids(page)).toContain("pst_new");
  });

  test("orders the page by score even though the floor decided membership", () => {
    const page = takeVideoFeedPage(
      [
        scored({ postId: "pst_low", score: 0.1, validImpressions: 0 }),
        scored({ postId: "pst_high", score: 0.9, validImpressions: 5_000 }),
      ],
      2,
    );
    expect(ids(page)).toEqual(["pst_high", "pst_low"]);
  });

  test("never returns more than the page size", () => {
    const remaining = ladder(100);
    expect(takeVideoFeedPage(remaining, 25)).toHaveLength(25);
  });

  test("treats the same post id in different communities as distinct candidates", () => {
    const remaining = [
      scored({ postId: "pst_shared", communityId: "cmt_a", score: 1 }),
      scored({ postId: "pst_shared", communityId: "cmt_b", score: 0.9 }),
    ];
    const page = takeVideoFeedPage(remaining, 2);
    expect(page).toHaveLength(2);
    expect(remaining).toHaveLength(0);
  });
});

describe("selectVideoFeedPage", () => {
  test("pages do not overlap and together cover the corpus", () => {
    const corpus = ladder(60);
    const first = selectVideoFeedPage({ offset: 0, pageSize: 25, scored: corpus });
    const second = selectVideoFeedPage({ offset: 25, pageSize: 25, scored: corpus });
    const third = selectVideoFeedPage({ offset: 50, pageSize: 25, scored: corpus });
    const seen = [...ids(first.items), ...ids(second.items), ...ids(third.items)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(60);
    expect(third.hasMore).toBe(false);
  });

  test("a candidate skipped by a cap on page one is reachable on page two", () => {
    const corpus = ladder(8, { communityId: "cmt_single" });
    const first = selectVideoFeedPage({ offset: 0, pageSize: 25, scored: corpus });
    const second = selectVideoFeedPage({ offset: 25, pageSize: 25, scored: corpus });
    expect(first.items).toHaveLength(COMMUNITY_CAP_PER_PAGE);
    expect(first.hasMore).toBe(true);
    expect(ids(second.items)).not.toEqual(ids(first.items));
    expect(second.items.length).toBeGreaterThan(0);
  });

  test("is deterministic for a fixed candidate set", () => {
    const corpus = ladder(40);
    const once = selectVideoFeedPage({ offset: 25, pageSize: 25, scored: corpus });
    const twice = selectVideoFeedPage({ offset: 25, pageSize: 25, scored: corpus });
    expect(ids(once.items)).toEqual(ids(twice.items));
  });

  test("does not mutate the caller's candidate list", () => {
    const corpus = ladder(30);
    selectVideoFeedPage({ offset: 0, pageSize: 25, scored: corpus });
    expect(corpus).toHaveLength(30);
  });

  test("reports no more pages once the corpus is exhausted", () => {
    const corpus = ladder(5);
    const page = selectVideoFeedPage({ offset: 0, pageSize: 25, scored: corpus });
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  test("returns an empty page past the end without spinning", () => {
    const page = selectVideoFeedPage({ offset: 250, pageSize: 25, scored: ladder(5) });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});
