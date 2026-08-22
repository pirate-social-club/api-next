import { describe, expect, test } from "bun:test";
import { InternalError } from "@pirate/contracts";
import { Cause, Effect, Exit, Result } from "effect";
import {
  ContentRepositoryError,
  type ContentStore,
  TextModerationProviderError,
  type TextPostStore,
} from "../../ports.ts";
import { castPostVote } from "./cast-post-vote.ts";
import { clearPostVote } from "./clear-post-vote.ts";
import { createPost } from "./create-post.ts";
import { getPost } from "./get-post.ts";

const actor = { userId: "usr_alice", kind: "user" as const };

const fakeDocument = {
  id: "post_1",
  object: "post" as const,
  community: "community_1",
  authorship_mode: "human_direct" as const,
  identity_mode: "public" as const,
  post_type: "text" as const,
  status: "processing" as const,
  visibility: "public" as const,
  analysis_state: "pending" as const,
  content_safety_state: "pending" as const,
  age_gate_policy: "none" as const,
  created: 1,
};

const fakeStore = (overrides: Partial<ContentStore["Service"]> = {}) => {
  const base = {
    resolvePost: () => Effect.succeed(null),
    resolveComment: () => Effect.succeed(null),
    createPost: () => Effect.succeed(fakeDocument),
    getPost: () => Effect.succeed(null),
    checkVoteAuthority: () => Effect.succeed(undefined),
    replayCastPostVote: () => Effect.succeed(null),
    replayClearPostVote: () => Effect.succeed(null),
    castPostVote: () => Effect.succeed({ post_id: "post_1", value: 1 as const }),
    clearPostVote: () => Effect.succeed({ post_id: "post_1", value: 0 as const }),
  } as unknown as ContentStore["Service"];
  return { ...base, ...overrides };
};

const textSubmission = {
  submission_id: "submission_1",
  href: "/text-content-submissions/submission_1",
  surface: "text_post" as const,
  status: "published" as const,
  result: { decision: "allow" as const, reason_code: null },
  published_resource: { kind: "post" as const, post_id: "post_1", href: "/posts/post_1" },
  review_ref: null,
  created_at: "2026-08-21T12:00:00.000Z",
  updated_at: "2026-08-21T12:00:00.000Z",
};

const textPostStore = (
  overrides: Partial<TextPostStore["Service"]> = {},
): TextPostStore["Service"] => ({
  checkAuthority: () => Effect.succeed(undefined),
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitTerminal: () => Effect.succeed({ kind: "created" as const, snapshot: textSubmission }),
  getForAuthor: () => Effect.succeed(textSubmission),
  ...overrides,
});

