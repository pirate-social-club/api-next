import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  followCommunityInputFrom,
  makeProductHandlers,
  type ProductHandlerServices,
  unfollowCommunityInputFrom,
} from "./product-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

type CommunityStore = ProductHandlerServices["communityStore"];
type ContentStore = ProductHandlerServices["contentStore"];
type FeedStore = ProductHandlerServices["feedStore"];

const feed = { items: [], top_communities: [], next_cursor: null };

const preview = (communityId: string) => ({
  id: communityId,
  object: "community_preview" as const,
  display_name: communityId,
  membership_mode: "open" as const,
  human_verification_lane: null,
  member_count: 0,
  follower_count: 0,
  moderators: [],
  membership_gate_summaries: [],
  rules: [],
  created: 0,
});

const eligibility = (communityId: string) => ({
  community: communityId,
  membership_mode: "open" as const,
  human_verification_lane: null,
  joinable_now: true,
  status: "joinable" as const,
  membership_gate_summaries: [],
});

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: undefined,
  params: { communityId: "community-a" },
  query: {},
  principal: { kind: "user", subject: "user-a" },
  ...overrides,
});

function stores(
  overrides: {
    readonly community?: Partial<CommunityStore>;
    readonly content?: Partial<ContentStore>;
    readonly feed?: Partial<FeedStore>;
  } = {},
): {
  readonly communityStore: CommunityStore;
  readonly contentStore: ContentStore;
  readonly feedStore: FeedStore;
} {
  return {
    communityStore: {
      membershipStatus: () => Effect.succeed("missing" as const),
      getPreview: ({ communityId }) => Effect.succeed(preview(communityId)),
      getJoinEligibility: ({ communityId }) => Effect.succeed(eligibility(communityId)),
      join: ({ communityId }) =>
        Effect.succeed({ community: communityId, status: "joined" as const }),
      follow: ({ communityId }) =>
        Effect.succeed({ community: communityId, following: true, follower_count: 1 }),
      unfollow: ({ communityId }) =>
        Effect.succeed({ community: communityId, following: false, follower_count: 0 }),
      ...overrides.community,
    },
    contentStore: {
      resolvePost: () => Effect.succeed(null),
      resolveComment: () => Effect.succeed(null),
      createPost: () => Effect.succeed(null),
      getPost: () => Effect.succeed(null),
      createCommentReply: () => Effect.succeed(null),
      castPostVote: () => Effect.succeed(null),
      clearPostVote: () => Effect.succeed(null),
      ...overrides.content,
    } as unknown as ContentStore,
    feedStore: {
      listHome: () => Effect.succeed(feed),
      ...overrides.feed,
    },
  };
}

