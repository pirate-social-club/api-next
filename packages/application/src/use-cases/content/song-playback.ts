import { BadRequest, InternalError, NotFound, RateLimited } from "@pirate/contracts";
import { Effect } from "effect";

export const SONG_PLAYBACK_LIFETIME_SECONDS = 900;
export const SONG_PLAYBACK_RENEWAL_MARGIN_SECONDS = 60;
export interface SongPlaybackServices {
  readonly authorize: (input: {
    postId: string;
    viewerUserId?: string;
  }) => Effect.Effect<{ immutableRef: string } | null, unknown>;
  readonly limit: (input: {
    source: string;
    postId: string;
  }) => Effect.Effect<{ allowed: boolean; retryAfterSeconds: number }, unknown>;
  readonly sign: (input: {
    immutableRef: string;
    nowSeconds: number;
    lifetimeSeconds: number;
  }) => Effect.Effect<string, unknown>;
  readonly nowMs: Effect.Effect<number>;
}
const unavailable = () => new InternalError({ message: "Song playback unavailable" });
/** Every initial play and renewal repeats authorization before issuing an R2 GET grant. */
export const getSongPlaybackAccess = Effect.fn("getSongPlaybackAccess")(function* (
  input: { postId: string; viewerUserId?: string; trustedSource: string },
  services: SongPlaybackServices,
) {
  if (
    !input.postId ||
    input.postId.trim() !== input.postId ||
    input.postId.length > 512 ||
    input.postId.includes("\u0000")
  )
    return yield* new BadRequest({ message: "Invalid post identifier" });
  if (
    !input.trustedSource ||
    input.trustedSource.trim() !== input.trustedSource ||
    input.trustedSource.length > 128
  )
    return yield* unavailable();
  const budget = yield* services
    .limit({ source: input.trustedSource, postId: input.postId })
    .pipe(Effect.mapError(unavailable));
  if (!budget.allowed) {
    if (
      !Number.isSafeInteger(budget.retryAfterSeconds) ||
      budget.retryAfterSeconds < 1 ||
      budget.retryAfterSeconds > 60
    )
      return yield* unavailable();
    return yield* new RateLimited({
      message: "Too many playback requests",
      retry_after_seconds: budget.retryAfterSeconds,
    });
  }
  const approved = yield* services.authorize(input).pipe(Effect.mapError(unavailable));
  if (approved === null) return yield* new NotFound({ message: "Song not found" });
  const nowMs = yield* services.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return yield* unavailable();
  const nowSeconds = Math.floor(nowMs / 1000);
  const playback_url = yield* services
    .sign({ ...approved, nowSeconds, lifetimeSeconds: SONG_PLAYBACK_LIFETIME_SECONDS })
    .pipe(Effect.mapError(unavailable));
  return {
    kind: "full_mix" as const,
    playback_url,
    expires_at: nowSeconds + SONG_PLAYBACK_LIFETIME_SECONDS,
    renew_after: nowSeconds + SONG_PLAYBACK_LIFETIME_SECONDS - SONG_PLAYBACK_RENEWAL_MARGIN_SECONDS,
  };
});
