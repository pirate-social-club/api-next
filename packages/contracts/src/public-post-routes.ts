import { Schema } from "effect";
import { AgeLockedResourceV1 } from "./age-access.ts";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, NotFound, RateLimited } from "./errors.ts";
import { LocaleQuery, LocalizedPost } from "./v1.ts";

const PUBLIC_POST_PATH_PREFIX = "/posts/";

/**
 * A logical post slug is already decoded and NFKC-normalized. Wire-level
 * percent decoding and canonicalization remain owned by Solid; this schema
 * only protects the API exact-lookup boundary.
 */
export const PublicPostLogicalSlugV1 = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.length === 0 || value.trim().length === 0) {
      return "Expected a nonblank logical post slug";
    }
    if (value.length > 80) return "Expected a logical post slug of at most 80 UTF-16 units";
    if (value !== value.normalize("NFKC")) {
      return "Expected an already NFKC-normalized logical post slug";
    }
    if (value.includes("%") || value.includes("/") || value.includes("\\")) {
      return "Logical post slugs cannot contain percent, slash, or backslash characters";
    }
    if (value === "." || value === "..") return "Dot path segments are not logical post slugs";
    return undefined;
  }),
);
export type PublicPostLogicalSlugV1 = Schema.Schema.Type<typeof PublicPostLogicalSlugV1>;

/** Canonical detail route returned by the API for Solid, feeds, and redirects. */
export const PublicPostCanonicalPathV1 = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!value.startsWith(PUBLIC_POST_PATH_PREFIX)) {
      return "Expected a canonical public post path";
    }
    const slug = value.slice(PUBLIC_POST_PATH_PREFIX.length);
    if (slug.length === 0 || slug.includes("/") || slug.includes("\\")) {
      return "Canonical public post paths must contain exactly one slug segment";
    }
    if (value.includes("?") || value.includes("#")) {
      return "Canonical public post paths cannot contain query or fragment data";
    }
    return undefined;
  }),
);
export type PublicPostCanonicalPathV1 = Schema.Schema.Type<typeof PublicPostCanonicalPathV1>;

const PublicPostActivityPathV1 = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!value.startsWith(PUBLIC_POST_PATH_PREFIX) || value.includes("?") || value.includes("#")) {
      return "Expected a canonical public post activity path";
    }
    return value.slice(PUBLIC_POST_PATH_PREFIX.length).length === 0
      ? "Expected a nonempty public post activity path"
      : undefined;
  }),
);

export const PublicPostActivityPathsV1 = Schema.Struct({
  study: PublicPostActivityPathV1,
  karaoke: PublicPostActivityPathV1,
  karaoke_leaderboard: PublicPostActivityPathV1,
});
export type PublicPostActivityPathsV1 = Schema.Schema.Type<typeof PublicPostActivityPathsV1>;

export const PublicPostRouteV1 = Schema.Struct({
  canonical_path: PublicPostCanonicalPathV1,
  activity_paths: PublicPostActivityPathsV1,
}).check(
  Schema.makeFilter((route) =>
    route.activity_paths.study === `${route.canonical_path}/study` &&
    route.activity_paths.karaoke === `${route.canonical_path}/karaoke` &&
    route.activity_paths.karaoke_leaderboard === `${route.canonical_path}/karaoke/leaderboard`
      ? undefined
      : "Public post activity paths must derive from the canonical detail path",
  ),
);
export type PublicPostRouteV1 = Schema.Schema.Type<typeof PublicPostRouteV1>;

export const PublicPostBySlugQueryV1 = Schema.Struct({
  slug: PublicPostLogicalSlugV1,
  ...LocaleQuery.fields,
});
export type PublicPostBySlugQueryV1 = Schema.Schema.Type<typeof PublicPostBySlugQueryV1>;

