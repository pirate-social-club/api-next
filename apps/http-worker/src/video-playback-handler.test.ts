import { expect, test } from "bun:test";
import type { VideoPlaybackAccessServices } from "@pirate/application/video/playback-access";
import { Effect } from "effect";
import type { DecodedRequest } from "./transport.ts";
import { makeVideoPlaybackHandler } from "./video-playback-handler.ts";

function fixture() {
  const calls: string[] = [];
  const document = {
    post: { id: "post-1", community: "community-1", post_type: "video", status: "published" },
    video: {
      soundtrack: { kind: "original_audio" },
      playback: { status: "ready", playback_ref: "opaque" },
    },
  } as Effect.Success<ReturnType<VideoPlaybackAccessServices["contentStore"]["getPost"]>>;
  const services: VideoPlaybackAccessServices = {
    customerHost: "customer-fixture.cloudflarestream.com",
    nowMs: Effect.succeed(1_000_000),
    contentStore: {
      resolvePost: () => Effect.succeed({ postId: "post-1", communityId: "community-1" }),
      getPost: () => Effect.succeed(document),
    },
    authorizePublication: ({ viewerUserId }) =>
      Effect.sync(() => {
        calls.push(`authorize:${viewerUserId ?? "anonymous"}`);
        return true;
      }),
    resolveApprovedPlayback: () => Effect.succeed({ providerVideoId: "a".repeat(32) }),
    limit: ({ source }) =>
      Effect.sync(() => {
        calls.push(`limit:${source}`);
        return { allowed: true, retryAfterSeconds: 0 };
      }),
    sign: () =>
      Effect.sync(() => {
        calls.push("sign");
        return "header.claims.signature";
      }),
  };
  const request: DecodedRequest = {
    principal: null,
    params: { postId: "post-1" },
    body: undefined,
    query: {},
    edgeClientIp: "198.51.100.1",
  };
  return { handler: makeVideoPlaybackHandler(services), request, calls };
}

test("anonymous playback minting and renewal both authorize freshly and return private no-store", async () => {
  const f = fixture();
  for (let count = 0; count < 2; count++) {
    const result = await f.handler(f.request);
    expect(result.status).toBe(200);
    expect(new Headers(result.responseHeaders).get("cache-control")).toBe("private, no-store");
    expect(result.body).toEqual({
      playback_url:
        "https://customer-fixture.cloudflarestream.com/header.claims.signature/manifest/video.m3u8",
      expires_at: 1300,
      renew_after: 1240,
    });
  }
  expect(f.calls).toEqual([
    "limit:198.51.100.1",
    "authorize:anonymous",
    "sign",
    "limit:198.51.100.1",
    "authorize:anonymous",
    "sign",
  ]);
});

test("missing edge address cannot use caller forwarding headers as a limiter identity", async () => {
  const f = fixture();
  const { edgeClientIp: _, ...request } = f.request;
  await expect(
    f.handler({ ...request, headers: { "x-forwarded-for": "198.51.100.1" } }),
  ).rejects.toThrow("Video delivery unavailable");
  expect(f.calls).toHaveLength(0);
});

test("device and agent principals cannot mint playback grants", async () => {
  const f = fixture();
  for (const kind of ["device", "agent"] as const)
    await expect(
      f.handler({ ...f.request, principal: { kind, subject: "machine" } }),
    ).rejects.toThrow("Authorization failed");
  expect(f.calls).toHaveLength(0);
});
