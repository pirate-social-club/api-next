import {
  ControlPlaneDb,
  type ControlPlaneError,
  FeedRepositoryError,
  type FeedRepositoryFailure,
  type FeedStore,
  type FeedStoreService,
  type HomeFeedDocument,
  type HomeFeedQuery,
} from "@pirate/application";
import { postSlugCanonicalPath } from "@pirate/application/post-slug";
import { Effect, type Layer } from "effect";
import { publicPersonaFromSql } from "./public-persona-projection";

const PAGE_SIZE = 20;
const DEFAULT_LOCALE = "en";

type FeedSort = "best" | "top" | "new";
type FeedTimeRange = "hour" | "day" | "week" | "month" | "year" | "all";
type Row = Readonly<Record<string, unknown>>;

type FeedCursor = Readonly<{
  readonly version: 1;
  readonly sort: FeedSort;
  readonly timeRange: FeedTimeRange;
  readonly asOf: number;
  readonly rank: number | null;
  readonly created: number;
  readonly feedItemId: string;
}>;

export interface FeedRepositoryOptions {
  readonly now?: () => number;
}

export interface FeedRepository {
  readonly listHome: (
    input: Parameters<FeedStoreService["listHome"]>[0],
  ) => Effect.Effect<HomeFeedDocument, FeedRepositoryFailure, ControlPlaneDb>;
}

const invalidRow = () => new FeedRepositoryError({ operation: "list-home", reason: "invalid-row" });

const invalidCursor = () =>
  new FeedRepositoryError({ operation: "list-home", reason: "invalid-cursor" });

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
};

const optionalString = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
};

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const countValue = (row: Row, key: string): number | null => {
  const value = finiteNumber(row[key]);
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const epochSeconds = (value: unknown): number | null => {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? Math.floor(time / 1_000) : null;
  }
  if (typeof value === "string") {
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) return epochSeconds(Number(value));
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.floor(time / 1_000) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = Math.abs(value) >= 100_000_000_000 ? value / 1_000 : value;
    const normalized = Math.floor(seconds);
    return Number.isSafeInteger(normalized) ? normalized : null;
  }
  return null;
};

const booleanValue = (row: Row, key: string): boolean | null =>
  typeof row[key] === "boolean" ? row[key] : null;

const ageLockedResource = () =>
  ({
    kind: "age_locked",
    content_rating: "adult_18",
    next_action: { kind: "verify_minimum_age", minimum_age: 18 },
  }) as const;

const sortFrom = (query: HomeFeedQuery): FeedSort => query.sort ?? "best";
const timeRangeFrom = (query: HomeFeedQuery): FeedTimeRange => query.time_range ?? "all";

const cutoffSeconds = (timeRange: FeedTimeRange, asOf: number): number | null => {
  if (timeRange === "all") return null;
  const hours: Readonly<Record<Exclude<FeedTimeRange, "all">, number>> = {
    hour: 1,
    day: 24,
    week: 168,
    month: 720,
    year: 8_760,
  };
  return asOf - hours[timeRange] * 3_600;
};

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
};

