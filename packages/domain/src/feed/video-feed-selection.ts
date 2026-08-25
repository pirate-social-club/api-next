// Phase 1 selection policy for the vertical video feed.
// Retained as a completed Lane B port (specs 000 §6 and 002 §4.2); selection
// ranking policy lives here as explicit constraints for the future vertical
// video feed lane.
//
// Ranking policy lives here as explicit selection constraints rather than as
// extra multiplicative terms inside the score. Folding an exposure floor or a
// diversity rule into a score makes the two interact silently; expressed as
// constraints they can be reasoned about and tested independently of tuning.

import type { ScoredVideoCandidate } from "./video-scorer";

export const VIDEO_FEED_PAGE_SIZE = 25;

// Reserved for under-measured items. Tune together with `uncertaintyBonus` in
// the scorer: they encode the same incentive, once as a score term and once as
// a constraint, so raising both at once compounds.
export const NEW_CONTENT_SLOTS_PER_PAGE = 5;
export const NEW_CONTENT_IMPRESSION_THRESHOLD = 50;

export const AUTHOR_CAP_PER_PAGE = 2;
export const COMMUNITY_CAP_PER_PAGE = 3;

export type VideoFeedSelectionPolicy = {
  authorCapPerPage: number | null;
  communityCapPerPage: number | null;
};

export const GLOBAL_VIDEO_FEED_SELECTION_POLICY: VideoFeedSelectionPolicy = {
  authorCapPerPage: AUTHOR_CAP_PER_PAGE,
  communityCapPerPage: COMMUNITY_CAP_PER_PAGE,
};

export const SINGLE_COMMUNITY_VIDEO_FEED_SELECTION_POLICY: VideoFeedSelectionPolicy = {
  authorCapPerPage: null,
  communityCapPerPage: null,
};

function isUnderMeasured(candidate: ScoredVideoCandidate): boolean {
  return (candidate.candidate.stats?.validImpressions ?? 0) < NEW_CONTENT_IMPRESSION_THRESHOLD;
}

type PageBuildState = {
  authorCounts: Map<string, number>;
  communityCounts: Map<string, number>;
  selected: ScoredVideoCandidate[];
  selectedIds: Set<string>;
};

function candidateKey(candidate: ScoredVideoCandidate): string {
  return `${candidate.candidate.communityId}\u0000${candidate.candidate.postId}`;
}

function capsAllow(
  state: PageBuildState,
  candidate: ScoredVideoCandidate,
  policy: VideoFeedSelectionPolicy,
): boolean {
  const { authorUserId, communityId } = candidate.candidate;
  if (
    policy.communityCapPerPage != null &&
    (state.communityCounts.get(communityId) ?? 0) >= policy.communityCapPerPage
  )
    return false;
  // Anonymous posts share no author identity, so they are capped by community
  // only — otherwise every anonymous post in the corpus would contend for the
  // same two slots.
  if (
    authorUserId &&
    policy.authorCapPerPage != null &&
    (state.authorCounts.get(authorUserId) ?? 0) >= policy.authorCapPerPage
  ) {
    return false;
  }
  return true;
}

function admit(state: PageBuildState, candidate: ScoredVideoCandidate): void {
  const { authorUserId, communityId } = candidate.candidate;
  state.selected.push(candidate);
  state.selectedIds.add(candidateKey(candidate));
  state.communityCounts.set(communityId, (state.communityCounts.get(communityId) ?? 0) + 1);
  if (authorUserId) {
    state.authorCounts.set(authorUserId, (state.authorCounts.get(authorUserId) ?? 0) + 1);
  }
}

/**
 * Fills one page from `remaining` (score-ordered, highest first) and returns the
 * selected items in score order. Selected items are removed from `remaining`.
 *
 * Caps are skip-and-continue rather than filters: a capped candidate stays in
 * `remaining` and remains eligible for a later page, so diversity within a page
 * never costs an item its place in the feed.
 */
export function takeVideoFeedPage(
  remaining: ScoredVideoCandidate[],
  pageSize: number = VIDEO_FEED_PAGE_SIZE,
  policy: VideoFeedSelectionPolicy = GLOBAL_VIDEO_FEED_SELECTION_POLICY,
): ScoredVideoCandidate[] {
  const state: PageBuildState = {
    authorCounts: new Map(),
    communityCounts: new Map(),
    selected: [],
    selectedIds: new Set(),
  };

  const fill = (limit: number, predicate: (candidate: ScoredVideoCandidate) => boolean): void => {
    let admitted = 0;
    for (const candidate of remaining) {
      if (state.selected.length >= pageSize || admitted >= limit) return;
      if (state.selectedIds.has(candidateKey(candidate))) continue;
      if (!predicate(candidate)) continue;
      if (!capsAllow(state, candidate, policy)) continue;
      admit(state, candidate);
      admitted += 1;
    }
  };

  // Reserved pass first, so under-measured items claim their slots before the
  // general pass consumes the page. Unfilled reserved slots simply fall through
  // to the general pass — the floor never shrinks a page.
  fill(NEW_CONTENT_SLOTS_PER_PAGE, isUnderMeasured);
  fill(Number.POSITIVE_INFINITY, () => true);

  if (state.selectedIds.size > 0) {
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index];
      if (candidate && state.selectedIds.has(candidateKey(candidate))) {
        remaining.splice(index, 1);
      }
    }
  }

  // The floor decides membership, not position: the page a viewer sees is still
  // ordered by score.
  return state.selected.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.candidate.postId.localeCompare(left.candidate.postId);
  });
}

/**
 * Returns the page at `offset` (which the cursor always keeps aligned to
 * `pageSize`) by building pages in sequence, so that a candidate skipped by a
 * cap on page N is still reachable on page N+1.
 */
export function selectVideoFeedPage(input: {
  offset: number;
  pageSize?: number;
  policy?: VideoFeedSelectionPolicy;
  scored: readonly ScoredVideoCandidate[];
}): { hasMore: boolean; items: ScoredVideoCandidate[] } {
  const pageSize = Math.max(1, input.pageSize ?? VIDEO_FEED_PAGE_SIZE);
  const pageIndex = Math.max(0, Math.floor(input.offset / pageSize));
  const remaining = [...input.scored];

  let page: ScoredVideoCandidate[] = [];
  for (let index = 0; index <= pageIndex; index += 1) {
    page = takeVideoFeedPage(remaining, pageSize, input.policy);
    // Caps guarantee at least one admission per page while candidates remain,
    // but an empty page still terminates the walk rather than spinning.
    if (page.length === 0) break;
  }

  return { hasMore: remaining.length > 0, items: page };
}