describe("HTTP product handlers", () => {
  test("maps decoded community path, query, principal, and default join body", async () => {
    const observed: {
      preview: unknown[];
      eligibility?: unknown;
      join?: unknown;
      follow?: unknown;
      unfollow?: unknown;
    } = { preview: [] };
    const services = stores({
      community: {
        getPreview: (input) => {
          observed.preview.push(input);
          return Effect.succeed(preview(input.communityId));
        },
        getJoinEligibility: (input) => {
          observed.eligibility = input;
          return Effect.succeed(eligibility(input.communityId));
        },
        join: (input) => {
          observed.join = input;
          return Effect.succeed({ community: input.communityId, status: "joined" as const });
        },
        follow: (input) => {
          observed.follow = input;
          return Effect.succeed({
            community: input.communityId,
            following: true,
            follower_count: 1,
          });
        },
        unfollow: (input) => {
          observed.unfollow = input;
          return Effect.succeed({
            community: input.communityId,
            following: false,
            follower_count: 0,
          });
        },
      },
    });
    const handlers = makeProductHandlers(services);
    const principal = {
      kind: "admin" as const,
      subject: "admin-a",
      scopes: ["community:write"],
    };

    expect(followCommunityInputFrom(request({ principal, body: {} }))).toEqual({
      communityId: "community-a",
      actor: { userId: "admin-a", kind: "admin", scopes: ["community:write"] },
      body: {},
    });
    expect(unfollowCommunityInputFrom(request({ principal, body: {} }))).toEqual({
      communityId: "community-a",
      actor: { userId: "admin-a", kind: "admin", scopes: ["community:write"] },
      body: {},
    });

    await handlers.GetCommunityPreview(request({ query: { locale: "ka" }, principal }));
    await handlers.GetJoinEligibility(request({ principal }));
    await handlers.JoinCommunity(request({ principal }));
    await handlers.FollowCommunity(request({ principal, body: {} }));
    await handlers.UnfollowCommunity(request({ principal, body: {} }));

    expect(observed.preview[0]).toEqual({
      communityId: "community-a",
      locale: "ka",
      viewerUserId: "admin-a",
    });
    expect(observed.preview.slice(1)).toEqual([
      { communityId: "community-a", viewerUserId: "admin-a" },
      { communityId: "community-a", viewerUserId: "admin-a" },
    ]);
    expect(observed.eligibility).toEqual({ communityId: "community-a", userId: "admin-a" });
    expect(observed.join).toEqual({
      communityId: "community-a",
      actor: { userId: "admin-a", kind: "admin", scopes: ["community:write"] },
      body: {},
    });
    expect(observed.follow).toEqual({
      communityId: "community-a",
      actor: { userId: "admin-a", kind: "admin", scopes: ["community:write"] },
    });
    expect(observed.unfollow).toEqual({
      communityId: "community-a",
      actor: { userId: "admin-a", kind: "admin", scopes: ["community:write"] },
    });
  });

  test("keeps signed-out preview and feed viewers absent, while home feed maps an optional user", async () => {
    const observed: unknown[] = [];
    const services = stores({
      community: {
        getPreview: (input) => {
          observed.push(input);
          return Effect.succeed(preview(input.communityId));
        },
      },
      feed: {
        listHome: (input) => {
          observed.push(input);
          return Effect.succeed(feed);
        },
      },
    });
    const handlers = makeProductHandlers(services);

    await handlers.GetCommunityPreview(request({ principal: null }));
    await handlers.GetPublicHomeFeed(
      request({ principal: { kind: "user", subject: "must-not-be-used" }, query: { sort: "new" } }),
    );
    await handlers.GetHomeFeed(request({ principal: null, query: { locale: "en" } }));
    await handlers.GetHomeFeed(
      request({ principal: { kind: "user", subject: "user-a" }, query: { locale: "en" } }),
    );

    expect(observed).toEqual([
      { communityId: "community-a" },
      { query: { sort: "new" } },
      { query: { locale: "en" } },
      { query: { locale: "en" }, viewerUserId: "user-a" },
    ]);
  });

  test("maps the post path, locale, and required human viewer", async () => {
    const observed: unknown[] = [];
    const document = { id: "post-a", object: "post" };
    const handlers = makeProductHandlers(
      stores({
        content: {
          resolvePost: (input) => {
            observed.push({ resolvePost: input });
            return Effect.succeed({ communityId: "community-a", postId: input.postId });
          },
          getPost: (input) => {
            observed.push({ getPost: input });
            return Effect.succeed(document as never);
          },
        },
      }),
    );
    const principal = {
      kind: "admin" as const,
      subject: "admin-a",
      scopes: ["content:read"],
    };

    await expect(
      handlers.GetPost(
        request({ params: { postId: "post-a" }, query: { locale: "ka" }, principal }),
      ),
    ).resolves.toEqual(document);
    expect(observed).toEqual([
      { resolvePost: { postId: "post-a" } },
      {
        getPost: {
          communityId: "community-a",
          postId: "post-a",
          viewerUserId: "admin-a",
          locale: "ka",
        },
      },
    ]);
  });

  test("rejects device and agent principals for every community operation", async () => {
    const handlers = makeProductHandlers(stores());
    const requests = [
      handlers.GetCommunityPreview,
      handlers.GetJoinEligibility,
      handlers.JoinCommunity,
      handlers.FollowCommunity,
      handlers.UnfollowCommunity,
      handlers.GetPost,
    ];

    for (const kind of ["device", "agent"] as const) {
      for (const handler of requests) {
        await expect(
          handler(request({ principal: { kind, subject: `${kind}-a` } })),
        ).rejects.toMatchObject({ code: "auth_error" });
      }
      await expect(
        handlers.GetHomeFeed(request({ principal: { kind, subject: `${kind}-a` } })),
      ).rejects.toMatchObject({ code: "auth_error" });
    }
    await expect(handlers.GetPost(request({ principal: null }))).rejects.toMatchObject({
      code: "auth_error",
    });
  });

  test("propagates application failures after the use case maps storage errors", async () => {
    const handlers = makeProductHandlers(
      stores({
        feed: {
          listHome: () => Effect.fail(new Error("feed storage failed") as never),
        },
        community: {
          getPreview: () => Effect.fail(new Error("community storage failed") as never),
        },
        content: {
          resolvePost: () => Effect.succeed({ communityId: "community-a", postId: "post-a" }),
          getPost: () => Effect.fail(new Error("content storage failed") as never),
        },
      }),
    );

    await expect(handlers.GetPublicHomeFeed(request({ principal: null }))).rejects.toMatchObject({
      code: "internal_error",
    });
    await expect(handlers.GetCommunityPreview(request({ principal: null }))).rejects.toMatchObject({
      code: "internal_error",
    });
    await expect(
      handlers.GetPost(
        request({ params: { postId: "post-a" }, principal: { kind: "user", subject: "user-a" } }),
      ),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});
