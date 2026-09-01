import {
  BadRequest,
  InternalError,
  NotFound,
  type PublicPostRouteResultV1,
  type PublicPostSitemapPageV1,
} from "@pirate/contracts";
import { Effect } from "effect";
import type { ContentStoreService, LocalizedPostDocument } from "../../ports.ts";
import { hasDescriptivePostSlugPolicy, isLogicalPostSlug } from "../../post-slug.ts";

export type PublicPostLiveRecord = Readonly<{
  readonly alias: Readonly<{ readonly slug: string; readonly postId: string }>;
  readonly post: Readonly<{
    readonly postId: string;
    readonly communityId: string;
    readonly status:
      | "draft"
      | "processing"
      | "published"
      | "failed"
      | "hidden"
      | "removed"
      | "deleted";
    readonly postType: string;
    readonly visibility: "public" | "members_only";
    readonly contentRating: "general" | "adult_18" | null;
  }>;
  readonly community: Readonly<{
    readonly communityId: string;
    readonly status: "active" | "hidden" | "archived";
  }>;
  readonly viewer: Readonly<{
    readonly userId: string | undefined;
    readonly isMember: boolean;
    readonly ratingViewAllowed: boolean;
    readonly canRead: boolean;
  }>;
  readonly canonicalPath: string | null;
}>;

