import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getVideoPlaybackAccess,
  VIDEO_PLAYBACK_ACCESS_POLICY as policy,
} from "../../application/src/video/playback-access.ts";
import {
  makeVideoPlaybackRateLimiter,
  type VideoRateBucket,
} from "./video-playback-rate-limiter.ts";

const key = () =>
  crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
const input = { source: "198.51.100.1", postId: "post-1", policy };
describe("video playback limiter adapter", () => {
  test("requires the namespace and key before constructing a limiter", async () => {
    expect(() => makeVideoPlaybackRateLimiter({})).toThrow("binding is required");
    expect(() =>
      makeVideoPlaybackRateLimiter({
        namespace: {
          getByName: () => ({ check: async () => ({ allowed: true, retryAfterSeconds: 0 }) }),
        },
      }),
    ).toThrow("HMAC key is required");
  });
  test("charges all buckets using stable pseudonyms and retains partial charges on refusal", async () => {
    const calls: { name: string; bucket: VideoRateBucket }[] = [];
    const limit = makeVideoPlaybackRateLimiter({
      hmacKey: await key(),
      namespace: {
        getByName: (name) => ({
          check: async (bucket) => {
            calls.push({ name, bucket });
            return { allowed: bucket !== "post", retryAfterSeconds: bucket === "post" ? 30 : 0 };
          },
        }),
      },
    });
    expect(await Effect.runPromise(limit(input))).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(calls.map(({ bucket }) => bucket)).toEqual(["source", "source-post", "post"]);
    expect(JSON.stringify(calls)).not.toContain(input.source);
    expect(JSON.stringify(calls)).not.toContain(input.postId);
    await Effect.runPromise(limit(input));
    expect(calls.slice(3)).toEqual(calls.slice(0, 3));
  });
  test.each(["lookup", "rpc", "malformed"])("%s failure cannot reach signing", async (failure) => {
    let signed = false;
    const limit = makeVideoPlaybackRateLimiter({
      hmacKey: await key(),
      namespace: {
        getByName: () => {
          if (failure === "lookup") throw new Error("private namespace error");
          return {
            check: async () => {
              if (failure === "rpc") throw new Error("private rpc error");
              return { allowed: false, retryAfterSeconds: 0 };
            },
          };
        },
      },
    });
    await expect(
      Effect.runPromise(
        getVideoPlaybackAccess(
          { postId: input.postId, trustedSource: input.source },
          {
            customerHost: "customer-fixture.cloudflarestream.com",
            nowMs: Effect.succeed(1000000),
            contentStore: {
              resolvePost: () => Effect.succeed(null),
              getPost: () => Effect.succeed(null),
            },
            authorizePublication: () => Effect.succeed(false),
            resolveApprovedPlayback: () => Effect.succeed(null),
            limit,
            sign: () =>
              Effect.sync(() => {
                signed = true;
                return "unused.token.signature";
              }),
          },
        ),
      ),
    ).rejects.toThrow("Video delivery unavailable");
    expect(signed).toBe(false);
  });
});
