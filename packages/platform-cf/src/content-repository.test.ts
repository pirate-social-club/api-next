import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { makeControlPlaneContentRepository } from "./content-repository";

type Row = Readonly<Record<string, unknown>>;

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

const fakeDb = (responses: readonly (readonly Row[])[]) => {
  const calls: ControlPlaneStatement[] = [];
  let responseIndex = 0;
  let transactionCount = 0;
  const execute = <R>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    const rows = responses[responseIndex++] ?? [];
    return Effect.succeed({ rows: rows as readonly R[], rowCount: rows.length });
  };
  const transaction = { execute };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) => {
      transactionCount += 1;
      return use(transaction);
    },
  };
  return {
    db,
    calls,
    get transactionCount() {
      return transactionCount;
    },
  };
};

const runWith = <A, E>(
  effect: Effect.Effect<A, E, ControlPlaneDb>,
  db: ControlPlaneDb["Service"],
) => Effect.runPromiseExit(Effect.provideService(effect, ControlPlaneDb, db));

const resolvedPost = {
  community_id: "community_1",
  post_id: "post_1",
  status: "published",
  community_status: "active",
};
const validPost = {
  community_id: "community_1",
  post_id: "post_1",
  author_user_id: "usr_alice",
  post_type: "text",
  status: "published",
  visibility: "public",
  comments_locked: false,
  created_at: new Date("2026-01-01T00:00:00Z"),
};
const validCounts = [{ upvote_count: 0, downvote_count: 0, comment_count: 0 }];

describe("M2 content repository row and lock defenses", () => {
  test.each([
    ["comments_locked", { ...validPost, comments_locked: "false" }, validCounts, []],
    ["counts", validPost, [{ upvote_count: -1, downvote_count: 0, comment_count: 0 }], []],
    ["viewer vote", validPost, validCounts, [{ vote_value: 0 }]],
  ])("maps malformed %s rows to invalid-row", async (_label, post, counts, viewerVote) => {
    const fake = fakeDb([[resolvedPost], [post], counts, viewerVote]);
    const repository = makeControlPlaneContentRepository();
    const result = await runWith(
      repository.getPost({
        communityId: "community_1",
        postId: "post_1",
        viewerUserId: "usr_alice",
      }),
      fake.db,
    );
    expect(failureOf(result)).toMatchObject({ operation: "get-post", reason: "invalid-row" });
  });

  test("normalizes numeric epoch milliseconds to Unix seconds", async () => {
    const fake = fakeDb([
      [resolvedPost],
      [{ ...validPost, created_at: 1_767_225_600_000 }],
      validCounts,
      [],
    ]);
    const repository = makeControlPlaneContentRepository();
    const result = await runWith(
      repository.getPost({
        communityId: "community_1",
        postId: "post_1",
        viewerUserId: "usr_alice",
      }),
      fake.db,
    );
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) expect(result.value?.post.created).toBe(1_767_225_600);
  });

  test("locks membership and authoritative post state before a vote", async () => {
    const fake = fakeDb([
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [resolvedPost],
      [{ ...validPost }],
      [{ post_id: "post_1", vote_value: 1 }],
    ]);
    const repository = makeControlPlaneContentRepository();
    const result = await runWith(
      repository.castPostVote({
        communityId: "community_1",
        postId: "post_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { value: 1 },
      }),
      fake.db,
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(fake.transactionCount).toBe(1);
    expect(fake.calls.map((call) => call.label)).toEqual([
      "content.communities.lock-active",
      "content.community-memberships.lock-active",
      "content.posts.resolve-global",
      "content.posts.state",
      "content.post-votes.upsert",
    ]);
    expect(fake.calls[0]).toMatchObject({ readonly: false });
    expect(fake.calls[0]?.text).toContain("FOR UPDATE");
    expect(fake.calls[1]).toMatchObject({ readonly: false });
    expect(fake.calls[1]?.text).toContain("FOR UPDATE");
    expect(fake.calls[3]).toMatchObject({ readonly: false });
    expect(fake.calls[3]?.text).toContain("FOR UPDATE");
  });

  test("locks the parent comment after the post before inserting a reply", async () => {
    const fake = fakeDb([
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [resolvedPost],
      [
        {
          community_id: "community_1",
          post_id: "post_1",
          comment_id: "comment_parent",
          status: "published",
          community_status: "active",
        },
      ],
      [
        {
          community_id: "community_1",
          post_id: "post_1",
          author_user_id: "usr_alice",
          status: "published",
          visibility: "public",
          comments_locked: false,
        },
      ],
      [
        {
          community_id: "community_1",
          comment_id: "comment_parent",
          post_id: "post_1",
          status: "published",
          depth: 0,
        },
      ],
      [],
      [
        {
          community_id: "community_1",
          comment_id: "comment_reply",
          post_id: "post_1",
          parent_comment_id: "comment_parent",
          author_user_id: "usr_alice",
          status: "published",
          body: "reply",
          idempotency_key: "reply-key",
          depth: 1,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    ]);
    const repository = makeControlPlaneContentRepository();
    const result = await runWith(
      repository.createCommentReply({
        communityId: "community_1",
        postId: "post_1",
        parentCommentId: "comment_parent",
        actor: { userId: "usr_alice", kind: "user" },
        body: { body: "reply", idempotency_key: "reply-key" },
        idempotencyBodyHash: "a".repeat(64),
      }),
      fake.db,
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(fake.calls.map((call) => call.label)).toEqual([
      "content.communities.lock-active",
      "content.community-memberships.lock-active",
      "content.posts.resolve-global",
      "content.comments.resolve-global",
      "content.posts.state",
      "content.comments.state",
      "content.comments.find-idempotency",
      "content.comments.insert",
    ]);
    expect(fake.calls[4]).toMatchObject({ readonly: false });
    expect(fake.calls[4]?.text).toContain("FOR UPDATE");
    expect(fake.calls[5]).toMatchObject({ readonly: false });
    expect(fake.calls[5]?.text).toContain("FOR UPDATE");
  });

  test("rejects malformed membership and parent depth instead of coercing state", async () => {
    const membershipFake = fakeDb([
      [{ community_id: "community_1", status: "active" }],
      [{ status: "unknown" }],
    ]);
    const repository = makeControlPlaneContentRepository();
    const membershipResult = await runWith(
      repository.createPost({
        communityId: "community_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { post_type: "text", idempotency_key: "post-key", body: "hello" },
        idempotencyBodyHash: "a".repeat(64),
      }),
      membershipFake.db,
    );
    expect(failureOf(membershipResult)).toMatchObject({
      operation: "create-post",
      reason: "invalid-row",
    });

    const depthFake = fakeDb([
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [resolvedPost],
      [
        {
          community_id: "community_1",
          post_id: "post_1",
          comment_id: "comment_parent",
          status: "published",
          community_status: "active",
        },
      ],
      [
        {
          community_id: "community_1",
          post_id: "post_1",
          author_user_id: "usr_alice",
          status: "published",
          visibility: "public",
          comments_locked: false,
        },
      ],
      [
        {
          community_id: "community_1",
          comment_id: "comment_parent",
          post_id: "post_1",
          status: "published",
          depth: -1,
        },
      ],
    ]);
    const depthResult = await runWith(
      repository.createCommentReply({
        communityId: "community_1",
        postId: "post_1",
        parentCommentId: "comment_parent",
        actor: { userId: "usr_alice", kind: "user" },
        body: { body: "reply" },
      }),
      depthFake.db,
    );
    expect(failureOf(depthResult)).toMatchObject({
      operation: "create-comment-reply",
      reason: "invalid-row",
    });
  });
});
