import { Effect } from "effect";
import { makeVideoPlaybackHandler } from "../../apps/http-worker/src/video-playback-handler.ts";
import { makeVideoPosterHandler } from "../../apps/http-worker/src/video-poster-handler.ts";
import type { VideoAccessAuthorizationServices } from "../../packages/application/src/video/access-authorization.ts";

export function videoAccessFixtureHandlers() {
  const authorization: VideoAccessAuthorizationServices = {
    contentStore: {
      resolvePost: ({ postId }) =>
        Effect.succeed(postId === "absent" ? null : { postId, communityId: "video-community" }),
      getPost: ({ postId }) =>
        Effect.succeed({
          post: {
            id: postId,
            community: "video-community",
            post_type: "video",
            status: "published",
          },
          video: {
            soundtrack: { kind: "original_audio" },
            playback: { status: "ready", provider: "stream", playback_ref: "opaque-playback" },
            thumbnail: { status: "ready", artifact_ref: `poster-${postId}` },
          },
        } as Effect.Success<
          ReturnType<VideoAccessAuthorizationServices["contentStore"]["getPost"]>
        >),
    },
    // Model a changed eligibility result on the same URL for the cache regression.
    authorizePublication: ({ postId, viewerUserId }) =>
      Effect.succeed(["allowed", "missing"].includes(postId) && viewerUserId === undefined),
  };
  return {
    GetVideoPoster: makeVideoPosterHandler({
      ...authorization,
      resolveArtifact: ({ artifactRef }) =>
        Effect.succeed({
          key: artifactRef,
          artifactRef,
          sha256: "a".repeat(64),
          sourceSha256: "b".repeat(64),
          policyRevision: "1",
        }),
      bucket: {
        get: async (key) =>
          key === "poster-missing"
            ? null
            : {
                key,
                size: 4,
                httpEtag: '"same-bytes"',
                httpMetadata: { contentType: "image/jpeg" },
                customMetadata: {
                  sha256: "a".repeat(64),
                  sourceSha256: "b".repeat(64),
                  policyRevision: "1",
                },
                body: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array([255, 216, 255, 217]));
                    controller.close();
                  },
                }),
              },
      },
    }),
    CreateVideoPlaybackAccess: makeVideoPlaybackHandler({
      ...authorization,
      customerHost: "customer-fixture.cloudflarestream.com",
      nowMs: Effect.succeed(1_000_000),
      resolveApprovedPlayback: () => Effect.succeed({ providerVideoId: "c".repeat(32) }),
      limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
      sign: () => Effect.succeed("header.claims.signature"),
    }),
  };
}
