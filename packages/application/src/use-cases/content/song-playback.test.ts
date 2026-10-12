import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  getKaraokePlaybackAccess,
  getSongPlaybackAccess,
  type KaraokePlaybackServices,
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

  test("signs and returns the same authoritative instrumental binding on every renewal", async () => {
    const target = {
      ...input,
      communityId: "community-song",
      karaokeRevisionId: "karaoke-revision-current",
      playbackRef: "media://immutable/instrumental",
    };
    let reads = 0;
    let signs = 0;
    let nowMs = 1_000_000;
    const services: KaraokePlaybackServices = {
      nowMs: Effect.sync(() => nowMs),
      limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
      authorize: (request) =>
        Effect.sync(() => {
          reads++;
          expect(request).toEqual(target);
          return {
            postId: target.postId,
            communityId: target.communityId,
            karaokeRevisionId: target.karaokeRevisionId,
            immutableRef: target.playbackRef,
          };
        }),
      sign: (request) =>
        Effect.sync(() => {
          signs++;
          expect(request.immutableRef).toBe(target.playbackRef);
          expect(request.lifetimeSeconds).toBe(900);
          return "https://audio.example.test/instrumental";
        }),
    };
    const first = await Effect.runPromise(getKaraokePlaybackAccess(target, services));
    expect(first).toEqual({
      kind: "instrumental",
      post_id: target.postId,
      community_id: target.communityId,
      karaoke_revision_id: target.karaokeRevisionId,
      playback_audio: { kind: "instrumental", ref: target.playbackRef },
      playback_url: "https://audio.example.test/instrumental",
      expires_at: 1900,
      renew_after: 1840,
    });
    nowMs += 840_000;
    expect(await Effect.runPromise(getKaraokePlaybackAccess(target, services))).toEqual({
      ...first,
      expires_at: 2740,
      renew_after: 2680,
    });
    expect(reads).toBe(2);
    expect(signs).toBe(2);
  });

  test("refuses unavailable or mismatched approved bindings without signing a newer source", async () => {
    const target = {
      ...input,
      communityId: "community",
      karaokeRevisionId: "revision",
      playbackRef: "instrumental",
    };
    const binding = {
      postId: input.postId,
      communityId: "community",
      karaokeRevisionId: "revision",
      immutableRef: "instrumental",
    };
    let signs = 0;
    for (const approved of [
      null,
      { ...binding, postId: "other-post" },
      { ...binding, communityId: "other-community" },
      { ...binding, karaokeRevisionId: "newer-revision" },
      { ...binding, immutableRef: "newer-instrumental" },
    ]) {
      const services: KaraokePlaybackServices = {
        nowMs: Effect.succeed(1_000_000),
        limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
        authorize: () => Effect.succeed(approved),
        sign: () =>
          Effect.sync(() => {
            signs++;
            return "never";
          }),
      };
      await expect(
        Effect.runPromise(getKaraokePlaybackAccess(target, services)),
      ).rejects.toMatchObject({ _tag: "NotFound" });
    }
    expect(signs).toBe(0);
  });
});
