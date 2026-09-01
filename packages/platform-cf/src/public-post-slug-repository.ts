import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  isLogicalPostSlug,
  POST_SLUG_POLICY_VERSION,
  type PostSlugCandidate,
  postSlugCanonicalPath,
  postSlugCollisionCandidate,
  postSlugOpaqueToken,
} from "@pirate/application/post-slug";
import { Data, Effect, type Layer } from "effect";

export type PostSlugAliasRecord = Readonly<{
  slug: string;
  postId: string;
  slugPolicyVersion: typeof POST_SLUG_POLICY_VERSION;
  createdAt: string;
}>;

export class PublicPostSlugRepositoryError extends Data.TaggedError(
  "PublicPostSlugRepositoryError",
)<{
  readonly reason: "invalid-input" | "invalid-row" | "invalid-cursor" | "collision-exhausted";
}> {}

type Row = Readonly<Record<string, unknown>>;
type EnsureOptions = Readonly<{
  nextOpaqueToken?: () => string;
  maxAttempts?: number;
}>;

type PublicPostStatus =
  | "draft"
  | "processing"
  | "published"
  | "failed"
  | "hidden"
  | "removed"
  | "deleted";
type PublicPostVisibility = "public" | "members_only";
type PublicPostContentRating = "general" | "adult_18" | null;
type PublicCommunityStatus = "active" | "hidden" | "archived";

/**
 * The persistence boundary deliberately contains live guard facts only. It
 * does not contain title/body, account identity, moderation evidence, or any
 * other alias snapshot. The application layer can use this result to select
 * the existing guarded content projection.
 */
export type PublicPostSlugLiveRecord = Readonly<{
  readonly alias: PostSlugAliasRecord;
  readonly post: Readonly<{
    readonly postId: string;
    readonly communityId: string;
    readonly status: PublicPostStatus;
    readonly postType: string;
    readonly visibility: PublicPostVisibility;
    readonly contentRating: PublicPostContentRating;
  }>;
  readonly community: Readonly<{
    readonly communityId: string;
    readonly status: PublicCommunityStatus;
  }>;
  readonly viewer: Readonly<{
    readonly userId: string | undefined;
    readonly isMember: boolean;
    readonly ratingViewAllowed: boolean;
    readonly canRead: boolean;
  }>;
  /** Null for every guarded result; only public/general/live rows get a path. */
  readonly canonicalPath: string | null;
}>;

export type PublicPostSitemapPage = Readonly<{
  readonly object: "public_post_sitemap_page";
  readonly items: ReadonlyArray<Readonly<{ readonly canonical_path: string }>>;
  readonly next_cursor: string | null;
}>;

export interface PublicPostSlugRepository {
  readonly getBySlug: (input: {
    readonly slug: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<
    PublicPostSlugLiveRecord | null,
    PublicPostSlugRepositoryError | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly getCanonicalRouteByPostId: (input: {
    readonly postId: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<
    PublicPostSlugLiveRecord | null,
    PublicPostSlugRepositoryError | ControlPlaneError,
    ControlPlaneDb
  >;
  readonly listSitemap: (input: {
    readonly cursor?: string;
    readonly limit: number;
  }) => Effect.Effect<
    PublicPostSitemapPage,
    PublicPostSlugRepositoryError | ControlPlaneError,
    ControlPlaneDb
  >;
}

export type PublicPostSlugStore = Readonly<{
  readonly getBySlug: (input: {
    readonly slug: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<
    PublicPostSlugLiveRecord | null,
    PublicPostSlugRepositoryError | ControlPlaneError
  >;
  readonly getCanonicalRouteByPostId: (input: {
    readonly postId: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<
    PublicPostSlugLiveRecord | null,
    PublicPostSlugRepositoryError | ControlPlaneError
  >;
  readonly listSitemap: (input: {
    readonly cursor?: string;
    readonly limit: number;
  }) => Effect.Effect<PublicPostSitemapPage, PublicPostSlugRepositoryError | ControlPlaneError>;
}>;

const OPAQUE_TOKEN = /^[0-9abcdefghjkmnpqrstvwxyz]{10}$/u;

const SITEMAP_PAGE_SIZE_MAX = 1_000;
const SITEMAP_CURSOR_PREFIX = "pps1.";
const POST_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "processing",
  "published",
  "failed",
  "hidden",
  "removed",
  "deleted",
]);
const POST_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "video",
  "link",
  "song",
  "crosspost",
  "file",
]);
const COMMUNITY_STATUSES: ReadonlySet<string> = new Set(["active", "hidden", "archived"]);

const repositoryError = (
  reason: PublicPostSlugRepositoryError["reason"],
): PublicPostSlugRepositoryError => new PublicPostSlugRepositoryError({ reason });

const invalidCursor = (): PublicPostSlugRepositoryError => repositoryError("invalid-cursor");

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !value.includes("\u0000");

const optionalViewerId = (value: unknown): value is string | undefined =>
  value === undefined || validId(value);

const stringValue = (row: Row, ...keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") return value;
  }
  return null;
};

const booleanValue = (row: Row, ...keys: readonly string[]): boolean | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "boolean") return value;
  }
  return null;
};

