import { VIDEO_PLAYBACK_ACCESS_POLICY } from "@pirate/application/video/playback-access";
import { InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import { makeSongPlaybackAuthority } from "../../../packages/platform-cf/src/song-playback-authority.ts";
import { makeSongPlaybackSigner } from "../../../packages/platform-cf/src/song-playback-signer.ts";
import {
  makeVideoPlaybackRateLimiter,
  type VideoRateNamespace,
} from "../../../packages/platform-cf/src/video-playback-rate-limiter.ts";
import { makeSongPlaybackHandler } from "./song-playback-handler.ts";
export interface SongPlaybackBindings {
  readonly SONG_PLAYBACK_ENABLED?: string;
  readonly SONG_PLAYBACK_R2_ACCOUNT_ID?: string;
  readonly SONG_PLAYBACK_R2_BUCKET?: string;
  readonly SONG_PLAYBACK_R2_ACCESS_KEY_ID?: string;
  readonly SONG_PLAYBACK_R2_SECRET_ACCESS_KEY?: string;
  readonly SONG_PLAYBACK_SOURCE_HMAC_BASE64?: string;
  readonly SONG_PLAYBACK_RATE_LIMITER?: VideoRateNamespace;
}
export async function makeSongPlaybackHandlers(
  bindings: SongPlaybackBindings,
  runtime: Parameters<typeof makeSongPlaybackAuthority>[0],
) {
  if (bindings.SONG_PLAYBACK_ENABLED !== "true")
    return {
      CreateSongPlaybackAccess: () => {
        throw new InternalError({ message: "Song playback unavailable" });
      },
    };
  const required = (value: string | undefined) => {
    if (!value || value.trim() !== value) throw new Error("Song playback configuration required");
    return value;
  };
  const encoded = required(bindings.SONG_PLAYBACK_SOURCE_HMAC_BASE64);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error("Invalid song playback HMAC key");
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const namespace = bindings.SONG_PLAYBACK_RATE_LIMITER;
  if (!namespace) throw new Error("Song playback limiter required");
  // Same reviewed 6/120/6000 per-minute budget, isolated from video's key space.
  const budget = makeVideoPlaybackRateLimiter({
    hmacKey,
    namespace: { getByName: (name) => namespace.getByName(`song:${name}`) },
  });
  return {
    CreateSongPlaybackAccess: makeSongPlaybackHandler({
      authorize: makeSongPlaybackAuthority(runtime),
      nowMs: Effect.sync(Date.now),
      limit: (input) => budget({ ...input, policy: VIDEO_PLAYBACK_ACCESS_POLICY }),
      sign: makeSongPlaybackSigner({
        accountId: required(bindings.SONG_PLAYBACK_R2_ACCOUNT_ID),
        bucket: required(bindings.SONG_PLAYBACK_R2_BUCKET),
        accessKeyId: required(bindings.SONG_PLAYBACK_R2_ACCESS_KEY_ID),
        secretAccessKey: required(bindings.SONG_PLAYBACK_R2_SECRET_ACCESS_KEY),
      }),
    }),
  };
}
