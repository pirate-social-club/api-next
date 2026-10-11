import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getKaraokePlaybackAccess,
  getSongPlaybackAccess,
  type SongPlaybackServices,
} from "./song-playback.ts";

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

  test("requests an instrumental authority for Karaoke while song playback stays full mix", async () => {
    const selected: string[] = [];
    const services: SongPlaybackServices = {
      nowMs: Effect.succeed(1_000_000),
      limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
      authorize: (request) => {
        selected.push(request.kind ?? "full_mix");
        return Effect.succeed({ immutableRef: `media://immutable/${request.kind ?? "full_mix"}` });
      },
      sign: ({ immutableRef }) =>
        Effect.succeed(`https://audio.example.test/${immutableRef.split("/").at(-1)}`),
    };
    expect(await Effect.runPromise(getSongPlaybackAccess(input, services))).toMatchObject({
      kind: "full_mix",
      playback_url: "https://audio.example.test/full_mix",
    });
    expect(await Effect.runPromise(getKaraokePlaybackAccess(input, services))).toMatchObject({
      kind: "instrumental",
      playback_url: "https://audio.example.test/instrumental",
    });
    expect(selected).toEqual(["full_mix", "instrumental"]);
  });
});
