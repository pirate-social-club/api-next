import { describe, expect, test } from "bun:test";
import type { PublicPostRouteServices } from "@pirate/application/use-cases/content/public-post-routes";
import { Effect } from "effect";
import { makePublicPostRouteHandlers } from "./public-post-route-handlers.ts";
import { createHttpWorker, type DecodedRequest } from "./transport.ts";

const live = {
  alias: { slug: "hello-world", postId: "post-1" },
  post: {
    postId: "post-1",
    communityId: "community-1",
    status: "published" as const,
    postType: "text",
    visibility: "public" as const,
    contentRating: "general" as const,
  },
  community: { communityId: "community-1", status: "active" as const },
  viewer: {
    userId: undefined,
    isMember: false,
    ratingViewAllowed: true,
    canRead: true,
  },
  canonicalPath: "/posts/hello-world",
};

const content = {
  post: {
    id: "post-1",
    object: "post" as const,
    community: "community-1",
    author_persona: null,
    authorship_mode: "human_direct" as const,
    identity_mode: "public" as const,
    post_type: "text" as const,
    status: "published" as const,
    comments_locked: false,
    visibility: "public" as const,
    title: "Hello world",
    body: "Body",
    analysis_state: "allow" as const,
    content_safety_state: "safe" as const,
    age_gate_policy: "none" as const,
    created: 1,
  },
  thread_snapshot: null,
  upvote_count: 0,
  downvote_count: 0,
  like_count: 0,
  comment_count: 0,
  viewer_vote: null,
  viewer_reaction_kinds: [],
  resolved_locale: "en",
  translation_state: "policy_blocked" as const,
  machine_translated: false,
  source_hash: null,
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest =>
  ({
    principal: null,
    params: {},
    query: {},
    headers: new Headers(),
    ...overrides,
  }) as DecodedRequest;

describe("public post route HTTP handlers", () => {
  test("serves the registered anonymous slug route and rejects encoded logical aliases", async () => {
    const services: PublicPostRouteServices = {
      publicPostRouteStore: {
        getBySlug: () => Effect.succeed(live),
        getCanonicalRouteByPostId: () => Effect.succeed(null),
        listSitemap: () =>
          Effect.succeed({ object: "public_post_sitemap_page", items: [], next_cursor: null }),
      },
      contentStore: { getPost: () => Effect.succeed(content) },
    };
    const worker = createHttpWorker({
      handlers: makePublicPostRouteHandlers(services),
      authenticate: () => ({ kind: "user", subject: "unused-viewer" }),
      authorize: () => undefined,
    });
    const response = await worker.request(
      "http://worker.test/public/posts/by-slug?slug=hello-world",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "content",
      post_id: "post-1",
      route: { canonical_path: "/posts/hello-world" },
    });

    const encoded = await worker.request(
      "http://worker.test/public/posts/by-slug?slug=hello%252Fworld",
    );
    expect(encoded.status).toBe(400);
  });

  test("passes only the optional canonical viewer identity to slug lookup", async () => {
    const observed: unknown[] = [];
    const services: PublicPostRouteServices = {
      publicPostRouteStore: {
        getBySlug: (input) => {
          observed.push(input);
          return Effect.succeed({
            ...live,
            viewer: { ...live.viewer, userId: input.viewerUserId },
          });
        },
        getCanonicalRouteByPostId: () => Effect.succeed(null),
        listSitemap: () =>
          Effect.succeed({ object: "public_post_sitemap_page", items: [], next_cursor: null }),
      },
      contentStore: { getPost: () => Effect.succeed(content) },
    };
    const handlers = makePublicPostRouteHandlers(services);
    await handlers.GetPublicPostBySlug(
      request({
        principal: { kind: "user", subject: "viewer-1" },
        query: { slug: "hello-world", locale: "de" },
      }),
    );
    expect(observed).toEqual([{ slug: "hello-world", viewerUserId: "viewer-1" }]);
  });

  test("rejects a non-user principal at the adapter boundary", async () => {
    const services: PublicPostRouteServices = {
      publicPostRouteStore: {
        getBySlug: () => Effect.succeed(live),
        getCanonicalRouteByPostId: () => Effect.succeed(live),
        listSitemap: () =>
          Effect.succeed({ object: "public_post_sitemap_page", items: [], next_cursor: null }),
      },
      contentStore: { getPost: () => Effect.succeed(content) },
    };
    const handlers = makePublicPostRouteHandlers(services);
    await expect(
      handlers.GetPublicPostCanonicalRouteById(
        request({ principal: { kind: "agent", subject: "agent-1" }, params: { postId: "post-1" } }),
      ),
    ).rejects.toMatchObject({ _tag: "AuthError" });
  });

  test("keeps sitemap public and path-only", async () => {
    const services: PublicPostRouteServices = {
      publicPostRouteStore: {
        getBySlug: () => Effect.succeed(null),
        getCanonicalRouteByPostId: () => Effect.succeed(null),
        listSitemap: ({ limit }) =>
          Effect.succeed({
            object: "public_post_sitemap_page",
            items: [{ canonical_path: `/posts/page-${limit}` }],
            next_cursor: null,
          }),
      },
      contentStore: { getPost: () => Effect.succeed(content) },
    };
    await expect(
      makePublicPostRouteHandlers(services).GetPublicPostSitemap(
        request({ query: { limit: "20" } }),
      ),
    ).resolves.toEqual({
      object: "public_post_sitemap_page",
      items: [{ canonical_path: "/posts/page-20" }],
      next_cursor: null,
    });
  });
});