const isoTimestamp = (value: unknown): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const aliasRecord = (row: Row): PostSlugAliasRecord | null => {
  const slug = row.slug;
  const postId = row.post_id;
  const policy = row.slug_policy_version;
  const createdAt = isoTimestamp(row.created_at);
  if (
    typeof slug !== "string" ||
    !isLogicalPostSlug(slug) ||
    typeof postId !== "string" ||
    postId.length === 0 ||
    postId.trim() !== postId ||
    policy !== POST_SLUG_POLICY_VERSION ||
    createdAt === null
  ) {
    return null;
  }
  return { slug, postId, slugPolicyVersion: policy, createdAt };
};

const aliasRecordFromLookupRow = (row: Row): PostSlugAliasRecord | null =>
  aliasRecord({
    slug: row.alias_slug ?? row.slug,
    post_id: row.alias_post_id ?? row.post_id,
    slug_policy_version: row.alias_slug_policy_version ?? row.slug_policy_version,
    created_at: row.alias_created_at ?? row.created_at,
  });

const liveRecordFromRow = (
  row: Row,
  viewerUserId: string | undefined,
): PublicPostSlugLiveRecord | null => {
  const alias = aliasRecordFromLookupRow(row);
  const postId = stringValue(row, "post_id");
  const communityId = stringValue(row, "community_id");
  const postType = stringValue(row, "post_type");
  const status = stringValue(row, "post_status", "status");
  const visibility = stringValue(row, "post_visibility", "visibility");
  const communityStatus = stringValue(row, "community_status");
  const contentRatingValue = row.content_rating;
  const contentRating =
    contentRatingValue === null
      ? null
      : typeof contentRatingValue === "string"
        ? contentRatingValue
        : undefined;
  const isMember = booleanValue(row, "viewer_is_member", "is_member");
  const ratingViewAllowed = booleanValue(row, "rating_view_allowed");
  if (
    alias === null ||
    postId === null ||
    communityId === null ||
    !validId(postId) ||
    !validId(communityId) ||
    alias.postId !== postId ||
    postType === null ||
    !POST_TYPES.has(postType) ||
    status === null ||
    !POST_STATUSES.has(status) ||
    visibility === null ||
    (visibility !== "public" && visibility !== "members_only") ||
    communityStatus === null ||
    !COMMUNITY_STATUSES.has(communityStatus) ||
    !Object.hasOwn(row, "content_rating") ||
    contentRating === undefined ||
    (contentRating !== null && contentRating !== "general" && contentRating !== "adult_18") ||
    isMember === null ||
    ratingViewAllowed === null
  ) {
    return null;
  }

  const normalizedStatus = status as PublicPostStatus;
  const normalizedVisibility = visibility as PublicPostVisibility;
  const normalizedCommunityStatus = communityStatus as PublicCommunityStatus;
  const normalizedRating = contentRating as PublicPostContentRating;
  const canRead =
    normalizedStatus === "published" &&
    normalizedCommunityStatus === "active" &&
    ratingViewAllowed &&
    (normalizedVisibility === "public" || isMember);
  const routeEligible =
    normalizedStatus === "published" &&
    normalizedCommunityStatus === "active" &&
    normalizedVisibility === "public" &&
    normalizedRating === "general";
  const canonicalPath = routeEligible ? postSlugCanonicalPath(alias.slug) : null;
  if (routeEligible && canonicalPath === null) return null;

  return {
    alias,
    post: {
      postId,
      communityId,
      status: normalizedStatus,
      postType,
      visibility: normalizedVisibility,
      contentRating: normalizedRating,
    },
    community: {
      communityId,
      status: normalizedCommunityStatus,
    },
    viewer: {
      userId: viewerUserId,
      isMember,
      ratingViewAllowed,
      canRead,
    },
    canonicalPath,
  };
};