const textRuntime = () => ({
  contentStore: fakeStore(),
  textPostStore: textPostStore(),
  textModeration: {
    evaluate: () => Effect.fail(new TextModerationProviderError({ reason: "unavailable" })),
  },
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

describe("M2 content use cases", () => {
  test("hashes the decoded request canonically and forwards processing state", async () => {
    const hashes: string[] = [];
    const store = textPostStore({
      commitTerminal: (input) => {
        hashes.push(input.requestHash);
        return Effect.succeed({ kind: "created" as const, snapshot: textSubmission });
      },
    });
    const first = await run(
      createPost(
        {
          communityId: "community_1",
          actor,
          body: { post_type: "text", idempotency_key: "key_1", body: "hello" },
        },
        { ...textRuntime(), textPostStore: store },
      ),
    );
    const second = await run(
      createPost(
        {
          communityId: "community_1",
          actor,
          body: { body: "hello", idempotency_key: "key_1", post_type: "text" },
        },
        { ...textRuntime(), textPostStore: store },
      ),
    );
    expect(Exit.isSuccess(first)).toBe(true);
    expect(Exit.isSuccess(second)).toBe(true);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toHaveLength(64);
    expect(hashes[0]).toBe(hashes[1]);
  });

  test.each([
    ["non-text", { post_type: "image", idempotency_key: "k", body: "x", media_refs: ["m"] }],
    ["agent", { post_type: "text", idempotency_key: "k", body: "x", agent_id: "agent_1" }],
    [
      "anonymous",
      { post_type: "text", idempotency_key: "k", body: "x", identity_mode: "anonymous" },
    ],
    [
      "age gate",
      { post_type: "text", idempotency_key: "k", body: "x", age_gate_policy: "18_plus" },
    ],
    ["access mode", { post_type: "text", idempotency_key: "k", body: "x", access_mode: "locked" }],
    [
      "translation policy",
      { post_type: "text", idempotency_key: "k", body: "x", translation_policy: "none" },
    ],
    ["publish mode", { post_type: "text", idempotency_key: "k", body: "x", publish_mode: "async" }],
    ["empty body", { post_type: "text", idempotency_key: "k", body: "   " }],
  ])("rejects unsupported post shape: %s", async (_label, body) => {
    const result = await run(
      createPost({ communityId: "community_1", actor, body }, textRuntime()),
    );
    expect(Exit.isFailure(result) ? result.cause : undefined).toBeDefined();
    expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
  });

  test("rejects excess CreatePost properties during direct application decoding", async () => {
    let createCalls = 0;
    const result = await run(
      createPost(
        {
          communityId: "community_1",
          actor,
          body: {
            post_type: "text",
            idempotency_key: "k",
            body: "hello",
            unsupported_future_field: true,
          },
        },
        {
          ...textRuntime(),
          textPostStore: textPostStore({
            commitTerminal: () => {
              createCalls += 1;
              return Effect.succeed({ kind: "created" as const, snapshot: textSubmission });
            },
          }),
        },
      ),
    );
    expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
    expect(createCalls).toBe(0);
  });

  test("rejects publish_mode during direct application decoding", async () => {
    let createCalls = 0;
    const result = await run(
      createPost(
        {
          communityId: "community_1",
          actor,
          body: {
            post_type: "text",
            idempotency_key: "k",
            body: "hello",
            publish_mode: "async",
          },
        },
        {
          ...textRuntime(),
          textPostStore: textPostStore({
            commitTerminal: () => {
              createCalls += 1;
              return Effect.succeed({ kind: "created" as const, snapshot: textSubmission });
            },
          }),
        },
      ),
    );
    expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
    expect(createCalls).toBe(0);
  });

  test("rejects delegated actors before content persistence", async () => {
    const result = await run(
      createPost(
        {
          communityId: "community_1",
          actor: { userId: "usr_agent_owner", kind: "agent" },
          body: { post_type: "text", idempotency_key: "k", body: "hello" },
        },
        textRuntime(),
      ),
    );
    expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
  });

  test("resolves global post IDs for reads and votes, and maps absence to not_found", async () => {
    const calls: string[] = [];
    const store = fakeStore({
      resolvePost: ({ postId }) => {
        calls.push(`resolve:${postId}`);
        return Effect.succeed({ communityId: "community_1", postId });
      },
      getPost: ({ communityId, postId }) => {
        calls.push(`get:${communityId}/${postId}`);
        return Effect.succeed({
          post: fakeDocument,
          thread_snapshot: null,
          upvote_count: 0,
          downvote_count: 0,
          like_count: 0,
          viewer_vote: null,
          viewer_reaction_kinds: [],
          resolved_locale: "en",
          translation_state: "same_language" as const,
          machine_translated: false,
          source_hash: "",
        });
      },
      checkVoteAuthority: ({ communityId, postId }) => {
        calls.push(`authority:${communityId}/${postId}`);
        return Effect.succeed(undefined);
      },
      replayCastPostVote: ({ communityId, postId }) => {
        calls.push(`replay:${communityId}/${postId}`);
        return Effect.succeed(null);
      },
      castPostVote: ({ communityId, postId }) => {
        calls.push(`vote:${communityId}/${postId}`);
        return Effect.succeed({ post_id: postId, value: 1 as const });
      },
    });
    const read = await run(getPost({ postId: "post_1", viewer: actor }, { contentStore: store }));
    const vote = await run(
      castPostVote(
        { postId: "post_1", actor, body: { idempotency_key: "vote-key", value: 1 } },
        { contentStore: store },
      ),
    );
    expect(Exit.isSuccess(read)).toBe(true);
    expect(Exit.isSuccess(vote)).toBe(true);
    expect(calls).toEqual([
      "resolve:post_1",
      "get:community_1/post_1",
      "resolve:post_1",
      "replay:community_1/post_1",
      "authority:community_1/post_1",
      "vote:community_1/post_1",
    ]);

    const missing = await run(
      getPost({ postId: "post_missing", viewer: actor }, { contentStore: fakeStore() }),
    );
    expect(failureOf(missing)).toMatchObject({ _tag: "NotFound" });
  });

  test("checks vote authority before persistence and never moderates a negative vote", async () => {
    const calls: string[] = [];
    let moderationCalls = 0;
    const store = fakeStore({
      resolvePost: ({ postId }) => Effect.succeed({ communityId: "community_1", postId }),
      replayCastPostVote: () => {
        calls.push("replay");
        return Effect.succeed(null);
      },
      checkVoteAuthority: () => {
        calls.push("authority");
        return Effect.succeed(undefined);
      },
      castPostVote: ({ body, requestHash }) => {
        calls.push(`persist:${body.value}:${requestHash.length}`);
        return Effect.succeed({ post_id: "post_1", value: body.value });
      },
    });
    const result = await run(
      castPostVote(
        {
          postId: "post_1",
          actor,
          body: { idempotency_key: "negative-vote", value: -1 },
        },
        {
          contentStore: store,
          textModeration: {
            evaluate: () => {
              moderationCalls += 1;
              return Effect.die("vote moderation must stay disconnected");
            },
          },
        },
      ),
    );
    expect(result).toMatchObject({ _tag: "Success", value: { post_id: "post_1", value: -1 } });
    expect(calls).toEqual(["replay", "authority", "persist:-1:64"]);
    expect(moderationCalls).toBe(0);

    let persistenceCalls = 0;
    const denied = await run(
      castPostVote(
        {
          postId: "post_1",
          actor,
          body: { idempotency_key: "denied-vote", value: 1 },
        },
        {
          contentStore: fakeStore({
            resolvePost: ({ postId }) => Effect.succeed({ communityId: "community_1", postId }),
            checkVoteAuthority: () =>
              Effect.fail(
                new ContentRepositoryError({
                  operation: "cast-vote",
                  reason: "membership-required",
                }),
              ),
            castPostVote: () => {
              persistenceCalls += 1;
              return Effect.succeed({ post_id: "post_1", value: 1 });
            },
          }),
        },
      ),
    );
    expect(failureOf(denied)).toMatchObject({ _tag: "MembershipRequired" });
    expect(persistenceCalls).toBe(0);
  });

  test("returns stored vote replays and conflicts before current authority", async () => {
    let authorityCalls = 0;
    let persistenceCalls = 0;
    const replayed = await run(
      castPostVote(
        {
          postId: "post_1",
          actor,
          body: { idempotency_key: "replay-key", value: 1 },
        },
        {
          contentStore: fakeStore({
            resolvePost: ({ postId }) => Effect.succeed({ communityId: "community_1", postId }),
            replayCastPostVote: () => Effect.succeed({ post_id: "post_1", value: 1 as const }),
            checkVoteAuthority: () => {
              authorityCalls += 1;
              return Effect.fail(
                new ContentRepositoryError({
                  operation: "cast-vote",
                  reason: "membership-required",
                }),
              );
            },
            castPostVote: () => {
              persistenceCalls += 1;
              return Effect.succeed({ post_id: "post_1", value: 1 as const });
            },
          }),
        },
      ),
    );
    expect(replayed).toMatchObject({
      _tag: "Success",
      value: { post_id: "post_1", value: 1 },
    });

    const conflict = await run(
      castPostVote(
        {
          postId: "post_1",
          actor,
          body: { idempotency_key: "replay-key", value: -1 },
        },
        {
          contentStore: fakeStore({
            resolvePost: ({ postId }) => Effect.succeed({ communityId: "community_1", postId }),
            replayCastPostVote: () =>
              Effect.fail(
                new ContentRepositoryError({
                  operation: "cast-vote",
                  reason: "idempotency-conflict",
                  actionId: "vote_action_existing",
                }),
              ),
            checkVoteAuthority: () => {
              authorityCalls += 1;
              return Effect.succeed(undefined);
            },
          }),
        },
      ),
    );
    expect(failureOf(conflict)).toMatchObject({
      _tag: "PostVoteIdempotencyConflict",
      details: {
        reason_code: "idempotency_conflict",
        action_id: "vote_action_existing",
      },
    });
    expect(authorityCalls).toBe(0);
    expect(persistenceCalls).toBe(0);
  });

  test("rejects missing keys and legacy ALTCHA fields before vote authority checks", async () => {
    let authorityCalls = 0;
    const store = fakeStore({
      resolvePost: ({ postId }) => Effect.succeed({ communityId: "community_1", postId }),
      checkVoteAuthority: () => {
        authorityCalls += 1;
        return Effect.succeed(undefined);
      },
    });
    const cast = await run(
      castPostVote(
        { postId: "post_1", actor, body: { value: 1, altcha: "legacy" } },
        { contentStore: store },
      ),
    );
    const clear = await run(
      clearPostVote(
        {
          postId: "post_1",
          actor,
          body: { idempotency_key: "clear-key", altcha: "legacy" },
        },
        { contentStore: store },
      ),
    );
    expect(failureOf(cast)).toMatchObject({ _tag: "BadRequest" });
    expect(failureOf(clear)).toMatchObject({ _tag: "BadRequest" });
    expect(authorityCalls).toBe(0);
  });

  test("maps malformed repository rows to InternalError", async () => {
    const result = await run(
      getPost(
        { postId: "post_1", viewer: actor },
        {
          contentStore: fakeStore({
            resolvePost: () => Effect.succeed({ communityId: "community_1", postId: "post_1" }),
            getPost: () =>
              Effect.fail(
                new ContentRepositoryError({ operation: "get-post", reason: "invalid-row" }),
              ),
          }),
        },
      ),
    );
    expect(failureOf(result)).toBeInstanceOf(InternalError);
  });
});