const base64UrlDecode = (value: string): string => {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

const encodeCursor = (cursor: FeedCursor): string =>
  `hf1.${base64UrlEncode(
    JSON.stringify({
      v: cursor.version,
      s: cursor.sort,
      t: cursor.timeRange,
      a: cursor.asOf,
      r: cursor.rank,
      c: cursor.created,
      i: cursor.feedItemId,
    }),
  )}`;

const decodeCursor = (
  value: string | undefined,
  expectedSort: FeedSort,
  expectedTimeRange: FeedTimeRange,
): FeedCursor | null => {
  if (value === undefined) return null;
  if (!value.startsWith("hf1.")) throw invalidCursor();
  try {
    const parsed = JSON.parse(base64UrlDecode(value.slice(4))) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
    const record = parsed as Record<string, unknown>;
    const rank = record.r === null ? null : finiteNumber(record.r);
    if (
      record.v !== 1 ||
      record.s !== expectedSort ||
      record.t !== expectedTimeRange ||
      typeof record.a !== "number" ||
      !Number.isSafeInteger(record.a) ||
      record.a <= 0 ||
      typeof record.c !== "number" ||
      !Number.isSafeInteger(record.c) ||
      record.c <= 0 ||
      typeof record.i !== "string" ||
      record.i.length === 0 ||
      record.i.length > 512 ||
      (expectedSort === "new" ? rank !== null : rank === null)
    ) {
      throw invalidCursor();
    }
    return {
      version: 1,
      sort: expectedSort,
      timeRange: expectedTimeRange,
      asOf: record.a,
      rank,
      created: record.c,
      feedItemId: record.i,
    };
  } catch (error) {
    if (error instanceof FeedRepositoryError) throw error;
    throw invalidCursor();
  }
};

const allowedPostType = (value: string) =>
  value === "text" ||
  value === "image" ||
  value === "video" ||
  value === "link" ||
  value === "song" ||
  value === "crosspost" ||
  value === "file";

const feedItemFromRow = (
  row: Row,
  locale: string,
  viewerUserId: string | undefined,
): HomeFeedDocument["items"][number] | null => {
  const feedItemId = stringValue(row, "feed_item_id");
  const postId = stringValue(row, "post_id");
  const communityId = stringValue(row, "community_id");
  const displayName = stringValue(row, "display_name");
  const postType = stringValue(row, "post_type");
  const visibility = stringValue(row, "visibility");
  const created = epochSeconds(row.created_at);
  const commentsLocked = booleanValue(row, "comments_locked");
  const memberCount = countValue(row, "member_count");
  const followerCount = countValue(row, "follower_count");
  const upvoteCount = countValue(row, "upvote_count");
  const downvoteCount = countValue(row, "downvote_count");
  const commentCount = countValue(row, "comment_count");
  const rank = finiteNumber(row.rank_score);
  const viewerVoteValue = row.viewer_vote === null ? null : finiteNumber(row.viewer_vote);
  const viewerVote = viewerVoteValue === 1 || viewerVoteValue === -1 ? viewerVoteValue : null;
  const contentRating = stringValue(row, "content_rating");
  const ratingViewAllowed = booleanValue(row, "rating_view_allowed");
  const canonicalSlug = optionalString(row, "canonical_slug");
  if (
    feedItemId === null ||
    postId === null ||
    communityId === null ||
    displayName === null ||
    postType === null ||
    !allowedPostType(postType) ||
    (visibility !== "public" && visibility !== "members_only") ||
    created === null ||
    commentsLocked === null ||
    memberCount === null ||
    followerCount === null ||
    upvoteCount === null ||
    downvoteCount === null ||
    commentCount === null ||
    rank === null ||
    (row.viewer_vote !== null && viewerVote === null) ||
    (contentRating !== "general" && contentRating !== "adult_18") ||
    ratingViewAllowed === null
  ) {
    return null;
  }

  if (
    (postType === "text" || postType === "song") &&
    contentRating === "adult_18" &&
    !ratingViewAllowed
  ) {
    return ageLockedResource();
  }

  const canonicalPath =
    visibility === "public" && contentRating === "general" && canonicalSlug !== null
      ? postSlugCanonicalPath(canonicalSlug)
      : null;
  if (
    visibility === "public" &&
    contentRating === "general" &&
    canonicalSlug !== null &&
    canonicalPath === null
  ) {
    return null;
  }

  const authorPersona = publicPersonaFromSql(row.author_persona);
  const authorAccountId = optionalString(row, "actor_account_id");
  if (authorPersona === undefined) return null;
  const community = {
    id: communityId,
    object: "home_feed_community_summary" as const,
    display_name: displayName,
    member_count: memberCount,
    follower_count: followerCount,
  };
  return {
    community,
    post: {
      ...(canonicalPath === null ? {} : { canonical_path: canonicalPath }),
      post: {
        id: postId,
        object: "post",
        community: communityId,
        author_persona: authorPersona,
        author_public_handle: null,
        authorship_mode: "human_direct",
        agent: null,
        agent_ownership_record: null,
        identity_mode: "public",
        anonymous_scope: null,
        anonymous_label: null,
        post_type: postType,
        status: "published",
        comments_locked: commentsLocked,
        visibility,
        title: optionalString(row, "title"),
        body: optionalString(row, "body"),
        analysis_state: "allow",
        content_safety_state: "safe",
        age_gate_policy: "none",
        created,
      },
      thread_snapshot: null,
      upvote_count: upvoteCount,
      downvote_count: downvoteCount,
      like_count: 0,
      comment_count: commentCount,
      viewer_vote: viewerVote,
      viewer_is_author: viewerUserId !== undefined && authorAccountId === viewerUserId,
      viewer_reaction_kinds: [],
      resolved_locale: locale,
      translation_state: "policy_blocked",
      machine_translated: false,
      source_hash: null,
    },
  };
};

const homeFeedStatement = (input: {
  readonly cursor: FeedCursor | null;
  readonly cutoff: number | null;
  readonly sort: FeedSort;
  readonly viewerUserId?: string;
}) => {
  const ranked = input.sort !== "new";
  const orderBy = ranked
    ? "h.rank_score DESC, p.created_at DESC, h.feed_item_id DESC"
    : "p.created_at DESC, h.feed_item_id DESC";
  const cursorPredicate =
    input.cursor === null
      ? "($3::double precision IS NULL AND $4::double precision IS NULL AND $5::text IS NULL)"
      : ranked
        ? "(h.rank_score, p.created_at, h.feed_item_id) < ($3::double precision, to_timestamp($4), $5::text)"
        : "($3::double precision IS NULL AND (p.created_at, h.feed_item_id) < (to_timestamp($4), $5::text))";

  return {
    label: "feed.home.list",
    text: `SELECT h.feed_item_id,
                  h.rank_score,
                  h.projected_at,
                  p.community_id,
                  p.post_id,
                  p.author_user_id AS actor_account_id,
                  public_persona_projection(p.author_persona_id) AS author_persona,
                  p.post_type,
                  p.visibility,
                  p.title,
                  p.body,
                  p.content_rating,
                  alias.slug AS canonical_slug,
                  (p.post_type NOT IN ('text', 'song')
                    OR can_account_view_content_rating_v1($1, p.content_rating)) AS rating_view_allowed,
                  p.comments_locked,
                  p.created_at,
                  c.display_name,
                  (SELECT COUNT(*)
                     FROM community_memberships AS membership_count
                    WHERE membership_count.community_id = c.community_id
                      AND membership_count.status = 'member') AS member_count,
                  (SELECT COUNT(*)
                     FROM community_follows AS follow_count
                    WHERE follow_count.community_id = c.community_id
                      AND follow_count.status = 'active') AS follower_count,
                  (SELECT COUNT(*)
                     FROM post_votes AS upvotes
                    WHERE upvotes.community_id = p.community_id
                      AND upvotes.post_id = p.post_id
                      AND upvotes.vote_value = 1) AS upvote_count,
                  (SELECT COUNT(*)
                     FROM post_votes AS downvotes
                    WHERE downvotes.community_id = p.community_id
                      AND downvotes.post_id = p.post_id
                      AND downvotes.vote_value = -1) AS downvote_count,
                  (SELECT COUNT(*)
                     FROM comments AS comment_count
                    WHERE comment_count.community_id = p.community_id
                      AND comment_count.post_id = p.post_id
                      AND comment_count.status = 'published') AS comment_count,
                  CASE WHEN $1::text IS NULL THEN NULL
                       ELSE (SELECT viewer_vote.vote_value
                               FROM post_votes AS viewer_vote
                              WHERE viewer_vote.community_id = p.community_id
                                AND viewer_vote.post_id = p.post_id
                                AND viewer_vote.user_id = $1)
                  END AS viewer_vote
             FROM home_feed_projection AS h
             JOIN posts AS p
               ON p.community_id = h.community_id
              AND p.post_id = h.post_id
             JOIN communities AS c
               ON c.community_id = h.community_id
             LEFT JOIN post_slug_aliases AS alias
               ON alias.post_id = p.post_id
            WHERE c.status = 'active'
              AND p.status = 'published'
              AND ($2::double precision IS NULL OR EXTRACT(EPOCH FROM p.created_at) >= $2)
              AND (
                p.visibility = 'public'
                OR (
                  $1::text IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM community_memberships AS viewer_membership
                     WHERE viewer_membership.community_id = p.community_id
                       AND viewer_membership.user_id = $1
                       AND viewer_membership.status = 'member'
                  )
                )
              )
              AND ${cursorPredicate}
            ORDER BY ${orderBy}
            LIMIT $6`
      .replace(/\s+/gu, " ")
      .trim(),
    values: [
      input.viewerUserId ?? null,
      input.cutoff,
      input.cursor?.rank ?? null,
      input.cursor?.created ?? null,
      input.cursor?.feedItemId ?? null,
      PAGE_SIZE + 1,
    ],
    readonly: true,
  } as const;
};

export function makeControlPlaneFeedRepository(
  options: FeedRepositoryOptions = {},
): FeedRepository {
  const now = options.now ?? Date.now;
  return {
    listHome: (input) =>
      Effect.gen(function* () {
        const sort = sortFrom(input.query);
        const timeRange = timeRangeFrom(input.query);
        const cursor = yield* Effect.try({
          try: () => decodeCursor(input.query.cursor, sort, timeRange),
          catch: (error) => (error instanceof FeedRepositoryError ? error : invalidCursor()),
        });
        const asOf = cursor?.asOf ?? Math.floor(now() / 1_000);
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>(
          homeFeedStatement({
            cursor,
            cutoff: cutoffSeconds(timeRange, asOf),
            sort,
            ...(input.viewerUserId === undefined ? {} : { viewerUserId: input.viewerUserId }),
          }),
        );
        const hasMore = result.rows.length > PAGE_SIZE;
        const selected = result.rows.slice(0, PAGE_SIZE);
        const locale = input.query.locale ?? DEFAULT_LOCALE;
        const items = selected.map((row) => feedItemFromRow(row, locale, input.viewerUserId));
        if (items.some((item) => item === null)) return yield* Effect.fail(invalidRow());
        const validItems = items.filter((item) => item !== null);

        const topCommunities = new Map<string, HomeFeedDocument["top_communities"][number]>();
        for (const item of validItems) {
          if (topCommunities.size >= 8) break;
          if (!("community" in item)) continue;
          topCommunities.set(item.community.id, item.community);
        }

        const last = selected[selected.length - 1];
        let nextCursor: string | null = null;
        if (hasMore && last !== undefined) {
          const created = epochSeconds(last.created_at);
          const feedItemId = stringValue(last, "feed_item_id");
          const rank = sort === "new" ? null : finiteNumber(last.rank_score);
          if (created === null || feedItemId === null || (sort !== "new" && rank === null)) {
            return yield* Effect.fail(invalidRow());
          }
          nextCursor = encodeCursor({
            version: 1,
            sort,
            timeRange,
            asOf,
            rank,
            created,
            feedItemId,
          });
        }

        return {
          items: validItems,
          top_communities: [...topCommunities.values()],
          next_cursor: nextCursor,
        };
      }),
  };
}

export function makeControlPlaneFeedStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: FeedRepositoryOptions = {},
): FeedStore["Service"] {
  const repository = makeControlPlaneFeedRepository(options);
  return {
    listHome: (input) => Effect.provide(runtime)(repository.listHome(input)),
  };
}
