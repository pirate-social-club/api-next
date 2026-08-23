import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { makeControlPlaneContentRepository } from "./content-repository";

type Row = Readonly<Record<string, unknown>>;

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
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
    if (statement.label === "content.communities.require-active-community-effect") {
      return Effect.succeed({
        rows: [{ allowed: true }] as unknown as readonly R[],
        rowCount: 1,
      });
    }
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
const validCounts = [
  {
    vote_row_count: 0,
    distinct_voter_count: 0,
    null_voter_count: 0,
    invalid_vote_count: 0,
    upvote_count: 0,
    downvote_count: 0,
    stored_upvote_count: 0,
    stored_downvote_count: 0,
    comment_count: 0,
  },
];

describe("M2 content repository row and lock defenses", () => {
  const requestHash = "a".repeat(64);
  test.each([
    ["comments_locked", { ...validPost, comments_locked: "false" }, validCounts, []],
    ["counts", validPost, [{ ...validCounts[0], upvote_count: -1 }], []],
    ["numeric-string count", validPost, [{ ...validCounts[0], upvote_count: "0" }], []],
    ["invalid aggregate vote", validPost, [{ ...validCounts[0], invalid_vote_count: 1 }], []],
    [
      "duplicate voters",
      validPost,
      [{ ...validCounts[0], vote_row_count: 2, distinct_voter_count: 1 }],
      [],
    ],
    ["inconsistent vote aggregates", validPost, [{ ...validCounts[0], vote_row_count: 1 }], []],
    ["viewer vote", validPost, validCounts, [{ vote_value: 0 }]],
    ["numeric-string viewer vote", validPost, validCounts, [{ vote_value: "1" }]],
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

  test("returns stored vote counters and surfaces valid live aggregate drift", async () => {
    const fake = fakeDb([
      [resolvedPost],
      [validPost],
      [
        {
          ...validCounts[0],
          vote_row_count: 1,
          distinct_voter_count: 1,
          upvote_count: 1,
          stored_upvote_count: 9,
          stored_downvote_count: 8,
        },
      ],
      [{ vote_value: 1 }],
    ]);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...input: unknown[]) => warnings.push(input);
    try {
      const result = await runWith(
        makeControlPlaneContentRepository().getPost({
          communityId: "community_1",
          postId: "post_1",
          viewerUserId: "usr_alice",
        }),
        fake.db,
      );
      expect(result).toMatchObject({
        _tag: "Success",
        value: { upvote_count: 9, downvote_count: 8, viewer_vote: 1 },
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      [
        "content_vote_aggregate_drift",
        {
          community_id: "community_1",
          post_id: "post_1",
          stored_upvote_count: 9,
          stored_downvote_count: 8,
          live_upvote_count: 1,
          live_downvote_count: 0,
        },
      ],
    ]);
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

  test("rejects orphan posts and comments as invalid rows", async () => {
    const repository = makeControlPlaneContentRepository();
    const orphanPost = await runWith(
      repository.resolvePost({ postId: "post_1" }),
      fakeDb([
        [
          {
            community_id: "community_1",
            post_id: "post_1",
            status: "published",
            community_status: null,
          },
        ],
      ]).db,
    );
    expect(failureOf(orphanPost)).toMatchObject({
      operation: "resolve-post",
      reason: "invalid-row",
    });

    const orphanComment = await runWith(
      repository.resolveComment({ commentId: "comment_1" }),
      fakeDb([
        [
          {
            community_id: "community_1",
            post_id: "post_1",
            comment_id: "comment_1",
            status: "published",
            community_status: null,
          },
        ],
      ]).db,
    );
    expect(failureOf(orphanComment)).toMatchObject({
      operation: "resolve-comment",
      reason: "invalid-row",
    });
  });

  test("locks membership and authoritative post state before a vote", async () => {
    const fake = fakeDb([
      [],
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [resolvedPost],
      [{ ...validPost }],
      [],
      [],
      [{ post_id: "post_1", vote_value: 1 }],
      [{ upvote_count: 1, downvote_count: 0 }],
      [
        {
          action_id: "vote_action_1",
          community_id: "community_1",
          post_id: "post_1",
          actor_user_id: "usr_alice",
          endpoint_template: "/posts/:postId/vote",
          idempotency_key: "vote-key",
          request_hash: requestHash,
          result_value: 1,
        },
      ],
    ]);
    const repository = makeControlPlaneContentRepository();
    const result = await runWith(
      repository.castPostVote({
        communityId: "community_1",
        postId: "post_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { idempotency_key: "vote-key", value: 1 },
        requestHash,
      }),
      fake.db,
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(fake.transactionCount).toBe(1);
    expect(fake.calls.map((call) => call.label)).toEqual([
      "content.post-vote-actions.lock",
      "content.communities.lock-active",
      "content.community-memberships.lock-active",
      "content.posts.resolve-global",
      "content.posts.state",
      "content.communities.require-active-community-effect",
      "content.post-vote-actions.lock",
      "content.post-votes.lock-actor",
      "content.post-votes.upsert",
      "content.posts.repair-vote-aggregates",
      "content.post-vote-actions.insert",
    ]);
    expect(fake.calls[0]).toMatchObject({ readonly: false });
    expect(fake.calls[0]?.text).toContain("FOR UPDATE");
    expect(fake.calls[1]).toMatchObject({ readonly: false });
    expect(fake.calls[1]?.text).toContain("FOR UPDATE");
    expect(fake.calls[2]).toMatchObject({ readonly: false });
    expect(fake.calls[2]?.text).toContain("FOR UPDATE");
    expect(fake.calls[4]).toMatchObject({ readonly: false });
    expect(fake.calls[4]?.text).toContain("FOR UPDATE");
  });

  test.each([
    ["malformed vote value", { vote_value: "1" }],
    ["malformed vote id", { post_vote_id: "" }],
  ])("rejects %s before changing an actor vote", async (_label, vote) => {
    const fake = fakeDb([
      [],
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [resolvedPost],
      [{ ...validPost }],
      [],
      [
        {
          community_id: "community_1",
          post_vote_id: "vote_1",
          post_id: "post_1",
          user_id: "usr_alice",
          vote_value: 1,
          ...vote,
        },
      ],
    ]);
    const result = await runWith(
      makeControlPlaneContentRepository().castPostVote({
        communityId: "community_1",
        postId: "post_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { idempotency_key: "vote-key", value: 1 },
        requestHash,
      }),
      fake.db,
    );
    expect(failureOf(result)).toMatchObject({ operation: "cast-vote", reason: "invalid-row" });
    expect(fake.calls.map((call) => call.label)).not.toContain("content.post-votes.upsert");
  });

  test("locks and validates an existing actor vote before clearing it", async () => {
    const fake = fakeDb([
      [],
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [resolvedPost],
      [{ ...validPost }],
      [],
      [
        {
          community_id: "community_1",
          post_vote_id: "vote_1",
          post_id: "post_1",
          user_id: "usr_alice",
          vote_value: 1,
        },
      ],
      [],
      [{ upvote_count: 0, downvote_count: 0 }],
      [
        {
          action_id: "vote_action_2",
          community_id: "community_1",
          post_id: "post_1",
          actor_user_id: "usr_alice",
          endpoint_template: "/posts/:postId/clear_vote",
          idempotency_key: "clear-key",
          request_hash: requestHash,
          result_value: 0,
        },
      ],
    ]);
    const result = await runWith(
      makeControlPlaneContentRepository().clearPostVote({
        communityId: "community_1",
        postId: "post_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { idempotency_key: "clear-key" },
        requestHash,
      }),
      fake.db,
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(fake.calls.map((call) => call.label)).toEqual([
      "content.post-vote-actions.lock",
      "content.communities.lock-active",
      "content.community-memberships.lock-active",
      "content.posts.resolve-global",
      "content.posts.state",
      "content.communities.require-active-community-effect",
      "content.post-vote-actions.lock",
      "content.post-votes.lock-actor",
      "content.post-votes.clear",
      "content.posts.repair-vote-aggregates",
      "content.post-vote-actions.insert",
    ]);
    expect(fake.calls[6]?.text).toContain("FOR UPDATE");
  });

  test.each([
    ["community", { community_id: "community_other" }],
    ["post", { post_id: "post_other" }],
    ["user", { user_id: "usr_bob" }],
  ])("rejects an actor vote with a mismatched %s identity", async (_label, mismatch) => {
    for (const operation of ["cast", "clear"] as const) {
      const fake = fakeDb([
        [],
        [{ community_id: "community_1", status: "active" }],
        [{ status: "member" }],
        [resolvedPost],
        [{ ...validPost }],
        [],
        [
          {
            community_id: "community_1",
            post_vote_id: "vote_1",
            post_id: "post_1",
            user_id: "usr_alice",
            vote_value: 1,
            ...mismatch,
          },
        ],
      ]);
      const result =
        operation === "cast"
          ? await runWith(
              makeControlPlaneContentRepository().castPostVote({
                communityId: "community_1",
                postId: "post_1",
                actor: { userId: "usr_alice", kind: "user" },
                body: { idempotency_key: "vote-key", value: 1 },
                requestHash,
              }),
              fake.db,
            )
          : await runWith(
              makeControlPlaneContentRepository().clearPostVote({
                communityId: "community_1",
                postId: "post_1",
                actor: { userId: "usr_alice", kind: "user" },
                body: { idempotency_key: "clear-key" },
                requestHash,
              }),
              fake.db,
            );
      expect(failureOf(result)).toMatchObject({
        operation: operation === "cast" ? "cast-vote" : "clear-vote",
        reason: "invalid-row",
      });
      expect(fake.calls.map((call) => call.label)).not.toContain(
        operation === "cast" ? "content.post-votes.upsert" : "content.post-votes.clear",
      );
    }
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
  });

  test("treats malformed persisted post hashes as invalid rows", async () => {
    const fake = fakeDb([
      [{ community_id: "community_1", status: "active" }],
      [{ status: "member" }],
      [
        {
          community_id: "community_1",
          post_id: "post_existing",
          author_user_id: "usr_alice",
          post_type: "text",
          status: "processing",
          visibility: "public",
          title: null,
          body: "hello",
          idempotency_key: "post-key",
          idempotency_body_hash: "A".repeat(64),
          comments_locked: false,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    ]);
    const result = await runWith(
      makeControlPlaneContentRepository().createPost({
        communityId: "community_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { post_type: "text", idempotency_key: "post-key", body: "hello" },
        idempotencyBodyHash: "a".repeat(64),
      }),
      fake.db,
    );
    expect(failureOf(result)).toMatchObject({ operation: "create-post", reason: "invalid-row" });
  });

  test("requires a lowercase hash for keyed writes", async () => {
    const repository = makeControlPlaneContentRepository();
    const postResult = await runWith(
      repository.createPost({
        communityId: "community_1",
        actor: { userId: "usr_alice", kind: "user" },
        body: { post_type: "text", idempotency_key: "post-key", body: "hello" },
        idempotencyBodyHash: "A".repeat(64),
      }),
      fakeDb([]).db,
    );
    expect(failureOf(postResult)).toMatchObject({ operation: "create-post", reason: "constraint" });
  });
});