const baseLookupSelect = `SELECT a.slug AS alias_slug,
                a.post_id AS alias_post_id,
                a.slug_policy_version AS alias_slug_policy_version,
                a.created_at AS alias_created_at,
                p.post_id,
                p.community_id,
                p.post_type,
                p.status AS post_status,
                p.visibility AS post_visibility,
                p.content_rating,
                c.status AS community_status,
                ($2::text IS NOT NULL AND EXISTS (
                       SELECT 1
                         FROM community_memberships AS viewer_membership
                        WHERE viewer_membership.community_id = p.community_id
                          AND viewer_membership.user_id = $2
                          AND viewer_membership.status = 'member'
                     )) AS viewer_is_member,
                (p.content_rating IS NULL
                  OR can_account_view_content_rating_v1($2, p.content_rating)) AS rating_view_allowed
           FROM post_slug_aliases AS a
           JOIN posts AS p ON p.post_id = a.post_id
           JOIN communities AS c ON c.community_id = p.community_id`;

const lookupBySlugStatement = (slug: string, viewerUserId: string | undefined) => ({
  label: "public-post-slug.lookup-by-slug",
  text: `${baseLookupSelect}
          WHERE a.slug = $1`,
  values: [slug, viewerUserId ?? null],
  readonly: true,
});

const lookupCanonicalRouteByPostIdStatement = (
  postId: string,
  viewerUserId: string | undefined,
) => ({
  label: "public-post-slug.lookup-canonical-route-by-post-id",
  text: `${baseLookupSelect}
          WHERE a.post_id = $1`,
  values: [postId, viewerUserId ?? null],
  readonly: true,
});

type SitemapCursor = Readonly<{
  readonly version: 1;
  readonly createdAt: string;
  readonly postId: string;
}>;

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

const encodeSitemapCursor = (cursor: SitemapCursor): string =>
  `${SITEMAP_CURSOR_PREFIX}${base64UrlEncode(
    JSON.stringify({ v: cursor.version, t: cursor.createdAt, p: cursor.postId }),
  )}`;

const decodeSitemapCursor = (value: string | undefined): SitemapCursor | null => {
  if (value === undefined) return null;
  if (value.length > 1_024 || !value.startsWith(SITEMAP_CURSOR_PREFIX)) throw invalidCursor();
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(value.slice(SITEMAP_CURSOR_PREFIX.length)));
    if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
    const record = parsed as Record<string, unknown>;
    const createdAt = record.t;
    const postId = record.p;
    if (
      record.v !== 1 ||
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !validId(postId)
    ) {
      throw invalidCursor();
    }
    return {
      version: 1,
      createdAt: new Date(createdAt).toISOString(),
      postId,
    };
  } catch (error) {
    if (error instanceof PublicPostSlugRepositoryError) throw error;
    throw invalidCursor();
  }
};

const sitemapStatement = (cursor: SitemapCursor | null, limit: number) => ({
  label: "public-post-slug.sitemap",
  text: `SELECT a.slug AS alias_slug,
                a.post_id AS alias_post_id,
                a.slug_policy_version AS alias_slug_policy_version,
                a.created_at AS alias_created_at,
                p.status AS post_status,
                p.visibility AS post_visibility,
                p.content_rating,
                c.status AS community_status
           FROM post_slug_aliases AS a
           JOIN posts AS p ON p.post_id = a.post_id
           JOIN communities AS c ON c.community_id = p.community_id
          WHERE c.status = 'active'
            AND p.status = 'published'
            AND p.visibility = 'public'
            AND p.content_rating = 'general'
            AND ($1::timestamptz IS NULL
              OR (a.created_at, a.post_id) > ($1::timestamptz, $2::text))
          ORDER BY a.created_at ASC, a.post_id ASC
          LIMIT $3`,
  values: [cursor?.createdAt ?? null, cursor?.postId ?? null, limit + 1],
  readonly: true,
});

