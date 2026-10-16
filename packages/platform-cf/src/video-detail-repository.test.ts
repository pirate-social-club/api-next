import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import {
  InternalError,
  NotFound,
  PublicPostRouteResultV1,
  VideoPostDetailPathV1,
  videoPostDetailPath,
} from "@pirate/contracts";
import { Effect, Layer, Schema } from "effect";
import {
  getPublicPostBySlug,
  getPublicPostCanonicalRouteById,
  type PublicPostRouteServices,
} from "../../application/src/use-cases/content/public-post-routes.ts";
import { makeControlPlaneVideoDetailStore } from "./video-detail-repository.ts";

const contentRow = () => ({
  detail_kind: "content",
  post_id: "post-video",
  post_row: {
    post_id: "post-video",
    community_id: "community",
    author_user_id: null,
    author_persona: null,
    post_type: "video",
    status: "published",
    visibility: "public",
    created_at: "2026-10-16T00:00:00Z",
    comments_locked: false,
    title: null,
    body: null,
    content_rating: "general",
    video_caption: null,
  },
  video_row: {
    video_media_kind: "video",
    video_intent: "original_audio",
    video_caption: null,
    video_original_sound_id: "sound",
    video_origin_post_id: "post-video",
    video_origin_author_persona_id: null,
    video_stream_state: null,
    video_playback_ref: null,
    video_thumbnail_state: "pending",
    video_thumbnail_artifact_ref: "media://poster",
    video_data_registration_state: "pending",
  },
  engagement: {
    upvote_count: 0,
    downvote_count: 0,
    comment_count: 0,
    viewer_vote: null,
    viewer_is_author: false,
  },
});
function fixture(rows: readonly Record<string, unknown>[], failure?: ControlPlaneStatementFailed) {
  const statements: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (s) => {
    statements.push(s);
    return failure
      ? Effect.fail(failure)
      : Effect.succeed({ rows: rows as never, rowCount: rows.length });
  };
  const videoDetailStore = makeControlPlaneVideoDetailStore(
    Layer.succeed(ControlPlaneDb, {
      execute,
      withTransaction: () => {
        throw new Error("detail requires one statement, not sequential transaction calls");
      },
    }),
  );
  const services: PublicPostRouteServices = {
    videoDetailStore,
    publicPostRouteStore: {
      getBySlug: () => {
        throw new Error("no fallback after video lookup");
      },
      getCanonicalRouteByPostId: () => {
        throw new Error("no alias requirement for primary video");
      },
      listSitemap: () =>
        Effect.succeed({ object: "public_post_sitemap_page", items: [], next_cursor: null }),
    },
    contentStore: {
      getPost: () => {
        throw new Error("sequential video projection forbidden");
      },
    },
  };
  return { statements, services };
}
test("primary video and exact alias both consume the one-snapshot reader, never generic projection or ID fallback", async () => {
  for (const mode of ["post_id", "alias"] as const) {
    const f = fixture([contentRow()]);
    const result = await Effect.runPromise(
      mode === "post_id"
        ? getPublicPostCanonicalRouteById(
            { postId: "post-video", viewerUserId: "viewer" },
            f.services,
          )
        : getPublicPostBySlug({ slug: "post-video", viewerUserId: "viewer" }, f.services),
    );
    expect(result).toMatchObject({
      kind: "content",
      post_id: "post-video",
      route: null,
      content: {
        post: { author_persona: null, body: null },
        video: { soundtrack: { origin_author_persona_id: null }, playback: { status: "pending" } },
      },
    });
    expect(JSON.stringify(result)).not.toContain("author_user_id");
    expect(f.statements).toHaveLength(1);
    expect(f.statements[0]).toMatchObject({
      readonly: true,
      values: [mode, "post-video", "viewer"],
    });
    expect(result.kind === "content" && result.content.canonical_path).toBeUndefined();
  }
  const f = fixture([]);
  await expect(
    Effect.runPromise(getPublicPostBySlug({ slug: "post-video" }, f.services)),
  ).rejects.toBeInstanceOf(NotFound);
  expect(f.statements).toHaveLength(1);
});
test("non-age refusal wins without parsing denied content; wrapped detail age stays distinct from bare target age", async () => {
  for (const detail_kind of ["not_found", "age_locked"]) {
    const f = fixture([
      { detail_kind, post_row: "malformed", video_row: "private-invalid", engagement: null },
    ]);
    if (detail_kind === "not_found")
      await expect(
        Effect.runPromise(getPublicPostCanonicalRouteById({ postId: "post-video" }, f.services)),
      ).rejects.toBeInstanceOf(NotFound);
    else
      expect(
        await Effect.runPromise(
          getPublicPostCanonicalRouteById({ postId: "post-video" }, f.services),
        ),
      ).toEqual({
        kind: "age_locked",
        locked: {
          kind: "age_locked",
          content_rating: "adult_18",
          next_action: { kind: "verify_minimum_age", minimum_age: 18 },
        },
      });
    expect(f.statements).toHaveLength(1);
  }
});
test("otherwise eligible malformed/rebound projection is unavailable and preserves causes", async () => {
  for (const row of [
    { ...contentRow(), video_row: {} },
    { ...contentRow(), post_id: "another" },
  ]) {
    const f = fixture([row]);
    const error = await Effect.runPromise(
      Effect.flip(getPublicPostCanonicalRouteById({ postId: "post-video" }, f.services)),
    );
    expect(error).toBeInstanceOf(InternalError);
    expect(error).toHaveProperty("cause");
  }
  const cause = new ControlPlaneStatementFailed({
    label: "video-detail.snapshot.v1",
    sqlState: "57014",
    constraint: null,
    outcomeCertainty: "aborted",
  });
  const error = await Effect.runPromise(
    Effect.flip(
      getPublicPostCanonicalRouteById({ postId: "post-video" }, fixture([], cause).services),
    ),
  );
  expect(error).toBeInstanceOf(InternalError);
  expect(error).toMatchObject({ cause: { cause } });
});
test("owned video codec and generated result reject normalized targets and metadata leakage", () => {
  for (const id of [".", "..", "a/b", "a\\b", "a%2f", "a?x", "a#x", "a\u0000", " a", "\ud800"])
    expect(videoPostDetailPath(id)).toBeNull();
  const path = videoPostDetailPath("動画-é");
  expect(path).toBe(`/post/${encodeURIComponent("動画-é")}`);
  expect(Schema.decodeUnknownSync(VideoPostDetailPathV1)(path)).toBe(path);
  for (const path of ["/post/%2e%2e", "/post/a%2fb", "/post/a/b", "/posts/a"])
    expect(() => Schema.decodeUnknownSync(VideoPostDetailPathV1)(path)).toThrow();
  const content = {
    video: {
      track: "video",
      caption: null,
      caption_dir: null,
      caption_lang: null,
      soundtrack: {
        kind: "original_audio",
        original_sound_id: "sound",
        origin_video_post_id: "p",
        origin_author_persona_id: null,
      },
      playback: { status: "pending" },
      thumbnail: { status: "pending" },
      data_registration: "registration_pending",
      capabilities: { can_post_with_song: false },
    },
    post: {
      id: "p",
      object: "post",
      community: "c",
      authorship_mode: "human_direct",
      identity_mode: "public",
      post_type: "video",
      status: "published",
      visibility: "public",
      analysis_state: "pending",
      content_safety_state: "pending",
      age_gate_policy: "none",
      created: 1,
    },
    thread_snapshot: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    viewer_vote: null,
    viewer_reaction_kinds: [],
    resolved_locale: "en",
    translation_state: "policy_blocked",
    machine_translated: false,
    source_hash: null,
  };
  const decode = Schema.decodeUnknownSync(PublicPostRouteResultV1);
  expect(decode({ kind: "content", post_id: "p", content, route: null })).toMatchObject({
    route: null,
  });
  expect(() =>
    decode({
      kind: "content",
      post_id: "p",
      content: { ...content, canonical_path: "/posts/p" },
      route: null,
    }),
  ).toThrow();
  expect(() =>
    decode({
      kind: "content",
      post_id: "p",
      content,
      route: {
        canonical_path: "/posts/p",
        activity_paths: {
          study: "/posts/p/study",
          karaoke: "/posts/p/karaoke",
          karaoke_leaderboard: "/posts/p/karaoke/leaderboard",
        },
      },
    }),
  ).toThrow();
});
