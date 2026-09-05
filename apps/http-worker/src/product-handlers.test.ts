import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CommunityModerationStoreError } from "@pirate/application/use-cases/content/community-moderation-runtime";
import type { TextPostModerationEvaluation } from "@pirate/application/use-cases/content/text-post";
import { Effect } from "effect";
import {
  castPostVoteInputFrom,
  clearPostVoteInputFrom,
  createPostInputFrom,
  followCommunityInputFrom,
  makeProductHandlers,
  type ProductHandlerServices,
  unfollowCommunityInputFrom,
} from "./product-handlers.ts";
import type { DecodedRequest } from "./transport.ts";

type CommunityStore = ProductHandlerServices["communityStore"];
type ContentStore = ProductHandlerServices["contentStore"];
type FeedStore = ProductHandlerServices["feedStore"];
type TextStore = NonNullable<ProductHandlerServices["textPostStore"]>;
type Moderation = NonNullable<ProductHandlerServices["textModeration"]>;
type PersonaStore = NonNullable<ProductHandlerServices["personaStore"]>;
type CommunityModerationStore = NonNullable<ProductHandlerServices["moderationStore"]>;
const personaId = "persona-a";

const feed = { items: [], top_communities: [], next_cursor: null };
const textSubmission = {
  submission_id: "submission-a",
  href: "/text-content-submissions/submission-a",
  surface: "text_post" as const,
  status: "published" as const,
  result: { decision: "allow" as const, reason_code: null },
  published_resource: { kind: "post" as const, post_id: "post-a", href: "/posts/post-a" },
  review_ref: null,
  created_at: "2026-08-21T12:00:00.000Z",
  updated_at: "2026-08-21T12:00:00.000Z",
};
const textEvaluation: TextPostModerationEvaluation = {
  version: "text-moderation-v1",
  surface: "text_post",
  decision: "allow",
  reason_codes: [],
  policy_revision: "text-policy-1",
  policy_hash: "a".repeat(64),
  input_sha256: "f854820405b8cebd6d3212d5de8cd9796b3e0c0c6b41f2ed8f72d961e504c89d",
  evidence_ref: null,
};

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
  next_action: { kind: "join" as const },
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
    readonly textPost?: Partial<TextStore>;
    readonly textModeration?: Partial<Moderation>;
    readonly feed?: Partial<FeedStore>;
    readonly moderation?: Partial<CommunityModerationStore>;
  } = {},
): {
  readonly communityStore: CommunityStore;
  readonly contentStore: ContentStore;
  readonly textPostStore: TextStore;
  readonly textModeration: Moderation;
  readonly personaStore: PersonaStore;
  readonly feedStore: FeedStore;
  readonly moderationStore: CommunityModerationStore;
} {
  return {
    communityStore: {
      listAccountMemberships: () =>
        Effect.succeed({
          object: "account_community_membership_page",
          items: [],
          next_cursor: null,
        }),
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
      checkVoteAuthority: () => Effect.succeed(undefined),
      replayCastPostVote: () => Effect.succeed(null),
      replayClearPostVote: () => Effect.succeed(null),
      castPostVote: () => Effect.succeed(null),
      clearPostVote: () => Effect.succeed(null),
      ...overrides.content,
    } as unknown as ContentStore,
    textPostStore: {
      checkAuthority: () => Effect.succeed(undefined),
      replay: () => Effect.succeed({ kind: "none" as const }),
      commitTerminal: () => Effect.succeed({ kind: "created" as const, snapshot: textSubmission }),
      getForAuthor: () => Effect.succeed(textSubmission),
      ...overrides.textPost,
    } as TextStore,
    textModeration: {
      evaluate: () => Effect.succeed(textEvaluation),
      ...overrides.textModeration,
    } as Moderation,
    personaStore: {
      findOwned: () =>
        Effect.succeed({
          persona_id: personaId,
          object: "persona" as const,
          status: "active" as const,
          profile: {
            persona_id: personaId,
            object: "persona_profile" as const,
            revision: 1,
            display_name: null,
            avatar_ref: null,
            cover_ref: null,
            bio: null,
            preferred_locale: null,
            primary_public_handle: null,
          },
          wallet_set: { evm: null },
          community_binding: null,
          created_at: "2026-08-21T12:00:00.000Z",
          retired_at: null,
        }),
    },
    feedStore: {
      listHome: () => Effect.succeed(feed),
      ...overrides.feed,
    },
    moderationStore: {
      getCapabilities: () => Effect.die("unexpected moderation capability read"),
      listCases: () => Effect.die("unexpected moderation case list"),
      getCase: () => Effect.die("unexpected moderation case detail"),
      getPolicy: () => Effect.die("unexpected moderation policy read"),
      updatePolicy: () => Effect.die("unexpected moderation policy update"),
      reportTarget: () => Effect.die("unexpected moderation report"),
      replayLegacyAction: () => Effect.succeed(null),
      actOnCase: () => Effect.die("unexpected moderation action"),
      ...overrides.moderation,
    },
  };
}

