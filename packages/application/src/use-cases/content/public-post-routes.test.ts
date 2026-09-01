import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { LocalizedPostDocument } from "../../ports.ts";
import {
  getPublicPostBySlug,
  getPublicPostCanonicalRouteById,
  getPublicPostSitemap,
  type PublicPostLiveRecord,
  type PublicPostRouteServices,
  type PublicPostRouteStoreService,
} from "./public-post-routes.ts";

const content = (canonicalPath?: string): LocalizedPostDocument =>
  ({
    post: {
      id: "post-1",
      object: "post",
      community: "community-1",
      author_persona: null,
      authorship_mode: "human_direct",
      identity_mode: "public",
      post_type: "text",
      status: "published",
      visibility: "public",
      comments_locked: false,
      title: "Hello world",
      body: "Body",
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
      created: 1,
    },
    ...(canonicalPath === undefined ? {} : { canonical_path: canonicalPath }),
    thread_snapshot: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    comment_count: 0,
    viewer_vote: null,
    viewer_reaction_kinds: [],
    resolved_locale: "en",
    translation_state: "policy_blocked",
    machine_translated: false,
    source_hash: null,
  }) as LocalizedPostDocument;

const live = (overrides: Partial<PublicPostLiveRecord> = {}): PublicPostLiveRecord => ({
  alias: { slug: "hello-world", postId: "post-1" },
  post: {
    postId: "post-1",
    communityId: "community-1",
    status: "published",
    postType: "text",
    visibility: "public",
    contentRating: "general",
  },
  community: { communityId: "community-1", status: "active" },
  viewer: {
    userId: undefined,
    isMember: false,
    ratingViewAllowed: true,
    canRead: true,
  },
  canonicalPath: "/posts/hello-world",
  ...overrides,
});

const services = (
  record: PublicPostLiveRecord | null,
  options: Readonly<{ projected?: LocalizedPostDocument; contentCalls?: string[] }> = {},
): PublicPostRouteServices => {
  const publicPostRouteStore: PublicPostRouteStoreService = {
    getBySlug: () => Effect.succeed(record),
    getCanonicalRouteByPostId: () => Effect.succeed(record),
    listSitemap: () =>
      Effect.succeed({ object: "public_post_sitemap_page", items: [], next_cursor: null }),
  };
  return {
    publicPostRouteStore,
    contentStore: {
      getPost: ({ viewerUserId }) => {
        options.contentCalls?.push(viewerUserId);
        return Effect.succeed(options.projected ?? content());
      },
    },
  };
};

describe("public post route use cases", () => {
  test("projects an anonymous public/general post with canonical activity paths", async () => {
    const contentCalls: string[] = [];
    const result = await Effect.runPromise(
      getPublicPostBySlug(
        { slug: "hello-world", locale: "en" },
        services(live(), { contentCalls }),
      ),
    );

    expect(result).toMatchObject({
      kind: "content",
      post_id: "post-1",
      content: { canonical_path: "/posts/hello-world" },
      route: {
        canonical_path: "/posts/hello-world",
        activity_paths: {
          study: "/posts/hello-world/study",
          karaoke: "/posts/hello-world/karaoke",
          karaoke_leaderboard: "/posts/hello-world/karaoke/leaderboard",
        },
      },
    });
    expect(contentCalls).toEqual(["public-post-anonymous"]);
  });

  test("returns the exact content-free age lock without loading content", async () => {
    const contentCalls: string[] = [];
    const adult = live({
      post: { ...live().post, contentRating: "adult_18" },
      viewer: { ...live().viewer, ratingViewAllowed: false, canRead: false },
      canonicalPath: null,
    });

    await expect(
      Effect.runPromise(
        getPublicPostBySlug({ slug: "hello-world" }, services(adult, { contentCalls })),
      ),
    ).resolves.toEqual({
      kind: "age_locked",
      locked: {
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      },
    });
    expect(contentCalls).toEqual([]);
  });

  test("redacts unauthorized member content and strips routes for authorized guarded reads", async () => {
    const memberPost = { ...live().post, visibility: "members_only" as const };
    await expect(
      Effect.runPromise(
        getPublicPostBySlug(
          { slug: "hello-world" },
          services(
            live({
              post: memberPost,
              viewer: { ...live().viewer, isMember: false, canRead: false },
              canonicalPath: null,
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "NotFound" });

    const authorized = await Effect.runPromise(
      getPublicPostCanonicalRouteById(
        { postId: "post-1", viewerUserId: "member-1" },
        services(
          live({
            post: memberPost,
            viewer: { ...live().viewer, userId: "member-1", isMember: true },
            canonicalPath: null,
          }),
          { projected: content("/posts/must-not-leak") },
        ),
      ),
    );
    expect(authorized).toMatchObject({ kind: "content", route: null });
    if (authorized.kind === "content") {
      expect(authorized.content).not.toHaveProperty("canonical_path");
    }
  });

  test("rejects malformed logical input before calling the store", async () => {
    let called = false;
    const base = services(live());
    const publicPostRouteStore: PublicPostRouteStoreService = {
      ...base.publicPostRouteStore,
      getBySlug: () => {
        called = true;
        return Effect.succeed(live());
      },
    };
    await expect(
      Effect.runPromise(
        getPublicPostBySlug({ slug: "hello%2Fworld" }, { ...base, publicPostRouteStore }),
      ),
    ).rejects.toMatchObject({ _tag: "BadRequest" });
    expect(called).toBe(false);
  });

  test("defaults sitemap pages to 1000 and maps invalid cursors to bad request", async () => {
    const observed: number[] = [];
    const publicPostRouteStore: PublicPostRouteStoreService = {
      getBySlug: () => Effect.succeed(null),
      getCanonicalRouteByPostId: () => Effect.succeed(null),
      listSitemap: ({ limit }) => {
        observed.push(limit);
        return Effect.succeed({
          object: "public_post_sitemap_page",
          items: [{ canonical_path: "/posts/hello-world" }],
          next_cursor: null,
        });
      },
    };
    await expect(
      Effect.runPromise(getPublicPostSitemap({}, { publicPostRouteStore })),
    ).resolves.toMatchObject({ items: [{ canonical_path: "/posts/hello-world" }] });
    expect(observed).toEqual([1_000]);

    const invalidCursorStore: PublicPostRouteStoreService = {
      ...publicPostRouteStore,
      listSitemap: () => Effect.fail({ reason: "invalid-cursor" }),
    };
    await expect(
      Effect.runPromise(
        getPublicPostSitemap({ cursor: "bad" }, { publicPostRouteStore: invalidCursorStore }),
      ),
    ).rejects.toMatchObject({ _tag: "BadRequest" });
  });
});
