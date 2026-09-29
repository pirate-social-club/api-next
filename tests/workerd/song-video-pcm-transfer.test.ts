import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SONG_VIDEO_PCM_MAX_BYTES,
  SONG_VIDEO_PCM_MAX_SAMPLES,
  transferSongVideoPcm,
} from "../../packages/platform-cf/src/song-video-pcm-transfer.ts";

const bucket = (env as unknown as { AVATAR_TEST_SEALED: R2Bucket }).AVATAR_TEST_SEALED;
const canonicalAudioSha256 = "a".repeat(64);
const decoderRecipe = "cloudconvert-song-pcm-s16le-48000-stereo-v1";

function response(declared: number, actual = declared) {
  let remaining = actual;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        const size = Math.min(remaining, 65_536);
        remaining -= size;
        controller.enqueue(new Uint8Array(size));
      },
    }),
    { headers: { "content-length": String(declared) } },
  );
}

const input = (value: Response) => ({
  response: value,
  bucket,
  objectKey: `song-video-pcm/${crypto.randomUUID()}.pcm`,
  canonicalAudioSha256,
  decoderRecipe,
  deadlineMs: Date.now() + 30_000,
});

describe("whole-song PCM streaming in workerd", () => {
  it("streams four minutes into R2 and verifies the complete readback", async () => {
    const request = input(response(SONG_VIDEO_PCM_MAX_BYTES));
    const result = await transferSongVideoPcm(request);
    expect(result.byteLength).toBe(46_080_000);
    expect(result.durationSamples).toBe(11_520_000);
    expect(result.durationSamples).toBe(SONG_VIDEO_PCM_MAX_SAMPLES);
    expect(result.pcmSha256).toMatch(/^[0-9a-f]{64}$/u);
    const head = await bucket.head(result.objectKey);
    expect(head?.version).toBe(result.objectVersion);
    expect(head?.etag).toBe(result.objectEtag);
    expect(head?.size).toBe(SONG_VIDEO_PCM_MAX_BYTES);
    expect(head?.customMetadata?.canonicalAudioSha256).toBe(canonicalAudioSha256);
  }, 60_000);

  it("refuses oversized, unaligned and missing length before any write", async () => {
    for (const value of [
      response(SONG_VIDEO_PCM_MAX_BYTES + 4),
      response(5),
      new Response(new Uint8Array(4)),
    ]) {
      const request = input(value);
      await expect(transferSongVideoPcm(request)).rejects.toThrow("song PCM export refused");
      expect(await bucket.head(request.objectKey)).toBeNull();
    }
  });

  it("aborts an export that overflows or truncates mid-stream", async () => {
    for (const actual of [4, 12]) {
      const request = input(response(8, actual));
      await expect(transferSongVideoPcm(request)).rejects.toThrow();
      expect(await bucket.head(request.objectKey)).toBeNull();
    }
  });

  it("refuses an expired transfer before reading or writing", async () => {
    const request = { ...input(response(8)), deadlineMs: Date.now() - 1 };
    await expect(transferSongVideoPcm(request)).rejects.toThrow("song PCM export refused");
    expect(await bucket.head(request.objectKey)).toBeNull();
  });

  it("aborts a stalled body at the transfer deadline", async () => {
    const value = new Response(
      new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }),
      { headers: { "content-length": "8" } },
    );
    const request = { ...input(value), deadlineMs: Date.now() + 50 };
    await expect(transferSongVideoPcm(request)).rejects.toThrow(
      "song PCM transfer deadline expired",
    );
    expect(await bucket.head(request.objectKey)).toBeNull();
  });

  it("does not replace an occupied output address", async () => {
    const request = input(response(8));
    await bucket.put(request.objectKey, new Uint8Array([1, 2, 3, 4]));
    await expect(transferSongVideoPcm(request)).rejects.toThrow();
    expect((await bucket.head(request.objectKey))?.size).toBe(4);
  });
});