export interface PublicPostRouteStoreService {
  readonly getBySlug: (input: {
    readonly slug: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<PublicPostLiveRecord | null, unknown>;
  readonly getCanonicalRouteByPostId: (input: {
    readonly postId: string;
    readonly viewerUserId?: string;
  }) => Effect.Effect<PublicPostLiveRecord | null, unknown>;
  readonly listSitemap: (input: {
    readonly cursor?: string;
    readonly limit: number;
  }) => Effect.Effect<PublicPostSitemapPageV1, unknown>;
}

export type PublicPostRouteServices = Readonly<{
  readonly publicPostRouteStore: PublicPostRouteStoreService;
  readonly contentStore: Pick<ContentStoreService, "getPost">;
}>;

const ANONYMOUS_VIEWER_ID = "public-post-anonymous";
const VALID_ID = /^\S(?:.*\S)?$/u;

const storeFailure = (error: unknown): BadRequest | InternalError => {
  const reason =
    typeof error === "object" && error !== null && "reason" in error
      ? (error as { readonly reason?: unknown }).reason
      : undefined;
  return reason === "invalid-input" || reason === "invalid-cursor"
    ? new BadRequest({ message: "Invalid public post route request" })
    : new InternalError({ message: "Public post route lookup failed" });
};

const notFound = (): NotFound => new NotFound({ message: "Post not found" });

const ageLocked = (): PublicPostRouteResultV1 => ({
  kind: "age_locked",
  locked: {
    kind: "age_locked",
    content_rating: "adult_18",
    next_action: { kind: "verify_minimum_age", minimum_age: 18 },
  },
});

const routeFor = (canonicalPath: string) => ({
  canonical_path: canonicalPath,
  activity_paths: {
    study: `${canonicalPath}/study`,
    karaoke: `${canonicalPath}/karaoke`,
    karaoke_leaderboard: `${canonicalPath}/karaoke/leaderboard`,
  },
});

const contentResult = (
  live: PublicPostLiveRecord,
  projected: Exclude<LocalizedPostDocument, { readonly kind: "age_locked" }>,
): PublicPostRouteResultV1 => {
  const route = live.canonicalPath === null ? null : routeFor(live.canonicalPath);
  const { canonical_path: _guardedCanonicalPath, ...withoutCanonicalPath } = projected;
  const content =
    route === null
      ? withoutCanonicalPath
      : { ...withoutCanonicalPath, canonical_path: route.canonical_path };
  return { kind: "content", post_id: live.post.postId, content, route };
};

const projectLiveRecord = (
  live: PublicPostLiveRecord,
  locale: string | undefined,
  contentStore: Pick<ContentStoreService, "getPost">,
): Effect.Effect<PublicPostRouteResultV1, InternalError | NotFound> =>
  Effect.gen(function* () {
    if (
      live.alias.postId !== live.post.postId ||
      live.community.communityId !== live.post.communityId
    ) {
      return yield* new InternalError({ message: "Public post route lookup failed" });
    }
    if (live.post.status !== "published" || live.community.status !== "active") {
      return yield* notFound();
    }
    if (live.post.contentRating === null || !hasDescriptivePostSlugPolicy(live.post.postType)) {
      return yield* notFound();
    }
    if (live.post.visibility === "members_only" && !live.viewer.isMember) {
      return yield* notFound();
    }
    if (live.post.contentRating === "adult_18" && !live.viewer.ratingViewAllowed) {
      return ageLocked();
    }
    if (!live.viewer.canRead) return yield* notFound();

    const projected = yield* contentStore
      .getPost({
        communityId: live.post.communityId,
        postId: live.post.postId,
        viewerUserId: live.viewer.userId ?? ANONYMOUS_VIEWER_ID,
        ...(locale === undefined ? {} : { locale }),
      })
      .pipe(
        Effect.mapError(() => new InternalError({ message: "Public post route lookup failed" })),
      );
    if (projected === null) return yield* notFound();
    if (!("post" in projected)) return ageLocked();
    if (projected.post.id !== live.post.postId) {
      return yield* new InternalError({ message: "Public post route lookup failed" });
    }
    return contentResult(live, projected);
  });

export const getPublicPostBySlug = Effect.fn("getPublicPostBySlug")(function* (
  input: Readonly<{
    readonly slug: string;
    readonly locale?: string;
    readonly viewerUserId?: string;
  }>,
  services: PublicPostRouteServices,
): Effect.fn.Return<PublicPostRouteResultV1, BadRequest | InternalError | NotFound> {
  if (!isLogicalPostSlug(input.slug)) {
    return yield* new BadRequest({ message: "Invalid public post slug" });
  }
  const live = yield* services.publicPostRouteStore
    .getBySlug({
      slug: input.slug,
      ...(input.viewerUserId === undefined ? {} : { viewerUserId: input.viewerUserId }),
    })
    .pipe(Effect.mapError(storeFailure));
  if (live === null) return yield* notFound();
  return yield* projectLiveRecord(live, input.locale, services.contentStore);
});

export const getPublicPostCanonicalRouteById = Effect.fn("getPublicPostCanonicalRouteById")(
  function* (
    input: Readonly<{
      readonly postId: string;
      readonly locale?: string;
      readonly viewerUserId?: string;
    }>,
    services: PublicPostRouteServices,
  ): Effect.fn.Return<PublicPostRouteResultV1, BadRequest | InternalError | NotFound> {
    if (
      !VALID_ID.test(input.postId) ||
      input.postId.length > 512 ||
      input.postId.includes("\u0000")
    ) {
      return yield* new BadRequest({ message: "Invalid post identifier" });
    }
    const live = yield* services.publicPostRouteStore
      .getCanonicalRouteByPostId({
        postId: input.postId,
        ...(input.viewerUserId === undefined ? {} : { viewerUserId: input.viewerUserId }),
      })
      .pipe(Effect.mapError(storeFailure));
    if (live === null) return yield* notFound();
    return yield* projectLiveRecord(live, input.locale, services.contentStore);
  },
);

export const getPublicPostSitemap = Effect.fn("getPublicPostSitemap")(function* (
  input: Readonly<{ readonly cursor?: string; readonly limit?: string }>,
  services: Pick<PublicPostRouteServices, "publicPostRouteStore">,
): Effect.fn.Return<PublicPostSitemapPageV1, BadRequest | InternalError> {
  const limit = input.limit === undefined ? 1_000 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    return yield* new BadRequest({ message: "Invalid sitemap limit" });
  }
  return yield* services.publicPostRouteStore
    .listSitemap({
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit,
    })
    .pipe(Effect.mapError(storeFailure));
});
