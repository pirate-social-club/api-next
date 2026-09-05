import { describe, expect, test } from "bun:test";
import { InternalError, NotFound, toErrorBody } from "@pirate/contracts";
import { Effect } from "effect";
import type { LocalizedPostDocument } from "../ports.ts";
import type { PublicPostLiveRecord } from "../use-cases/content/public-post-routes.ts";
import {
  getVideoPlaybackAccess,
  VIDEO_PLAYBACK_ACCESS_POLICY,
  type VideoPlaybackAccessServices,
} from "./playback-access.ts";
import { getVideoPosterAccess } from "./poster-access.ts";

function fixture() {
  let live: PublicPostLiveRecord | null = {
    alias: { slug: "video", postId: "post-1" },
    post: {
      postId: "post-1",
      communityId: "community-1",
      status: "published",
      postType: "video",
      visibility: "public",
      contentRating: "general",
    },
    community: { communityId: "community-1", status: "active" },
    viewer: { userId: undefined, isMember: false, ratingViewAllowed: true, canRead: true },
    canonicalPath: "/posts/video",
  };
  let projected = {
    post: {
      id: "post-1",
      object: "post",
      community: "community-1",
      author_persona: null,
      authorship_mode: "human_direct",
      identity_mode: "public",
      post_type: "video",
      status: "published",
      visibility: "public",
      comments_locked: false,
      title: null,
      body: null,
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
      created: 1,
    },
    video: {
      track: "video",
      caption: null,
      caption_dir: null,
      caption_lang: null,
      soundtrack: {
        kind: "original_audio",
        original_sound_id: "sound-1",
        origin_video_post_id: "post-1",
        origin_author_persona_id: "persona-1",
      },
      playback: { status: "ready", provider: "stream", playback_ref: "opaque-playback-1" },
      thumbnail: { status: "ready", artifact_ref: "poster-1" },
      data_registration: "registration_pending",
      capabilities: { can_post_with_song: false },
    },
    thread_snapshot: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    comment_count: 0,
    viewer_vote: null,
    viewer_reaction_kinds: [],
    resolved_locale: "en",
    translation_state: "policy_blocked",
    machine_translated: false,
    source_hash: null,
  } as LocalizedPostDocument;
  let now = 1_000_000;
  let allowed = true;
  const signed: { providerVideoId: string; expiresAtSeconds: number }[] = [];
  const limits: unknown[] = [];
  const viewers: (string | undefined)[] = [];
  const services: VideoPlaybackAccessServices = {
    authorizePublication: () => Effect.succeed(true),
    customerHost: "customer-fixture.cloudflarestream.com",
    nowMs: Effect.sync(() => now),
    contentStore: {
      resolvePost: () =>
        Effect.sync(() =>
          live ? { communityId: live.post.communityId, postId: live.post.postId } : null,
        ),
      getPost: (input) =>
        Effect.sync(() => {
          viewers.push(input.viewerUserId);
          if (
            live?.community.status !== "active" ||
            !live.viewer.canRead ||
            (live.post.visibility === "members_only" && !live.viewer.isMember) ||
            (live.post.contentRating === "adult_18" && !live.viewer.ratingViewAllowed)
          )
            return null;
          return projected;
        }),
    },
    resolveApprovedPlayback: () => Effect.succeed({ providerVideoId: "stream-1" }),
    limit: (input) =>
      Effect.sync(() => {
        limits.push(input);
        return { allowed, retryAfterSeconds: 30 };
      }),
    sign: (input) =>
      Effect.sync(() => {
        signed.push(input);
        return "header.payload.signature";
      }),
  };
  const run = (override: Partial<VideoPlaybackAccessServices> = {}, viewerUserId?: string) =>
    Effect.runPromise(
      getVideoPlaybackAccess(
        {
          postId: "post-1",
          trustedSource: "trusted-edge-source",
          ...(viewerUserId ? { viewerUserId } : {}),
        },
        { ...services, ...override },
      ),
    );
  return {
    services,
    run,
    signed,
    limits,
    viewers,
    get live() {
      if (live === null) throw new Error("fixture live record required");
      return live;
    },
    get projected() {
      return projected;
    },
    setLive: (value: PublicPostLiveRecord | null) => {
      live = value;
    },
    setProjected: (value: LocalizedPostDocument) => {
      projected = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    denyLimit: () => {
      allowed = false;
    },
  };
}

describe("video playback access policy with fixture-only ready media", () => {
  test.each(["missing", "unreadable"])(
    "eligible viewer receives an honest %s artifact error, never a conditional success",
    async (failure) => {
      const f = fixture();
      const result = await Effect.runPromise(
        getVideoPosterAccess(
          { postId: "post-1", ifNoneMatch: '"same"' },
          {
            ...f.services,
            resolvePoster: () =>
              failure === "missing"
                ? Effect.succeed(null)
                : Effect.fail(new Error("private bucket locator must not escape")),
          },
        ),
      ).catch((error: unknown) => toErrorBody(error));
      expect(result).toEqual(
        toErrorBody(new InternalError({ message: "Video delivery unavailable" })),
      );
    },
  );
  test("eligible matching ETag yields 304 only after fresh approval", async () => {
    const f = fixture();
    const calls: string[] = [];
    const result = await Effect.runPromise(
      getVideoPosterAccess(
        { postId: "post-1", ifNoneMatch: 'W/"same"' },
        {
          ...f.services,
          authorizePublication: () =>
            Effect.sync(() => {
              calls.push("authorize");
              return true;
            }),
          resolvePoster: () =>
            Effect.sync(() => {
              calls.push("resolve");
              return { artifactRef: "poster-1", etag: '"same"' };
            }),
        },
      ),
    );
    expect(calls).toEqual(["authorize", "resolve"]);
    expect(result.status).toBe(304);
    expect(result.cacheControl).toBe("private, no-cache");
  });
  test.each(["missing", "age", "moderation", "membership", "visibility"])(
    "poster matching ETag and playback have identical %s denial",
    async (reason) => {
      const f = fixture();
      if (reason === "missing") f.setLive(null);
      if (reason === "age")
        f.setLive({
          ...f.live,
          post: { ...f.live.post, contentRating: "adult_18" },
          viewer: { ...f.live.viewer, ratingViewAllowed: false },
        });
      if (reason === "membership")
        f.setLive({ ...f.live, post: { ...f.live.post, visibility: "members_only" } });
      if (reason === "visibility")
        f.setLive({ ...f.live, viewer: { ...f.live.viewer, canRead: false } });
      const authorizePublication = () => Effect.succeed(reason !== "moderation");
      let posterReads = 0;
      const poster = Effect.runPromise(
        getVideoPosterAccess(
          { postId: "post-1", ifNoneMatch: '"same"' },
          {
            ...f.services,
            authorizePublication,
            resolvePoster: () => {
              posterReads++;
              return Effect.succeed({ artifactRef: "poster-1", etag: '"same"' });
            },
          },
        ),
      );
      const failures = await Promise.all([
        f.run({ authorizePublication }).catch((error: unknown) => toErrorBody(error)),
        poster.catch((error: unknown) => toErrorBody(error)),
      ]);
      expect(failures).toEqual([
        toErrorBody(new NotFound({ message: "Video not found" })),
        toErrorBody(new NotFound({ message: "Video not found" })),
      ]);
      expect(posterReads).toBe(0);
      expect(f.signed).toHaveLength(0);
    },
  );
  test("anonymous public viewing gets bounded access without a download claim", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      playback_url:
        "https://customer-fixture.cloudflarestream.com/header.payload.signature/manifest/video.m3u8",
      expires_at: 1_300,
      renew_after: 1_240,
    });
    expect(f.signed).toEqual([{ providerVideoId: "stream-1", expiresAtSeconds: 1_300 }]);
    expect(f.viewers).toEqual(["public-post-anonymous"]);
    expect(f.limits).toEqual([
      { postId: "post-1", source: "trusted-edge-source", policy: VIDEO_PLAYBACK_ACCESS_POLICY },
    ]);
  });
  test.each(["removed", "membership", "age", "community", "policy"])(
    "renewal rechecks %s eligibility and never signs denial",
    async (reason) => {
      const f = fixture();
      await f.run({}, "viewer-1");
      f.setNow(1_240_000);
      if (reason === "removed") f.setLive(null);
      if (reason === "membership")
        f.setLive({ ...f.live, post: { ...f.live.post, visibility: "members_only" } });
      if (reason === "age")
        f.setLive({
          ...f.live,
          post: { ...f.live.post, contentRating: "adult_18" },
          viewer: { ...f.live.viewer, ratingViewAllowed: false },
        });
      if (reason === "community")
        f.setLive({ ...f.live, community: { ...f.live.community, status: "hidden" } });
      if (reason === "policy")
        f.setLive({ ...f.live, viewer: { ...f.live.viewer, canRead: false } });
      await expect(f.run({}, "viewer-1")).rejects.toThrow();
      expect(f.signed).toHaveLength(1);
    },
  );
  test("current durable approval refusal prevents minting", async () => {
    const f = fixture();
    const doc = f.projected;
    if (!("post" in doc)) throw new Error("fixture content required");
    await expect(f.run({ resolveApprovedPlayback: () => Effect.succeed(null) })).rejects.toThrow(
      "Video not found",
    );
    expect(f.signed).toHaveLength(0);
  });
  test("resolves an opaque playback reference before selecting the signing subject", async () => {
    const f = fixture();
    const resolutions: unknown[] = [];
    await f.run({
      resolveApprovedPlayback: (input) => {
        resolutions.push(input);
        return Effect.succeed({ providerVideoId: "durable-stream-subject" });
      },
    });
    expect(resolutions).toEqual([
      { postId: "post-1", communityId: "community-1", playbackRef: "opaque-playback-1" },
    ]);
    expect(f.signed).toEqual([
      { providerVideoId: "durable-stream-subject", expiresAtSeconds: 1_300 },
    ]);
  });
  test("pending playback does not become ready by requesting a grant", async () => {
    const f = fixture();
    const doc = f.projected;
    if (!("post" in doc) || !doc.video) throw new Error("fixture video required");
    f.setProjected({ ...doc, video: { ...doc.video, playback: { status: "pending" } } });
    await expect(f.run()).rejects.toThrow("Video not found");
    expect(f.signed).toHaveLength(0);
  });
  test("all budgets run again on renewal; refusal never calls the signer", async () => {
    const f = fixture();
    await f.run();
    f.denyLimit();
    await expect(f.run()).rejects.toThrow("Too many playback requests");
    expect(f.limits).toHaveLength(2);
    expect(f.signed).toHaveLength(1);
  });
  test("limiter and signer failures are redacted", async () => {
    for (const name of ["limit", "sign", "resolveApprovedPlayback"] as const) {
      const f = fixture();
      await expect(
        f.run({ [name]: () => Effect.fail(new Error("private-provider-secret")) }),
      ).rejects.toThrow("Video delivery unavailable");
    }
  });
  test.each([
    "evil.test",
    "https://customer-fixture.cloudflarestream.com",
    "customer-fixture.cloudflarestream.com/path",
  ])("rejects unsafe host %s before signing", async (customerHost) => {
    const f = fixture();
    await expect(f.run({ customerHost })).rejects.toThrow();
    expect(f.signed).toHaveLength(0);
  });
  test("does not accept a signer URL as a token", async () => {
    const f = fixture();
    await expect(f.run({ sign: () => Effect.succeed("https://evil.test/token") })).rejects.toThrow(
      "Video delivery unavailable",
    );
  });
});
