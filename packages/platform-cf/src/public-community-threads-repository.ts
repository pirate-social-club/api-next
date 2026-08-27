import {
  ControlPlaneDb,
  type ControlPlaneError,
  type PublicCommunityThreadsDocument,
  PublicCommunityThreadsRepositoryError,
  type PublicCommunityThreadsRepositoryFailure,
  type PublicCommunityThreadsStore,
  type PublicCommunityThreadsStoreService,
} from "@pirate/application";
import { GetPublicCommunityThreads } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";
import { publicPersonaFromSql } from "./public-persona-projection";

const PAGE_SIZE = 20;
const DEFAULT_LOCALE = "en";
const OPERATION = "list-public-community-threads" as const;

type Row = Readonly<Record<string, unknown>>;

type CommunityRow = Readonly<{
  readonly community_id: unknown;
  readonly status: unknown;
  readonly display_name: unknown;
  readonly route_slug: unknown;
  readonly membership_mode: unknown;
  readonly human_verification_lane: unknown;
  readonly created_at: unknown;
  readonly member_count: unknown;
  readonly follower_count: unknown;
}>;

type ThreadsCursor = Readonly<{
  readonly version: 1;
  readonly communityId: string;
  readonly surface: "threads";
  readonly sort: "new";
  readonly asOf: number;
  readonly created: number;
  readonly postId: string;
}>;

export interface PublicCommunityThreadsRepositoryOptions {
  /** Milliseconds since Unix epoch; injected for deterministic pagination tests. */
  readonly now?: () => number;
}

export interface PublicCommunityThreadsRepository {
  readonly listPublicCommunityThreads: (
    input: Parameters<PublicCommunityThreadsStoreService["listPublicCommunityThreads"]>[0],
  ) => Effect.Effect<
    PublicCommunityThreadsDocument | null,
    PublicCommunityThreadsRepositoryFailure,
    ControlPlaneDb
  >;
}

const invalidRow = () =>
  new PublicCommunityThreadsRepositoryError({ operation: OPERATION, reason: "invalid-row" });

const invalidCursor = () =>
  new PublicCommunityThreadsRepositoryError({ operation: OPERATION, reason: "invalid-cursor" });

const invalidCommunityRef = () =>
  new PublicCommunityThreadsRepositoryError({
    operation: OPERATION,
    reason: "invalid-community-ref",
  });

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  !value.includes("\u0000");

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;
};

const nullableStringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  return typeof value === "string" && value === value.trim() ? value : null;
};

const nullableStringFieldIsValid = (row: Row, key: string): boolean => {
  const value = row[key];
  return value === null || (typeof value === "string" && value === value.trim());
};

const countValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

const timestampMillis = (value: unknown): number | null => {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isSafeInteger(millis) ? millis : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = Math.abs(value) >= 100_000_000_000 ? value : value * 1_000;
    return Number.isSafeInteger(millis) ? millis : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

const timestampSeconds = (millis: number): number => Math.floor(millis / 1_000);

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const base64UrlDecode = (value: string): string => {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

const encodeCursor = (cursor: ThreadsCursor): string =>
  `pct1.${base64UrlEncode(
    JSON.stringify({
      v: cursor.version,
      c: cursor.communityId,
      s: cursor.surface,
      o: cursor.sort,
      a: cursor.asOf,
      t: cursor.created,
      p: cursor.postId,
    }),
  )}`;

const finiteSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const decodeCursor = (
  value: string | undefined,
  expectedCommunityId: string,
): ThreadsCursor | null => {
  if (value === undefined) return null;
  if (!value.startsWith("pct1.")) throw invalidCursor();
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(value.slice(5)));
    if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
    const record = parsed as Record<string, unknown>;
    if (
      record.v !== 1 ||
      record.c !== expectedCommunityId ||
      record.s !== "threads" ||
      record.o !== "new" ||
      !finiteSafeInteger(record.a) ||
      !finiteSafeInteger(record.t) ||
      record.t > record.a ||
      !validId(record.p)
    ) {
      throw invalidCursor();
    }
    return {
      version: 1,
      communityId: expectedCommunityId,
      surface: "threads",
      sort: "new",
      asOf: record.a,
      created: record.t,
      postId: record.p,
    };
  } catch (error) {
    if (error instanceof PublicCommunityThreadsRepositoryError) throw error;
    throw invalidCursor();
  }
};

