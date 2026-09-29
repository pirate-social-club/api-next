import { describe, expect, test } from "bun:test";
import type { SongVideoPcmReference } from "@pirate/application/video/song-interval";
import { makeSongVideoPcmExcerpt } from "./song-video-pcm-excerpt.ts";

const durationSamples = 48_000 * 20;
const reference: SongVideoPcmReference = {
  songPostId: "song-1",
  audioRevision: 1,
  canonicalAudioSha256: "a".repeat(64),
  durationSamples,
  objectKey: "song-video-pcm/song-1/r1.pcm",
  objectVersion: "version-1",
  objectEtag: "etag-1",
  pcmSha256: "b".repeat(64),
  byteLength: durationSamples * 4,
  decoderRecipe: "pinned-test",
};

describe("song-video PCM excerpt", () => {
  test("reads only the selected sample range and hashes sample data apart from WAV", async () => {
    const start = 48_000 * 2;
    const duration = 48_000 * 3;
    const pcm = new Uint8Array(duration * 4);
    pcm[0] = 7;
    pcm[pcm.length - 1] = 9;
    const reads: unknown[] = [];
    const result = await makeSongVideoPcmExcerpt({
      reference,
      clipStartSamples: start,
      clipDurationSamples: duration,
      reader: {
        readExact: async (request) => {
          reads.push(request);
          return pcm;
        },
      },
    });
    expect(reads).toEqual([
      {
        key: reference.objectKey,
        version: reference.objectVersion,
        etag: reference.objectEtag,
        offset: start * 4,
        length: duration * 4,
      },
    ]);
    expect(result.wav.byteLength).toBe(44 + pcm.byteLength);
    expect(new TextDecoder().decode(result.wav.subarray(0, 4))).toBe("RIFF");
    expect(result.wav.subarray(44)).toEqual(pcm);
    expect(result.pcmSha256).not.toBe(result.wavSha256);
    const digest = await crypto.subtle.digest("SHA-256", pcm);
    expect(result.pcmSha256).toBe(Buffer.from(digest).toString("hex"));
  });

  test("refuses an interval outside the admitted song before touching storage", async () => {
    let reads = 0;
    await expect(
      makeSongVideoPcmExcerpt({
        reference,
        clipStartSamples: durationSamples - 48_000,
        clipDurationSamples: 48_000 * 3,
        reader: {
          readExact: async () => {
            reads++;
            return new Uint8Array();
          },
        },
      }),
    ).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
  });

  test("refuses a short or changed range", async () => {
    for (const returned of [null, new Uint8Array(10)]) {
      await expect(
        makeSongVideoPcmExcerpt({
          reference,
          clipStartSamples: 0,
          clipDurationSamples: 48_000 * 3,
          reader: { readExact: async () => returned },
        }),
      ).rejects.toThrow("PCM excerpt identity or length mismatch");
    }
  });
});
