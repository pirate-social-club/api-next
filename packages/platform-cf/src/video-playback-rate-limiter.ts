import { Effect } from "effect";
import type { VideoPlaybackAccessServices } from "../../application/src/video/playback-access.ts";

export type VideoRateBucket = "source" | "source-post" | "post";
export type VideoRateDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number }>;
export interface VideoRateNamespace {
  readonly getByName: (name: string) => {
    readonly check: (bucket: VideoRateBucket) => Promise<VideoRateDecision>;
  };
}

export function makeVideoPlaybackRateLimiter(options: {
  readonly namespace?: VideoRateNamespace;
  readonly hmacKey?: CryptoKey;
}): VideoPlaybackAccessServices["limit"] {
  const { namespace, hmacKey } = options;
  const algorithm = hmacKey?.algorithm as
    | { name: string; hash?: { name: string }; length?: number }
    | undefined;
  if (!namespace || typeof namespace.getByName !== "function")
    throw new Error("VIDEO_PLAYBACK_RATE_LIMITER binding is required");
  if (
    hmacKey?.type !== "secret" ||
    !hmacKey.usages.includes("sign") ||
    algorithm?.name !== "HMAC" ||
    algorithm.hash?.name !== "SHA-256" ||
    (algorithm.length ?? 0) < 256
  )
    throw new Error("Video playback source HMAC key is required");
  return (input) =>
    Effect.tryPromise({
      try: async () => {
        if (
          !input.source ||
          input.source.trim() !== input.source ||
          input.source.length > 128 ||
          !input.postId ||
          input.postId.length > 512
        )
          throw new Error("Invalid limiter input");
        const buckets: readonly [VideoRateBucket, readonly string[]][] = [
          ["source", [input.source]],
          ["source-post", [input.source, input.postId]],
          ["post", [input.postId]],
        ];
        // Partial charges deliberately remain. Rollback would permit budget bypass
        // under concurrent requests; later refusal can make effective limits tighter.
        for (const [bucket, parts] of buckets) {
          const digest = await crypto.subtle.sign(
            "HMAC",
            hmacKey,
            new TextEncoder().encode(JSON.stringify([bucket, ...parts])),
          );
          const key = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          const decision = await namespace
            .getByName(`video-access-v1:${bucket}:${key}`)
            .check(bucket);
          if (
            typeof decision.allowed !== "boolean" ||
            !Number.isSafeInteger(decision.retryAfterSeconds) ||
            decision.retryAfterSeconds < 0 ||
            decision.retryAfterSeconds > 60 ||
            (!decision.allowed && decision.retryAfterSeconds === 0)
          )
            throw new Error("Invalid limiter decision");
          if (!decision.allowed) return decision;
        }
        return { allowed: true, retryAfterSeconds: 0 };
      },
      catch: () => new Error("Video playback limiter unavailable"),
    });
}