describe("HTTP product handlers", () => {
  for (const target of ["post", "comment", "action"] as const) {
    const isAction = target === "action";
    const body = isAction
      ? {
          version: "moderation-case-action-v2",
          idempotency_key: "key-a",
          expected_case_revision: 3,
          action: "hide",
        }
      : { idempotency_key: "key-a", reason_code: "spam" };
    const params = isAction ? { caseRef: "case-a" } : { [`${target}Id`]: `${target}-a` };
    const preimage = isAction
      ? '{"body":{"action":"hide","expected_case_revision":3,"idempotency_key":"key-a","version":"moderation-case-action-v2"},"case_ref":"case-a","endpoint":"POST /moderation/cases/:caseRef/actions"}'
      : target === "comment"
        ? '{"body":{"idempotency_key":"key-a","reason_code":"spam"},"comment_id":"comment-a","endpoint":"POST /comments/:commentId/reports"}'
        : '{"body":{"idempotency_key":"key-a","reason_code":"spam"},"endpoint":"POST /posts/:postId/reports","post_id":"post-a"}';
    const handlerName = isAction
      ? "ModerateCaseAction"
      : target === "post"
        ? "ReportPost"
        : "ReportComment";
    const report = { report_id: "report-a", case_ref: "case-a", status: "open" as const };
    const action = {
      version: "moderation-case-action-result-v2" as const,
      action_id: "action-a",
      case_ref: "case-a",
      action: "hide" as const,
      target_status: "hidden" as const,
    };

    test(`${target} preserves canonical fingerprint, storage input and replay response`, async () => {
      const inputs: unknown[] = [];
      const handlers = makeProductHandlers(
        stores({
          moderation: {
            reportTarget: (input) => {
              inputs.push(input);
              return Effect.succeed(report);
            },
            actOnCase: (input) => {
              inputs.push(input);
              return Effect.succeed(action);
            },
          },
        }),
      );
      const expectedInput = {
        actor: { kind: "user", userId: "user-a" },
        idempotencyKey: "key-a",
        requestHash: createHash("sha256").update(preimage).digest("hex"),
        ...(isAction
          ? { caseRef: "case-a", expectedCaseRevision: 3, action: "hide" }
          : { targetType: target, targetId: `${target}-a`, reasonCode: "spam" }),
      };
      for (const requestBody of [body, Object.fromEntries(Object.entries(body).reverse())]) {
        await expect(
          handlers[handlerName](request({ params, body: requestBody })),
        ).resolves.toEqual(isAction ? action : report);
      }
      expect(inputs).toEqual([expectedInput, expectedInput]);
    });

    test(`${target} preserves storage error mapping`, async () => {
      for (const [reason, code] of [
        ["not-found", "not_found"],
        ["membership-required", "membership_required"],
        ["idempotency-conflict", "conflict"],
        ["conflict", "conflict"],
        ["constraint", "bad_request"],
        ["invalid-row", "internal_error"],
      ] as const) {
        const failure = new CommunityModerationStoreError({
          operation: isAction ? "action" : "report",
          reason,
        });
        let calls = 0;
        const fail = () => {
          calls += 1;
          return Effect.fail(failure);
        };
        const handlers = makeProductHandlers(
          stores({ moderation: { reportTarget: fail, actOnCase: fail } }),
        );
        await expect(handlers[handlerName](request({ params, body }))).rejects.toMatchObject({
          code,
          ...(reason === "idempotency-conflict"
            ? {
                details: {
                  reason_code: "idempotency_conflict",
                  submission_id: isAction ? "case-a" : `${target}-a`,
                },
              }
            : {}),
        });
        expect(calls).toBe(1);
      }
    });

    test(`${target} fingerprints before authorization and never mutates after an earlier failure`, async () => {
      let calls = 0;
      const handlers = makeProductHandlers(
        stores({
          moderation: {
            reportTarget: () => {
              calls += 1;
              return Effect.succeed(report);
            },
            actOnCase: () => {
              calls += 1;
              return Effect.succeed(action);
            },
          },
        }),
      );
      await expect(
        handlers[handlerName](
          request({ params, principal: null, body: { ...body, idempotency_key: "\ud800" } }),
        ),
      ).rejects.toMatchObject({ code: "internal_error", message: "Unable to fingerprint request" });
      await expect(
        handlers[handlerName](request({ params, principal: null, body })),
      ).rejects.toMatchObject({ code: "auth_error" });
      expect(calls).toBe(0);
    });
  }

  test("maps comment report and moderation action outcomes to contract response shapes", async () => {
    const handlers = makeProductHandlers(
      stores({
        moderation: {
          reportTarget: () =>
            Effect.succeed({ report_id: "report-a", case_ref: "case-a", status: "open" as const }),
          actOnCase: ({ action }) =>
            Effect.succeed({
              version: "moderation-case-action-result-v2" as const,
              action_id: "action-a",
              case_ref: "case-a",
              action,
              target_status: "hidden" as const,
            }),
        },
      }),
    );
    const principal = { kind: "admin" as const, subject: "admin-a", scopes: ["moderator"] };

    await expect(
      handlers.ReportComment(
        request({
          params: { commentId: "comment-a" },
          principal,
          body: { idempotency_key: "report-key", reason_code: "spam" },
        }),
      ),
    ).resolves.toEqual({ report_id: "report-a", case_ref: "case-a", status: "open" });
    await expect(
      handlers.ModerateCaseAction(
        request({
          params: { caseRef: "case-a" },
          principal,
          body: {
            version: "moderation-case-action-v2",
            idempotency_key: "action-key",
            expected_case_revision: 1,
            action: "hide",
          },
        }),
      ),
    ).resolves.toEqual({
      version: "moderation-case-action-result-v2",
      action_id: "action-a",
      case_ref: "case-a",
      action: "hide",
      target_status: "hidden",
    });
  });

  test("maps decoded community path, query, principal, and default join body", async () => {
    const observed: {
      preview: unknown[];
      memberships?: unknown;
      eligibility?: unknown;
      join?: unknown;
      follow?: unknown;
      unfollow?: unknown;
    } = { preview: [] };
    const services = stores({
      community: {
        listAccountMemberships: (input) => {
          observed.memberships = input;
          return Effect.succeed({
            object: "account_community_membership_page",
            items: [],
            next_cursor: null,
          });
        },
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

    await handlers.ListMyCommunityMemberships(
      request({ query: { cursor: "opaque", limit: "25" }, principal }),
    );
    await handlers.GetCommunityPreview(request({ query: { locale: "ka" }, principal }));
    await handlers.GetJoinEligibility(request({ principal }));
    await handlers.JoinCommunity(request({ principal, body: { persona: { kind: "create_new" } } }));
    await handlers.FollowCommunity(request({ principal, body: {} }));
    await handlers.UnfollowCommunity(request({ principal, body: {} }));

    expect(observed.preview[0]).toEqual({
      communityId: "community-a",
      locale: "ka",
      viewerUserId: "admin-a",
    });
    expect(observed.memberships).toEqual({
      userId: "admin-a",
      query: { cursor: "opaque", limit: "25" },
    });
    expect(observed.preview.slice(1)).toEqual([
      { communityId: "community-a", viewerUserId: "admin-a" },
      { communityId: "community-a", viewerUserId: "admin-a" },
    ]);
    expect(observed.eligibility).toEqual({ communityId: "community-a", userId: "admin-a" });
    expect(observed.join).toEqual({
      communityId: "community-a",
      actor: { userId: "admin-a", kind: "admin", scopes: ["community:write"] },
      body: { persona: { kind: "create_new" } },
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

  test("maps content mutation paths, bodies, actors, and vote operations", async () => {
    const observed: unknown[] = [];
    const handlers = makeProductHandlers(
      stores({
        content: {
          resolvePost: (input) => {
            observed.push({ resolvePost: input });
            return Effect.succeed({ communityId: "community-a", postId: input.postId });
          },
          checkVoteAuthority: (input) => {
            observed.push({ checkVoteAuthority: input });
            return Effect.succeed(undefined);
          },
          replayCastPostVote: (input) => {
            observed.push({ replayCastPostVote: input });
            return Effect.succeed(null);
          },
          replayClearPostVote: (input) => {
            observed.push({ replayClearPostVote: input });
            return Effect.succeed(null);
          },
          castPostVote: (input) => {
            observed.push({ castPostVote: input });
            return Effect.succeed({ post_id: input.postId, value: input.body.value });
          },
          clearPostVote: (input) => {
            observed.push({ clearPostVote: input });
            return Effect.succeed({ post_id: input.postId, value: 0 as const });
          },
        },
        textPost: {
          commitTerminal: (input) => {
            observed.push({ commitTerminal: input });
            return Effect.succeed({ kind: "created" as const, snapshot: textSubmission });
          },
        },
      }),
    );
    const principal = { kind: "user" as const, subject: "user-a" };
    const postBody = {
      post_type: "text" as const,
      persona_id: personaId,
      idempotency_key: "post-key",
      body: "hello",
      authorship_mode: "human_direct" as const,
      identity_mode: "public" as const,
    };
    const voteBody = { idempotency_key: "vote-key", value: -1 as const };
    const clearBody = { idempotency_key: "clear-key" };

    expect(
      createPostInputFrom(
        request({ params: { communityId: "community-a" }, body: postBody, principal }),
      ),
    ).toEqual({
      communityId: "community-a",
      actor: { userId: "user-a", kind: "user" },
      body: postBody,
    });
    expect(
      castPostVoteInputFrom(request({ params: { postId: "post-a" }, body: voteBody, principal })),
    ).toEqual({ postId: "post-a", actor: { userId: "user-a", kind: "user" }, body: voteBody });
    expect(
      clearPostVoteInputFrom(request({ params: { postId: "post-a" }, body: clearBody, principal })),
    ).toEqual({ postId: "post-a", actor: { userId: "user-a", kind: "user" }, body: clearBody });

    await handlers.CreatePost(
      request({ params: { communityId: "community-a" }, body: postBody, principal }),
    );
    await handlers.CastPostVote(
      request({ params: { postId: "post-a" }, body: voteBody, principal }),
    );
    await handlers.ClearPostVote(
      request({ params: { postId: "post-a" }, body: clearBody, principal }),
    );

    expect(observed[0]).toMatchObject({
      commitTerminal: {
        communityId: "community-a",
        actor: { userId: "user-a", kind: "user" },
        body: postBody,
        idempotencyKey: "post-key",
        requestHash: expect.any(String),
        operationId: expect.any(String),
        evaluation: { decision: "allow", surface: "text_post" },
      },
    });
    expect(observed.slice(1)).toEqual([
      { resolvePost: { postId: "post-a" } },
      {
        replayCastPostVote: {
          communityId: "community-a",
          postId: "post-a",
          actor: { userId: "user-a", kind: "user" },
          idempotencyKey: "vote-key",
          requestHash: expect.any(String),
        },
      },
      {
        checkVoteAuthority: {
          communityId: "community-a",
          postId: "post-a",
          actor: { userId: "user-a", kind: "user" },
        },
      },
      {
        castPostVote: {
          communityId: "community-a",
          postId: "post-a",
          actor: { userId: "user-a", kind: "user" },
          body: voteBody,
          requestHash: expect.any(String),
        },
      },
      { resolvePost: { postId: "post-a" } },
      {
        replayClearPostVote: {
          communityId: "community-a",
          postId: "post-a",
          actor: { userId: "user-a", kind: "user" },
          idempotencyKey: "clear-key",
          requestHash: expect.any(String),
        },
      },
      {
        checkVoteAuthority: {
          communityId: "community-a",
          postId: "post-a",
          actor: { userId: "user-a", kind: "user" },
        },
      },
      {
        clearPostVote: {
          communityId: "community-a",
          postId: "post-a",
          actor: { userId: "user-a", kind: "user" },
          body: clearBody,
          requestHash: expect.any(String),
        },
      },
    ]);
  });

  test("fails closed for null, device, and agent principals on every content mutation", async () => {
    const handlers = makeProductHandlers(stores());
    const requests = [handlers.CreatePost, handlers.CastPostVote, handlers.ClearPostVote];
    for (const principal of [
      null,
      { kind: "device" as const, subject: "device-a" },
      { kind: "agent" as const, subject: "agent-a" },
    ]) {
      for (const handler of requests) {
        await expect(handler(request({ principal }))).rejects.toMatchObject({ code: "auth_error" });
      }
    }
  });

  test("preserves repository replay results at the content handler seam", async () => {
    const body = {
      post_type: "text" as const,
      persona_id: personaId,
      idempotency_key: "replay-key",
      body: "hello",
    };
    let replayCalls = 0;
    const replayHandlers = makeProductHandlers(
      stores({
        textPost: {
          replay: () => {
            replayCalls += 1;
            return Effect.succeed({ kind: "replay" as const, snapshot: textSubmission });
          },
        },
      }),
    );

    await expect(
      replayHandlers.CreatePost(
        request({
          params: { communityId: "community-a" },
          body,
          principal: { kind: "user", subject: "user-a" },
        }),
      ),
    ).resolves.toEqual(textSubmission);
    expect(replayCalls).toBe(1);
  });

  test("never invokes content storage for a home-feed request", async () => {
    let contentCalls = 0;
    const content = Object.fromEntries(
      [
        "resolvePost",
        "resolveComment",
        "createPost",
        "getPost",
        "checkVoteAuthority",
        "replayCastPostVote",
        "replayClearPostVote",
        "castPostVote",
        "clearPostVote",
      ].map((name) => [
        name,
        () => {
          contentCalls += 1;
          return Effect.succeed(null);
        },
      ]),
    ) as Partial<ContentStore>;
    const handlers = makeProductHandlers(stores({ content }));

    await expect(handlers.GetPublicHomeFeed(request({ principal: null }))).resolves.toEqual(feed);
    expect(contentCalls).toBe(0);
  });

  test("rejects device and agent principals for every community operation", async () => {
    const handlers = makeProductHandlers(stores());
    const requests = [
      handlers.ListMyCommunityMemberships,
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
    await expect(
      handlers.ListMyCommunityMemberships(request({ principal: null })),
    ).rejects.toMatchObject({ code: "auth_error" });
  });

  test("fails closed for null, device, and delegated-agent current-user principals", async () => {
    let lookups = 0;
    const handlers = makeProductHandlers({
      ...stores(),
      identityStore: {
        findUser: () => {
          lookups += 1;
          return Effect.succeed(null);
        },
        resolveCanonical: () => Effect.fail(new Error("not used") as never),
      },
    });

    for (const principal of [
      null,
      { kind: "device" as const, subject: "device-a" },
      { kind: "agent" as const, subject: "agent-a" },
    ]) {
      await expect(handlers.GetCurrentUser(request({ principal }))).rejects.toMatchObject({
        code: "auth_error",
      });
    }
    expect(lookups).toBe(0);
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
