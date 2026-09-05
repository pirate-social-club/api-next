import { BadRequest, InternalError, NotFound, RateLimited } from "@pirate/contracts";
import { VIDEO_INGEST_POLICY_V1 } from "@pirate/domain";
import { Effect } from "effect";
import type { ContentStoreService } from "../ports.ts";

export const VIDEO_PLAYBACK_ACCESS_POLICY = Object.freeze({
  lifetimeSeconds: VIDEO_INGEST_POLICY_V1.maxDurationMs / 1_000 + 120,
  renewalMarginSeconds: 60,
  rateWindowSeconds: 60,
  sourcePostLimit: 6,
  sourceLimit: 120,
  postLimit: 6_000,
});

export type VideoPlaybackAccess = Readonly<{
  playback_url: string;
  expires_at: number;
  renew_after: number;
}>;

export interface VideoPlaybackAccessServices {
  readonly contentStore: Pick<ContentStoreService, "resolvePost" | "getPost">;
  /** Resolve the opaque reference against current approved, encoding-ready durable facts. */
  readonly resolveApprovedPlayback: (
    input: Readonly<{ postId: string; communityId: string; playbackRef: string }>,
  ) => Effect.Effect<Readonly<{ providerVideoId: string }> | null, unknown>;
  /** Validated deployment value, never a request Host or provider-returned URL. */
  readonly customerHost: string;
  readonly nowMs: Effect.Effect<number>;
  /** All three globally coordinated budgets must pass before signing. */
  readonly limit: (
    input: Readonly<{
      source: string;
      postId: string;
      policy: typeof VIDEO_PLAYBACK_ACCESS_POLICY;
    }>,
  ) => Effect.Effect<Readonly<{ allowed: boolean; retryAfterSeconds: number }>, unknown>;
  /** Produces a signed token only; no caller-selected claims or download grant. */
  readonly sign: (
    input: Readonly<{
      providerVideoId: string;
      expiresAtSeconds: number;
    }>,
  ) => Effect.Effect<string, unknown>;
}

/** Mount and renewal deliberately use exactly the same guarded read. */
export const getVideoPlaybackAccess = Effect.fn("getVideoPlaybackAccess")(function* (
  input: Readonly<{ postId: string; viewerUserId?: string; trustedSource: string }>,
  services: VideoPlaybackAccessServices,
): Effect.fn.Return<VideoPlaybackAccess, BadRequest | InternalError | NotFound | RateLimited> {
  if (
    !input.postId.trim() ||
    input.postId.trim() !== input.postId ||
    input.postId.length > 512 ||
    input.postId.includes("\u0000")
  ) {
    return yield* new BadRequest({ message: "Invalid post identifier" });
  }
  if (!/^customer-[a-z0-9]+\.cloudflarestream\.com$/u.test(services.customerHost)) {
    return yield* new InternalError({ message: "Video delivery unavailable" });
  }
  if (!input.trustedSource.trim() || input.trustedSource.length > 128) {
    return yield* new InternalError({ message: "Video delivery unavailable" });
  }
  const limited = yield* services
    .limit({
      source: input.trustedSource,
      postId: input.postId,
      policy: VIDEO_PLAYBACK_ACCESS_POLICY,
    })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (!limited.allowed) {
    const retry = limited.retryAfterSeconds;
    if (
      !Number.isSafeInteger(retry) ||
      retry < 1 ||
      retry > VIDEO_PLAYBACK_ACCESS_POLICY.rateWindowSeconds
    ) {
      return yield* new InternalError({ message: "Video delivery unavailable" });
    }
    return yield* new RateLimited({
      message: "Too many playback requests",
      retry_after_seconds: retry,
    });
  }
  const location = yield* services.contentStore
    .resolvePost({ postId: input.postId })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (location === null || location.postId !== input.postId)
    return yield* new NotFound({ message: "Video not found" });
  const result = yield* services.contentStore
    .getPost({ ...location, viewerUserId: input.viewerUserId ?? "public-post-anonymous" })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (
    result === null ||
    !("post" in result) ||
    result.post.id !== input.postId ||
    result.post.community !== location.communityId ||
    result.post.post_type !== "video" ||
    result.post.status !== "published" ||
    result.video?.soundtrack.kind !== "original_audio"
  ) {
    return yield* new NotFound({ message: "Video not found" });
  }
  const playback = result.video.playback;
  if (playback.status !== "ready") return yield* new NotFound({ message: "Video not found" });
  const approved = yield* services
    .resolveApprovedPlayback({ ...location, playbackRef: playback.playback_ref })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  if (approved === null) return yield* new NotFound({ message: "Video not found" });
  const nowMs = yield* services.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    return yield* new InternalError({ message: "Video delivery unavailable" });
  const now = Math.floor(nowMs / 1_000);
  const expires = now + VIDEO_PLAYBACK_ACCESS_POLICY.lifetimeSeconds;
  const token = yield* services
    .sign({ providerVideoId: approved.providerVideoId, expiresAtSeconds: expires })
    .pipe(Effect.mapError(() => new InternalError({ message: "Video delivery unavailable" })));
  // A signer returns only a compact token; never accept its URL or extra path.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) || token.length > 16_384) {
    return yield* new InternalError({ message: "Video delivery unavailable" });
  }
  return {
    playback_url: `https://${services.customerHost}/${token}/manifest/video.m3u8`,
    expires_at: expires,
    renew_after: expires - VIDEO_PLAYBACK_ACCESS_POLICY.renewalMarginSeconds,
  };
});
