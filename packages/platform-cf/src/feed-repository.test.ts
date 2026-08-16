import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
  FeedRepositoryError,
} from "@pirate/application";
import { GetPublicHomeFeed } from "@pirate/contracts";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { makeControlPlaneFeedRepository } from "./feed-repository.ts";

const feedRow = (index = 0, overrides: Record<string, unknown> = {}) => ({
  feed_item_id: `feed_${index}`,
  rank_score: 100 - index,
  projected_at: new Date("2026-08-17T10:00:00.000Z"),
  community_id: "com_alpha",
  post_id: `post_${index}`,
  author_user_id: "usr_author",
  post_type: "text",
  visibility: "public",
  title: null,
  body: `post ${index}`,
  comments_locked: false,
  created_at: new Date(1_760_000_000_000 - index * 1_000),
  display_name: "Alpha",
  member_count: "2",
  follower_count: "3",
  upvote_count: "4",
  downvote_count: "1",
  comment_count: "5",
  viewer_vote: null,
  ...overrides,
});

function fakeDb(
  rowsFor: (statement: ControlPlaneStatement) => readonly Record<string, unknown>[],
  calls: ControlPlaneStatement[],
): ControlPlaneDb["Service"] {
  const execute = <Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, never> => {
    calls.push(statement);
    const rows = rowsFor(statement);
    return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
  };
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected typed failure");
  return failure.success;
}

describe("home feed Postgres repository", () => {
  test("maps only published projection rows into the conservative wire shape", async () => {
    const calls: ControlPlaneStatement[] = [];
    const repository = makeControlPlaneFeedRepository({ now: () => 1_760_000_000_000 });
    const output = await Effect.runPromise(
      repository.listHome({ query: { locale: "en", sort: "best" } }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => [feedRow()], calls),
        ),
      ),
    );

    expect(output).toEqual({
      items: [
        {
          community: {
            id: "com_alpha",
            object: "home_feed_community_summary",
            display_name: "Alpha",
            member_count: 2,
            follower_count: 3,
          },
          post: {
            post: {
              id: "post_0",
              object: "post",
              community: "com_alpha",
              author_user: "usr_author",
              author_public_handle: null,
              authorship_mode: "human_direct",
              agent: null,
              agent_ownership_record: null,
              identity_mode: "public",
              anonymous_scope: null,
              anonymous_label: null,
              post_type: "text",
              status: "published",
              comments_locked: false,
              visibility: "public",
              title: null,
              body: "post 0",
              analysis_state: "allow",
              content_safety_state: "safe",
              age_gate_policy: "none",
              created: 1_760_000_000,
            },
            thread_snapshot: null,
            upvote_count: 4,
            downvote_count: 1,
            like_count: 0,
            comment_count: 5,
            viewer_vote: null,
            viewer_is_author: false,
            viewer_reaction_kinds: [],
            resolved_locale: "en",
            translation_state: "same_language",
            machine_translated: false,
            source_hash: "",
          },
        },
      ],
      top_communities: [
        {
          id: "com_alpha",
          object: "home_feed_community_summary",
          display_name: "Alpha",
          member_count: 2,
          follower_count: 3,
        },
      ],
      next_cursor: null,
    });
    expect(() => Schema.decodeUnknownSync(GetPublicHomeFeed.response)(output)).not.toThrow();
    expect(calls[0]?.values).toEqual([null, null, null, null, null, 21]);
    expect(calls[0]?.text).toContain("p.status = 'published'");
    expect(calls[0]?.text).toContain("viewer_membership.status = 'member'");
    expect(calls[0]?.text).not.toContain("usr_author");
  });

  test("passes canonical viewer identity only as a SQL value for member visibility and votes", async () => {
    const calls: ControlPlaneStatement[] = [];
    const repository = makeControlPlaneFeedRepository();
    const output = await Effect.runPromise(
      repository.listHome({ query: {}, viewerUserId: "usr_author" }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => [feedRow(0, { visibility: "members_only", viewer_vote: 1 })], calls),
        ),
      ),
    );

    expect(output.items[0]?.post.viewer_vote).toBe(1);
    expect(output.items[0]?.post.viewer_is_author).toBe(true);
    expect(calls[0]?.values[0]).toBe("usr_author");
    expect(calls[0]?.text).not.toContain("usr_author");
  });

  test("normalizes numeric epoch milliseconds from alternate drivers", async () => {
    const repository = makeControlPlaneFeedRepository();
    const output = await Effect.runPromise(
      repository.listHome({ query: {} }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => [feedRow(0, { created_at: 1_760_000_000_000 })], []),
        ),
      ),
    );

    expect(output.items[0]?.post.post.created).toBe(1_760_000_000);
  });

  test("emits a query-bound keyset cursor and rejects reuse under another sort", async () => {
    const firstCalls: ControlPlaneStatement[] = [];
    const repository = makeControlPlaneFeedRepository({ now: () => 1_760_000_000_000 });
    const first = await Effect.runPromise(
      repository.listHome({ query: { sort: "best", time_range: "day" } }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => Array.from({ length: 21 }, (_, index) => feedRow(index)), firstCalls),
        ),
      ),
    );
    expect(first.items).toHaveLength(20);
    expect(first.next_cursor).toStartWith("hf1.");
    expect(firstCalls[0]?.values[1]).toBe(1_759_913_600);

    const secondCalls: ControlPlaneStatement[] = [];
    await Effect.runPromise(
      repository
        .listHome({
          query: { cursor: first.next_cursor ?? undefined, sort: "best", time_range: "day" },
        })
        .pipe(
          Effect.provideService(
            ControlPlaneDb,
            fakeDb(() => [], secondCalls),
          ),
        ),
    );
    expect(secondCalls[0]?.values.slice(2, 5)).toEqual([81, 1_759_999_981, "feed_19"]);
    expect(secondCalls[0]?.text).toContain("(h.rank_score, p.created_at, h.feed_item_id) <");

    const mismatch = await Effect.runPromiseExit(
      repository.listHome({ query: { cursor: first.next_cursor ?? undefined, sort: "new" } }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => [], []),
        ),
      ),
    );
    expect(failureOf(mismatch)).toEqual(
      new FeedRepositoryError({ operation: "list-home", reason: "invalid-cursor" }),
    );
  });

  test("fails closed on malformed persisted projection values", async () => {
    const repository = makeControlPlaneFeedRepository();
    const exit = await Effect.runPromiseExit(
      repository.listHome({ query: {} }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => [feedRow(0, { post_type: "future_type" })], []),
        ),
      ),
    );
    expect(failureOf(exit)).toEqual(
      new FeedRepositoryError({ operation: "list-home", reason: "invalid-row" }),
    );
  });
});