const sitemapAliasFromRow = (
  row: Row,
): Readonly<{ canonical_path: string; createdAt: string; postId: string }> | null => {
  const alias = aliasRecordFromLookupRow(row);
  const postStatus = stringValue(row, "post_status");
  const postVisibility = stringValue(row, "post_visibility");
  const communityStatus = stringValue(row, "community_status");
  const contentRatingValue = row.content_rating;
  const contentRating =
    contentRatingValue === null
      ? null
      : typeof contentRatingValue === "string"
        ? contentRatingValue
        : undefined;
  if (
    alias === null ||
    postStatus !== "published" ||
    postVisibility !== "public" ||
    communityStatus !== "active" ||
    !Object.hasOwn(row, "content_rating") ||
    contentRating === undefined ||
    contentRating !== "general"
  ) {
    return null;
  }
  const canonicalPath = postSlugCanonicalPath(alias.slug);
  return canonicalPath === null
    ? null
    : { canonical_path: canonicalPath, createdAt: alias.createdAt, postId: alias.postId };
};

const queryOneLookup = (
  transaction: ControlPlaneTransaction,
  statement: ReturnType<typeof lookupBySlugStatement>,
  viewerUserId: string | undefined,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>(statement);
    if (result.rows.length > 1) return yield* Effect.fail(repositoryError("invalid-row"));
    const row = result.rows[0];
    if (row === undefined) return null;
    const record = liveRecordFromRow(row, viewerUserId);
    return record === null ? yield* Effect.fail(repositoryError("invalid-row")) : record;
  });

export const lookupPublicPostBySlugInTransaction = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ readonly slug: string; readonly viewerUserId?: string }>,
): Effect.Effect<
  PublicPostSlugLiveRecord | null,
  PublicPostSlugRepositoryError | ControlPlaneError
> =>
  Effect.gen(function* () {
    if (!isLogicalPostSlug(input.slug) || !optionalViewerId(input.viewerUserId)) {
      return yield* Effect.fail(repositoryError("invalid-input"));
    }
    return yield* queryOneLookup(
      transaction,
      lookupBySlugStatement(input.slug, input.viewerUserId),
      input.viewerUserId,
    );
  });

export const lookupPublicPostCanonicalRouteByPostIdInTransaction = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ readonly postId: string; readonly viewerUserId?: string }>,
): Effect.Effect<
  PublicPostSlugLiveRecord | null,
  PublicPostSlugRepositoryError | ControlPlaneError
> =>
  Effect.gen(function* () {
    if (!validId(input.postId) || !optionalViewerId(input.viewerUserId)) {
      return yield* Effect.fail(repositoryError("invalid-input"));
    }
    return yield* queryOneLookup(
      transaction,
      lookupCanonicalRouteByPostIdStatement(input.postId, input.viewerUserId),
      input.viewerUserId,
    );
  });

export const listPublicPostSitemapInTransaction = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ readonly cursor?: string; readonly limit: number }>,
): Effect.Effect<PublicPostSitemapPage, PublicPostSlugRepositoryError | ControlPlaneError> =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > SITEMAP_PAGE_SIZE_MAX
    ) {
      return yield* Effect.fail(repositoryError("invalid-input"));
    }
    const cursor = yield* Effect.try({
      try: () => decodeSitemapCursor(input.cursor),
      catch: (error) => (error instanceof PublicPostSlugRepositoryError ? error : invalidCursor()),
    });
    const result = yield* transaction.execute<Row>(sitemapStatement(cursor, input.limit));
    const hasMore = result.rows.length > input.limit;
    const selected = result.rows.slice(0, input.limit);
    const items = selected.map((row) => sitemapAliasFromRow(row));
    if (items.some((item) => item === null))
      return yield* Effect.fail(repositoryError("invalid-row"));
    const validItems = items.filter((item) => item !== null);
    const last = validItems[validItems.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeSitemapCursor({ version: 1, createdAt: last.createdAt, postId: last.postId })
        : null;
    return {
      object: "public_post_sitemap_page",
      items: validItems.map(({ canonical_path }) => ({ canonical_path })),
      next_cursor: nextCursor,
    };
  });