const resolveExactCommunity = {
  label: "public-community-threads.communities.resolve-id",
  text: `SELECT c.community_id,
                c.status,
                c.display_name,
                c.route_slug,
                c.membership_mode,
                c.human_verification_lane,
                c.created_at,
                (SELECT COUNT(*)
                   FROM community_memberships AS member_count
                  WHERE member_count.community_id = c.community_id
                    AND member_count.status = 'member') AS member_count,
                (SELECT COUNT(*)
                   FROM community_follows AS follower_count
                  WHERE follower_count.community_id = c.community_id
                    AND follower_count.status = 'active') AS follower_count
           FROM communities AS c
          WHERE c.community_id = $1`,
  readonly: true,
} as const;

const resolveCommunitySlug = {
  label: "public-community-threads.communities.resolve-slug",
  text: resolveExactCommunity.text.replace(
    "WHERE c.community_id = $1",
    "WHERE c.route_slug = $1 AND c.status = 'active'",
  ),
  readonly: true,
} as const;

const listTextPostsStatement = (input: {
  readonly communityId: string;
  readonly snapshotMillis: number;
  readonly cursor: ThreadsCursor | null;
  readonly viewerUserId?: string;
}) => ({
  label: "public-community-threads.posts.list-text",
  text: `SELECT p.post_id,
                p.community_id,
                public_persona_projection(p.author_persona_id) AS author_persona,
                p.body,
                p.title,
                p.created_at,
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
                    AND comment_count.status = 'published') AS comment_count
           FROM posts AS p
          WHERE p.community_id = $1
            AND p.post_type = 'text'
            AND p.status = 'published'
            AND p.visibility = 'public'
            AND can_account_view_content_rating_v1($6, p.content_rating)
            AND p.created_at <= to_timestamp($2::double precision / 1000)
            AND (
              $3::double precision IS NULL
              OR (p.created_at, p.post_id) <
                 (to_timestamp($3::double precision / 1000), $4::text)
            )
          ORDER BY p.created_at DESC, p.post_id DESC
          LIMIT $5`
    .replace(/\s+/gu, " ")
    .trim(),
  values: [
    input.communityId,
    input.snapshotMillis,
    input.cursor?.created ?? null,
    input.cursor?.postId ?? null,
    PAGE_SIZE + 1,
    input.viewerUserId ?? null,
  ],
  readonly: true,
});

const communityPreviewFromRow = (
  row: CommunityRow,
): Schema.Schema.Type<typeof GetPublicCommunityThreads.response>["community"] | null => {
  const id = typeof row.community_id === "string" ? row.community_id : null;
  const displayName = typeof row.display_name === "string" ? row.display_name : null;
  const routeSlug =
    row.route_slug === null ? null : typeof row.route_slug === "string" ? row.route_slug : null;
  const mode = row.membership_mode;
  const verification = row.human_verification_lane;
  const created = timestampMillis(row.created_at);
  const memberCount = countValue(row.member_count);
  const followerCount = countValue(row.follower_count);
  if (
    id === null ||
    !validId(id) ||
    displayName === null ||
    displayName.trim() !== displayName ||
    (routeSlug === null && row.route_slug !== null) ||
    (routeSlug !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(routeSlug)) ||
    (mode !== "open" && mode !== "request" && mode !== "gated") ||
    (verification !== null && verification !== "very" && verification !== "self") ||
    created === null ||
    memberCount === null ||
    followerCount === null
  ) {
    return null;
  }
  return {
    id,
    object: "community_preview",
    route_slug: routeSlug,
    display_name: displayName,
    membership_mode: mode,
    human_verification_lane: verification,
    member_count: memberCount,
    follower_count: followerCount,
    moderators: [],
    membership_gate_summaries: [],
    rules: [],
    created: timestampSeconds(created),
  };
};

const localizedTextPostFromRow = (
  row: Row,
  locale: string,
  expectedCommunityId: string,
): Schema.Schema.Type<typeof GetPublicCommunityThreads.response>["items"][number] | null => {
  const postId = stringValue(row, "post_id");
  const communityId = stringValue(row, "community_id");
  const authorPersona = publicPersonaFromSql(row.author_persona);
  const body = nullableStringValue(row, "body");
  const title = nullableStringValue(row, "title");
  const created = timestampMillis(row.created_at);
  const upvoteCount = countValue(row.upvote_count);
  const downvoteCount = countValue(row.downvote_count);
  const commentCount = countValue(row.comment_count);
  if (
    postId === null ||
    communityId === null ||
    communityId !== expectedCommunityId ||
    authorPersona === undefined ||
    !nullableStringFieldIsValid(row, "body") ||
    !nullableStringFieldIsValid(row, "title") ||
    created === null ||
    upvoteCount === null ||
    downvoteCount === null ||
    commentCount === null
  ) {
    return null;
  }
  return {
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
      post_type: "text",
      status: "published",
      visibility: "public",
      title,
      body,
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
      created: timestampSeconds(created),
    },
    thread_snapshot: null,
    upvote_count: upvoteCount,
    downvote_count: downvoteCount,
    like_count: 0,
    comment_count: commentCount,
    viewer_vote: null,
    viewer_reaction_kinds: [],
    resolved_locale: locale,
    translation_state: "same_language",
    machine_translated: false,
    source_hash: "",
  };
};

