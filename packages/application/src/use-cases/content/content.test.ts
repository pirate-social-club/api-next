import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import type { ContentStore } from "../../ports.ts";
import { castPostVote } from "./cast-post-vote.ts";
import { createCommentReply } from "./create-comment-reply.ts";
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
    createCommentReply: () => Effect.succeed({}),
    castPostVote: () => Effect.succeed({ post: "post_1", value: 1 as const }),
    clearPostVote: () => Effect.succeed({ post: "post_1", value: null }),
  } as unknown as ContentStore["Service"];
  return { ...base, ...overrides };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

describe("M2 content use cases", () => {
  test("hashes the decoded request canonically and forwards processing state", async () => {
    const hashes: string[] = [];
    const store = fakeStore({
      createPost: (input) => {
        hashes.push(input.idempotencyBodyHash);
        return Effect.succeed(fakeDocument);
      },
    });
    const first = await run(
      createPost(
        {
          communityId: "community_1",
          actor,
          body: { post_type: "text", idempotency_key: "key_1", body: "hello" },
        },
        { contentStore: store },
      ),
    );
    const second = await run(
      createPost(
        {
          communityId: "community_1",
          actor,
          body: { body: "hello", idempotency_key: "key_1", post_type: "text" },
        },
        { contentStore: store },
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
      createPost({ communityId: "community_1", actor, body }, { contentStore: fakeStore() }),
    );
    expect(Exit.isFailure(result) ? result.cause : undefined).toBeDefined();
    expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
  });

  test("rejects delegated actors before content persistence", async () => {
    const result = await run(
      createPost(
        {
          communityId: "community_1",
          actor: { userId: "usr_agent_owner", kind: "agent" },
          body: { post_type: "text", idempotency_key: "k", body: "hello" },
        },
        { contentStore: fakeStore() },
      ),
    );
    expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
  });

  test("resolves the parent comment globally before creating a body-only reply", async () => {
    const calls: string[] = [];
    const store = fakeStore({
      resolveComment: ({ commentId }) => {
        calls.push(`resolve:${commentId}`);
        return Effect.succeed({ communityId: "community_1", postId: "post_1", commentId });
      },
      createCommentReply: (input) => {
        calls.push(`create:${input.communityId}/${input.postId}/${input.parentCommentId}`);
        return Effect.succeed({} as never);
      },
    });
    const result = await run(
      createCommentReply(
        {
          parentCommentId: "comment_1",
          actor,
          body: { body: "reply", authorship_mode: "human_direct", identity_mode: "public" },
        },
        { contentStore: store },
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(calls).toEqual(["resolve:comment_1", "create:community_1/post_1/comment_1"]);
  });

  test("rejects rich or anonymous replies before resolving a parent", async () => {
    const resolveComment = () => Effect.succeed({ communityId: "c", postId: "p", commentId: "x" });
    const store = fakeStore({ resolveComment });
    for (const body of [
      { body: "reply", identity_mode: "anonymous" },
      { body: "reply", media_refs: [{ ref: "m" }] },
      { body: null },
    ]) {
      const result = await run(
        createCommentReply({ parentCommentId: "comment_1", actor, body }, { contentStore: store }),
      );
      expect(failureOf(result)).toMatchObject({ _tag: "BadRequest" });
    }
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
      castPostVote: ({ communityId, postId }) => {
        calls.push(`vote:${communityId}/${postId}`);
        return Effect.succeed({ post: postId, value: 1 as const });
      },
    });
    const read = await run(getPost({ postId: "post_1", viewer: actor }, { contentStore: store }));
    const vote = await run(
      castPostVote({ postId: "post_1", actor, body: { value: 1 } }, { contentStore: store }),
    );
    expect(Exit.isSuccess(read)).toBe(true);
    expect(Exit.isSuccess(vote)).toBe(true);
    expect(calls).toEqual([
      "resolve:post_1",
      "get:community_1/post_1",
      "resolve:post_1",
      "vote:community_1/post_1",
    ]);

    const missing = await run(
      getPost({ postId: "post_missing", viewer: actor }, { contentStore: fakeStore() }),
    );
    expect(failureOf(missing)).toMatchObject({ _tag: "NotFound" });
  });
});
