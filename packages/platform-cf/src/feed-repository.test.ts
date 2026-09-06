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
  actor_account_id: "usr_author",
  author_persona: {
    persona_id: "persona_author",
    object: "persona",
    display_name: "Author",
    avatar_ref: null,
    primary_public_handle: "author.pirate",
  },
  post_type: "text",
  visibility: "public",
  title: null,
  body: `post ${index}`,
  content_rating: "general",
  canonical_slug: null,
  rating_view_allowed: true,
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
  test.each([null, "not_started", "bound"])(
    "returns private-evidence-free pending video with ingest state %j",
    async (streamState) => {
      const calls: ControlPlaneStatement[] = [];
      const repository = makeControlPlaneFeedRepository();
      const output = await Effect.runPromise(
        repository.listHome({ query: {}, viewerUserId: "usr_viewer" }).pipe(
          Effect.provideService(
            ControlPlaneDb,
            fakeDb(
              () => [
                feedRow(0, {
                  post_type: "video",
                  body: "must use typed caption",
                  video_media_kind: "video",
                  video_intent: "original_audio",
                  video_caption: "A video caption",
                  video_original_sound_id: "original-sound-1",
                  video_origin_post_id: "post_0",
                  video_origin_author_persona_id: "persona_author",
                  video_stream_state: streamState,
                  video_playback_ref: streamState === "bound" ? "stream-video-1" : null,
                  video_thumbnail_state: "ready",
                  video_thumbnail_artifact_ref: "media://thumbnail/video-1",
                  video_data_registration_state: "registered",
                  fingerprint: "private-fingerprint",
                  rights_review: "private-review",
                  ownership: "private-owner",
                  moderator: "private-moderator",
                  override: "private-override",
                  extracted_audio_ref: "private-extraction",
                  canonical_sha256: "f".repeat(64),
                  retention_policy_revision: 1,
                }),
              ],
              calls,
            ),
          ),
        ),
      );

      expect(output.items[0]).toMatchObject({
        post: {
          post: { post_type: "video", body: null, caption: "A video caption" },
          video: {
            track: "video",
            soundtrack: {
              kind: "original_audio",
              original_sound_id: "original-sound-1",
              origin_video_post_id: "post_0",
              origin_author_persona_id: "persona_author",
            },
            playback: { status: "pending" },
            thumbnail: { status: "ready", artifact_ref: "media://thumbnail/video-1" },
            data_registration: "registered",
          },
        },
      });
      const encoded = JSON.stringify(output.items[0]);
      expect(encoded).not.toContain("retention_policy_revision");
      for (const privateValue of [
        "private-fingerprint",
        "private-review",
        "private-owner",
        "private-moderator",
        "private-override",
        "private-extraction",
        "f".repeat(64),
      ]) {
        expect(encoded).not.toContain(privateValue);
      }
      expect(calls[0]?.text).toContain("video_projection.media_kind");
      expect(calls[0]?.text).not.toContain("extracted_audio_ref");
      expect(() => Schema.decodeUnknownSync(GetPublicHomeFeed.response)(output)).not.toThrow();
    },
  );

  test("age-locks an adult video before projecting media or attribution", async () => {
    const repository = makeControlPlaneFeedRepository();
    const output = await Effect.runPromise(
      repository.listHome({ query: {} }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(
            () => [
              feedRow(0, {
                post_type: "video",
                content_rating: "adult_18",
                rating_view_allowed: false,
                video_original_sound_id: "must-not-leak",
              }),
            ],
            [],
          ),
        ),
      ),
    );

    expect(output.items).toEqual([
      {
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      },
    ]);
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
  });

  test("replaces a locked text row with the metadata-free age placeholder", async () => {
    const repository = makeControlPlaneFeedRepository();
    const output = await Effect.runPromise(
      repository.listHome({ query: {} }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(
            () => [
              feedRow(0, {
                content_rating: "adult_18",
                rating_view_allowed: false,
                title: "must not leak",
                body: "must not leak",
                upvote_count: "99",
              }),
            ],
            [],
          ),
        ),
      ),
    );

    expect(output.items).toEqual([
      {
        kind: "age_locked",
        content_rating: "adult_18",
        next_action: { kind: "verify_minimum_age", minimum_age: 18 },
      },
    ]);
    expect(output.top_communities).toEqual([]);
    expect(Object.keys(output.items[0] ?? {}).sort()).toEqual([
      "content_rating",
      "kind",
      "next_action",
    ]);
  });

  test("returns the real adult-rated row when the viewer capability allows it", async () => {
    const repository = makeControlPlaneFeedRepository();
    const output = await Effect.runPromise(
      repository.listHome({ query: {} }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(
            () => [
              feedRow(0, {
                content_rating: "adult_18",
                rating_view_allowed: true,
              }),
            ],
            [],
          ),
        ),
      ),
    );

    expect(output.items[0]).toMatchObject({
      post: { post: { id: "post_0", body: "post 0" } },
    });
    expect(output.items[0]).not.toHaveProperty("post.canonical_path");
  });

  test("attaches canonical paths only to public general feed content", async () => {
    const repository = makeControlPlaneFeedRepository();
    const publicOutput = await Effect.runPromise(
      repository.listHome({ query: {} }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(() => [feedRow(0, { canonical_slug: "你好-world" })], []),
        ),
      ),
    );
    expect(publicOutput.items[0]).toMatchObject({
      post: { canonical_path: "/posts/%E4%BD%A0%E5%A5%BD-world" },
    });

    const memberOutput = await Effect.runPromise(
      repository.listHome({ query: {}, viewerUserId: "member-1" }).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb(
            () => [feedRow(0, { canonical_slug: "hidden-title", visibility: "members_only" })],
            [],
          ),
        ),
      ),
    );
    expect(memberOutput.items[0]).not.toHaveProperty("post.canonical_path");
  });

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
              author_persona: {
                persona_id: "persona_author",
                object: "persona",
                display_name: "Author",
                avatar_ref: null,
                primary_public_handle: "author.pirate",
              },
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
            translation_state: "policy_blocked",
            machine_translated: false,
            source_hash: null,
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

    expect(output.items[0]).toMatchObject({
      post: { viewer_vote: 1, viewer_is_author: true },
    });
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

    expect(output.items[0]).toMatchObject({ post: { post: { created: 1_760_000_000 } } });
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