export function makeControlPlanePublicCommunityThreadsRepository(
  options: PublicCommunityThreadsRepositoryOptions = {},
): PublicCommunityThreadsRepository {
  const now = options.now ?? Date.now;
  return {
    listPublicCommunityThreads: (input) =>
      Effect.gen(function* () {
        if (
          !validId(input.communityRef) ||
          (input.slugCandidate !== null && !validId(input.slugCandidate))
        ) {
          return yield* Effect.fail(invalidCommunityRef());
        }
        const db = yield* ControlPlaneDb;
        const exactResult = yield* db.execute<CommunityRow>({
          ...resolveExactCommunity,
          values: [input.communityRef],
        });
        if (exactResult.rows.length > 1) return yield* Effect.fail(invalidRow());

        let community = exactResult.rows[0];
        if (community !== undefined && community.status !== "active") return null;
        if (community === undefined) {
          if (input.slugCandidate === null) return yield* Effect.fail(invalidCommunityRef());
          const slugResult = yield* db.execute<CommunityRow>({
            ...resolveCommunitySlug,
            values: [input.slugCandidate],
          });
          if (slugResult.rows.length > 1) return yield* Effect.fail(invalidRow());
          community = slugResult.rows[0];
        }
        if (community === undefined || community.status !== "active") return null;

        const preview = communityPreviewFromRow(community);
        if (preview === null) return yield* Effect.fail(invalidRow());
        const cursor = yield* Effect.try({
          try: () => decodeCursor(input.query.cursor, preview.id),
          catch: (error) =>
            error instanceof PublicCommunityThreadsRepositoryError ? error : invalidCursor(),
        });
        const snapshotMillis = cursor?.asOf ?? Math.floor(now());
        if (!Number.isSafeInteger(snapshotMillis) || snapshotMillis <= 0) {
          return yield* Effect.fail(invalidCursor());
        }

        const posts = yield* db.execute<Row>(
          listTextPostsStatement({
            communityId: preview.id,
            snapshotMillis,
            cursor,
            ...(input.viewerUserId === undefined ? {} : { viewerUserId: input.viewerUserId }),
          }),
        );
        const selected = posts.rows.slice(0, PAGE_SIZE);
        const items = selected.map((row) =>
          localizedTextPostFromRow(row, input.query.locale ?? DEFAULT_LOCALE, preview.id),
        );
        if (items.some((item) => item === null)) return yield* Effect.fail(invalidRow());
        const validItems = items.filter((item) => item !== null);
        const hasMore = posts.rows.length > PAGE_SIZE;
        const last = selected[selected.length - 1];
        let nextCursor: string | null = null;
        if (hasMore && last !== undefined) {
          const created = timestampMillis(last.created_at);
          const postId = stringValue(last, "post_id");
          if (created === null || postId === null || created > snapshotMillis) {
            return yield* Effect.fail(invalidRow());
          }
          nextCursor = encodeCursor({
            version: 1,
            communityId: preview.id,
            surface: "threads",
            sort: "new",
            asOf: snapshotMillis,
            created,
            postId,
          });
        }

        const document = { community: preview, items: validItems, next_cursor: nextCursor };
        try {
          return Schema.decodeUnknownSync(GetPublicCommunityThreads.response)(document);
        } catch {
          return yield* Effect.fail(invalidRow());
        }
      }),
  };
}

export function makeControlPlanePublicCommunityThreadsStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: PublicCommunityThreadsRepositoryOptions = {},
): PublicCommunityThreadsStore["Service"] {
  const repository = makeControlPlanePublicCommunityThreadsRepository(options);
  return {
    listPublicCommunityThreads: (input) =>
      Effect.provide(runtime)(repository.listPublicCommunityThreads(input)),
  };
}
