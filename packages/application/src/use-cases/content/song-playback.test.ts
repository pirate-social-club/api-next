import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { getSongPlaybackAccess, type SongPlaybackServices } from "./song-playback.ts";

const input = { postId: "post-song", trustedSource: "198.51.100.1", viewerUserId: "viewer" };
describe("song playback access", () => {
  test("authorizes every renewal and never signs denied or rate-limited requests", async () => {
    let allowed = true,
      limited = false,
      signs = 0,
      reads = 0;
    const services: SongPlaybackServices = {
      nowMs: Effect.succeed(1000000),
      limit: () => Effect.succeed({ allowed: !limited, retryAfterSeconds: limited ? 30 : 0 }),
      authorize: (request) =>
        Effect.sync(() => {
          expect(request.viewerUserId).toBe("viewer");
          reads++;
          return allowed ? { immutableRef: "media://immutable/song/audio" } : null;
        }),
      sign: (request) =>
        Effect.sync(() => {
          signs++;
          expect(request).toEqual({
            immutableRef: "media://immutable/song/audio",
            nowSeconds: 1000,
            lifetimeSeconds: 900,
          });
          return "https://audio.example.test/signed";
        }),
    };
    expect(await Effect.runPromise(getSongPlaybackAccess(input, services))).toEqual({
      kind: "full_mix",
      playback_url: "https://audio.example.test/signed",
      expires_at: 1900,
      renew_after: 1840,
    });
    allowed = false;
    await expect(Effect.runPromise(getSongPlaybackAccess(input, services))).rejects.toThrow(
      "Song not found",
    );
    expect(reads).toBe(2);
    expect(signs).toBe(1);
    limited = true;
    await expect(Effect.runPromise(getSongPlaybackAccess(input, services))).rejects.toThrow(
      "Too many playback requests",
    );
    expect(reads).toBe(2);
    expect(signs).toBe(1);
    await expect(
      Effect.runPromise(getSongPlaybackAccess({ ...input, trustedSource: "" }, services)),
    ).rejects.toThrow("Song playback unavailable");
  });
});
