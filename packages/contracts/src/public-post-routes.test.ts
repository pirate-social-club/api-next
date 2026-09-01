import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { schemaToOpenApi } from "./codegen.ts";
import { AuthError, BadRequest, InternalError, NotFound, RateLimited } from "./errors.ts";
import {
  decodePublicPostBySlugQueryV1,
  decodePublicPostRouteResultV1,
  decodePublicPostSitemapPageV1,
  decodePublicPostSitemapQueryV1,
  GetPublicPostBySlug,
  GetPublicPostCanonicalRouteById,
  GetPublicPostSitemap,
  PublicPostRouteV1,
  PublicPostSitemapPageV1,
} from "./public-post-routes.ts";
import { LocalizedPost } from "./v1.ts";

describe("public post canonical route contracts", () => {
  test("declares the three distinct public operations and auth/error boundaries", () => {
    expect(GetPublicPostBySlug).toMatchObject({
      method: "GET",
      path: "/public/posts/by-slug",
      auth: Auth.user({ optionalUser: true }),
    });
    expect(GetPublicPostCanonicalRouteById).toMatchObject({
      method: "GET",
      path: "/public/posts/by-id/:postId/canonical-route",
      auth: Auth.user({ optionalUser: true }),
    });
    expect(GetPublicPostSitemap).toMatchObject({
      method: "GET",
      path: "/public/posts/sitemap",
      auth: Auth.public(),
      errors: [BadRequest, RateLimited, InternalError],
    });
    expect(GetPublicPostBySlug.errors).toEqual([AuthError, BadRequest, NotFound, InternalError]);
    expect(GetPublicPostCanonicalRouteById.errors).toEqual([
      AuthError,
      BadRequest,
      NotFound,
      InternalError,
    ]);
  });

  test("validates logical slug input before exact lookup", () => {
    expect(decodePublicPostBySlugQueryV1({ slug: "你好-world", locale: "en" })).toEqual({
      slug: "你好-world",
      locale: "en",
    });
    for (const slug of ["", " ", "foo%bar", "foo/bar", "foo\\bar", ".", "..", "ｆｏｏ", "e\u0301"])
      expect(() => decodePublicPostBySlugQueryV1({ slug })).toThrow();
    expect(() => decodePublicPostBySlugQueryV1({ slug: "a".repeat(81) })).toThrow();
    expect(() => decodePublicPostBySlugQueryV1({ slug: "valid", forged: "input" })).toThrow();
  });

  test("bounds sitemap pagination while keeping cursor opaque", () => {
    expect(decodePublicPostSitemapQueryV1({ cursor: "opaque.cursor", limit: "1000" })).toEqual({
      cursor: "opaque.cursor",
      limit: "1000",
    });
    expect(decodePublicPostSitemapQueryV1({})).toEqual({});
    for (const limit of ["0", "1001", "1.5", "01", "-1", "ten"]) {
      expect(() => decodePublicPostSitemapQueryV1({ limit })).toThrow();
    }
  });

  test("derives activity paths from the canonical detail path", () => {
    const route = {
      canonical_path: "/posts/deja-vu",
      activity_paths: {
        study: "/posts/deja-vu/study",
        karaoke: "/posts/deja-vu/karaoke",
        karaoke_leaderboard: "/posts/deja-vu/karaoke/leaderboard",
      },
    };
    expect(Schema.decodeUnknownSync(PublicPostRouteV1)(route)).toEqual(route);
    expect(() =>
      Schema.decodeUnknownSync(PublicPostRouteV1)({
        ...route,
        activity_paths: { ...route.activity_paths, study: "/posts/other/study" },
      }),
    ).toThrow();
  });

  test("keeps the age-locked result content-free and sitemap paths-only", () => {
    expect(
      decodePublicPostRouteResultV1({
        kind: "age_locked",
        locked: {
          kind: "age_locked",
          content_rating: "adult_18",
          next_action: { kind: "verify_minimum_age", minimum_age: 18 },
        },
      }),
    ).toEqual({
      kind: "age_locked",
      locked: {
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      },
    });
    expect(
      decodePublicPostSitemapPageV1({
        object: "public_post_sitemap_page",
        items: [{ canonical_path: "/posts/deja-vu" }],
        next_cursor: null,
      }),
    ).toEqual({
      object: "public_post_sitemap_page",
      items: [{ canonical_path: "/posts/deja-vu" }],
      next_cursor: null,
    });
    expect(() =>
      decodePublicPostSitemapPageV1({
        object: "public_post_sitemap_page",
        items: [{ canonical_path: "/posts/deja-vu", title: "forged" }],
        next_cursor: null,
      }),
    ).toThrow();
  });

  test("promotes canonical_path on the existing localized feed projection", () => {
    const json = schemaToOpenApi(LocalizedPost);
    const properties = json.properties as Record<string, Record<string, unknown>>;
    expect(properties.canonical_path).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(json.required as string[]).not.toContain("canonical_path");
    const sitemapJson = schemaToOpenApi(PublicPostSitemapPageV1);
    expect(sitemapJson.properties).toHaveProperty("items");
  });
});