export const PublicPostCanonicalRouteByIdPathV1 = Schema.Struct({
  postId: Schema.String,
});
export type PublicPostCanonicalRouteByIdPathV1 = Schema.Schema.Type<
  typeof PublicPostCanonicalRouteByIdPathV1
>;

const PublicPostSitemapLimitV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    /^(?:[1-9]|[1-9][0-9]{1,2}|1000)$/u.test(value)
      ? undefined
      : "Expected a sitemap limit from 1 through 1000",
  ),
);

export const PublicPostSitemapQueryV1 = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(PublicPostSitemapLimitV1),
});
export type PublicPostSitemapQueryV1 = Schema.Schema.Type<typeof PublicPostSitemapQueryV1>;

export const PublicPostRouteResultV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("content"),
    post_id: Schema.String,
    content: LocalizedPost,
    route: Schema.NullOr(PublicPostRouteV1),
  }).check(
    Schema.makeFilter((result) =>
      result.post_id === result.content.post.id
        ? undefined
        : "Public post route identity must match the projected post identity",
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("age_locked"),
    locked: AgeLockedResourceV1,
  }),
]);
export type PublicPostRouteResultV1 = Schema.Schema.Type<typeof PublicPostRouteResultV1>;

export const PublicPostSitemapItemV1 = Schema.Struct({
  canonical_path: PublicPostCanonicalPathV1,
});
export type PublicPostSitemapItemV1 = Schema.Schema.Type<typeof PublicPostSitemapItemV1>;

export const PublicPostSitemapPageV1 = Schema.Struct({
  object: Schema.Literal("public_post_sitemap_page"),
  items: Schema.Array(PublicPostSitemapItemV1),
  next_cursor: Schema.NullOr(Schema.String),
});
export type PublicPostSitemapPageV1 = Schema.Schema.Type<typeof PublicPostSitemapPageV1>;

/** Effect Struct strips excess keys by default; wire decoders use this strict boundary. */
export const PublicPostContractParseOptions = { onExcessProperty: "error" } as const;

export const decodePublicPostBySlugQueryV1 = Schema.decodeUnknownSync(
  PublicPostBySlugQueryV1,
  PublicPostContractParseOptions,
);

export const decodePublicPostCanonicalRouteByIdPathV1 = Schema.decodeUnknownSync(
  PublicPostCanonicalRouteByIdPathV1,
  PublicPostContractParseOptions,
);

export const decodePublicPostSitemapQueryV1 = Schema.decodeUnknownSync(
  PublicPostSitemapQueryV1,
  PublicPostContractParseOptions,
);

export const decodePublicPostRouteResultV1 = Schema.decodeUnknownSync(
  PublicPostRouteResultV1,
  PublicPostContractParseOptions,
);

export const decodePublicPostSitemapPageV1 = Schema.decodeUnknownSync(
  PublicPostSitemapPageV1,
  PublicPostContractParseOptions,
);

export const GetPublicPostBySlug = endpoint({
  method: "GET",
  path: "/public/posts/by-slug",
  auth: Auth.user({ optionalUser: true }),
  request: { query: PublicPostBySlugQueryV1 },
  response: PublicPostRouteResultV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const GetPublicPostCanonicalRouteById = endpoint({
  method: "GET",
  path: "/public/posts/by-id/:postId/canonical-route",
  auth: Auth.user({ optionalUser: true }),
  request: {
    path: PublicPostCanonicalRouteByIdPathV1,
    query: LocaleQuery,
  },
  response: PublicPostRouteResultV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const GetPublicPostSitemap = endpoint({
  method: "GET",
  path: "/public/posts/sitemap",
  auth: Auth.public(),
  request: { query: PublicPostSitemapQueryV1 },
  response: PublicPostSitemapPageV1,
  successStatus: 200,
  errors: [BadRequest, RateLimited, InternalError],
});

export const publicPostRoutesRegistry = {
  GetPublicPostBySlug,
  GetPublicPostCanonicalRouteById,
  GetPublicPostSitemap,
} as const;