export function makeControlPlanePublicPostSlugRepository(): PublicPostSlugRepository {
  return {
    getBySlug: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          lookupPublicPostBySlugInTransaction(transaction, input),
        );
      }),
    getCanonicalRouteByPostId: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          lookupPublicPostCanonicalRouteByPostIdInTransaction(transaction, input),
        );
      }),
    listSitemap: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          listPublicPostSitemapInTransaction(transaction, input),
        );
      }),
  };
}

export function makeControlPlanePublicPostSlugStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): PublicPostSlugStore {
  const repository = makeControlPlanePublicPostSlugRepository();
  return {
    getBySlug: (input) => Effect.provide(runtime)(repository.getBySlug(input)),
    getCanonicalRouteByPostId: (input) =>
      Effect.provide(runtime)(repository.getCanonicalRouteByPostId(input)),
    listSitemap: (input) => Effect.provide(runtime)(repository.listSitemap(input)),
  };
}

const lookupByPostId = (transaction: ControlPlaneTransaction, postId: string) =>
  transaction.execute<Row>({
    label: "public-post-slug.lookup-by-post-id",
    text: `SELECT slug, post_id, slug_policy_version, created_at
             FROM post_slug_aliases
            WHERE post_id = $1`,
    values: [postId],
    readonly: true,
  });

const insertAlias = (transaction: ControlPlaneTransaction, postId: string, slug: string) =>
  transaction.execute<Row>({
    label: "public-post-slug.insert",
    text: `INSERT INTO post_slug_aliases (slug, post_id, slug_policy_version)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
          RETURNING slug, post_id, slug_policy_version, created_at`,
    values: [slug, postId, POST_SLUG_POLICY_VERSION],
    readonly: false,
  });

const secureOpaqueToken = (): string =>
  postSlugOpaqueToken(crypto.getRandomValues(new Uint8Array(10)));

const nextSlug = (
  candidate: PostSlugCandidate,
  attempt: number,
  nextOpaqueToken: () => string,
): string => {
  if (candidate.kind === "descriptive") {
    return postSlugCollisionCandidate(candidate.slug, attempt);
  }
  const token = nextOpaqueToken();
  if (!OPAQUE_TOKEN.test(token)) throw repositoryError("invalid-input");
  return `${candidate.prefix}-${token}`;
};

export const ensurePostSlugAliasInTransaction = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    postId: string;
    candidate: PostSlugCandidate;
  }>,
  options: EnsureOptions = {},
): Effect.Effect<PostSlugAliasRecord, PublicPostSlugRepositoryError | ControlPlaneError> =>
  Effect.gen(function* () {
    if (
      input.postId.length === 0 ||
      input.postId.trim() !== input.postId ||
      (input.candidate.kind === "descriptive" && !isLogicalPostSlug(input.candidate.slug))
    ) {
      return yield* repositoryError("invalid-input");
    }

    const existing = yield* lookupByPostId(transaction, input.postId);
    if (existing.rows.length > 1) return yield* repositoryError("invalid-row");
    if (existing.rows.length === 1) {
      const decoded = aliasRecord(existing.rows[0] as Row);
      return decoded === null ? yield* repositoryError("invalid-row") : decoded;
    }

    const maxAttempts = options.maxAttempts ?? 10_000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      return yield* repositoryError("invalid-input");
    }
    const nextOpaqueToken = options.nextOpaqueToken ?? secureOpaqueToken;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const slug = yield* Effect.try({
        try: () => nextSlug(input.candidate, attempt, nextOpaqueToken),
        catch: () => repositoryError("invalid-input"),
      });
      const inserted = yield* insertAlias(transaction, input.postId, slug);
      if (inserted.rows.length > 1) return yield* repositoryError("invalid-row");
      if (inserted.rows.length === 1) {
        const decoded = aliasRecord(inserted.rows[0] as Row);
        return decoded === null ? yield* repositoryError("invalid-row") : decoded;
      }

      const winner = yield* lookupByPostId(transaction, input.postId);
      if (winner.rows.length > 1) return yield* repositoryError("invalid-row");
      if (winner.rows.length === 1) {
        const decoded = aliasRecord(winner.rows[0] as Row);
        return decoded === null ? yield* repositoryError("invalid-row") : decoded;
      }
    }

    return yield* repositoryError("collision-exhausted");
  });
