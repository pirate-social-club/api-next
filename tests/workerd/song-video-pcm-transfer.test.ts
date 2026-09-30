import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  readStoredSongVideoPcm,
  SONG_VIDEO_PCM_MAX_BYTES,
  SONG_VIDEO_PCM_MAX_SAMPLES,
  SongPcmTransferError,
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
  it("recovers a completed write by streaming the same immutable object", async () => {
    const request = input(response(192_000));
    const written = await transferSongVideoPcm(request);
    expect(await readStoredSongVideoPcm(request)).toEqual(written);
  });

  it("returns pending for a missing recovery object", async () => {
    expect(await readStoredSongVideoPcm(input(response(8)))).toBeNull();
  });

  it("refuses a recovery object bound to another source or recipe", async () => {
    const request = input(response(8));
    await transferSongVideoPcm(request);
    await expect(
      readStoredSongVideoPcm({
        ...request,
        canonicalAudioSha256: "b".repeat(64),
      }),
    ).rejects.toThrow("song PCM recovery identity refused");
    await expect(
      readStoredSongVideoPcm({
        ...request,
        decoderRecipe: "another-decoder",
      }),
    ).rejects.toThrow("song PCM recovery identity refused");
  });

  it("bounds a stalled recovery head by the deadline", async () => {
    const request = input(response(8));
    await expect(
      readStoredSongVideoPcm({
        ...request,
        deadlineMs: Date.now() + 50,
        bucket: {
          head: () => new Promise<R2Object | null>(() => {}),
          get: bucket.get.bind(bucket),
        },
      }),
    ).rejects.toThrow("song PCM recovery expired");
  });
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
      await expect(transferSongVideoPcm(request)).rejects.toThrow("phase=export-admission");
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
    await expect(transferSongVideoPcm(request)).rejects.toThrow("phase=export-admission");
    expect(await bucket.head(request.objectKey)).toBeNull();
  });

  it("aborts a stalled body at the transfer deadline", async () => {
    const value = new Response(
      new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }),
      { headers: { "content-length": "8" } },
    );
    const request = { ...input(value), deadlineMs: Date.now() + 50 };
    await expect(transferSongVideoPcm(request)).rejects.toThrow("error=TimeoutError");
    expect(await bucket.head(request.objectKey)).toBeNull();
  });

  it("does not replace an occupied output address", async () => {
    const request = input(response(8));
    await bucket.put(request.objectKey, new Uint8Array([1, 2, 3, 4]));
    await expect(transferSongVideoPcm(request)).rejects.toThrow();
    expect((await bucket.head(request.objectKey))?.size).toBe(4);
  });

  it("refuses a readback request that never returns before its deadline", async () => {
    const request = {
      ...input(response(8)),
      deadlineMs: Date.now() + 100,
      bucket: {
        put: bucket.put.bind(bucket),
        get: () => new Promise<R2ObjectBody | null>(() => {}),
      },
    };
    await expect(transferSongVideoPcm(request)).rejects.toThrow("error=TimeoutError");
  });
  it("verifies the live-sized streamed master without a post-write hang", async () => {
    const request = input(response(3_072_000));
    const result = await transferSongVideoPcm(request);
    expect(result.durationSamples).toBe(768_000);
    expect(await readStoredSongVideoPcm(request)).toEqual(result);
  });

  it("identifies a lost upload acknowledgement after real R2 has stored all bytes", async () => {
    const request = {
      ...input(response(3_072_000)),
      deadlineMs: Date.now() + 1000,
      bucket: {
        async put(...args: Parameters<R2Bucket["put"]>) {
          await bucket.put(...args);
          return new Promise<R2Object>(() => {});
        },
        get: bucket.get.bind(bucket),
      },
    };
    const failure = await transferSongVideoPcm(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SongPcmTransferError);
    expect(failure).toMatchObject({
      phase: "upload",
      errorClass: "TimeoutError",
      pendingPhases: ["upload"],
    });
    expect((await bucket.head(request.objectKey))?.size).toBe(3_072_000);
    const recovered = await readStoredSongVideoPcm({
      ...request,
      bucket,
      deadlineMs: Date.now() + 30_000,
    });
    expect(recovered?.durationSamples).toBe(768_000);
  });

  it("captures the still-pending stages when complete export bytes arrive without EOF", async () => {
    let remaining = 3_072_000;
    const value = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining === 0) return new Promise<void>(() => {});
          const size = Math.min(remaining, 65_536);
          remaining -= size;
          controller.enqueue(new Uint8Array(size));
        },
      }),
      { headers: { "content-length": "3072000" } },
    );
    const request = { ...input(value), deadlineMs: Date.now() + 1000 };
    const failure = await transferSongVideoPcm(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SongPcmTransferError);
    expect(failure).toMatchObject({ errorClass: "TimeoutError" });
    if (!(failure instanceof SongPcmTransferError)) throw new Error("diagnostic missing");
    expect(failure.pendingPhases).toContain("stream");
    expect(failure.pendingPhases).toContain("hash-digest");
    expect((await bucket.head(request.objectKey))?.size).toBe(3_072_000);
    expect(
      await readStoredSongVideoPcm({ ...request, deadlineMs: Date.now() + 30_000 }),
    ).not.toBeNull();
  });

  it("reports readback separately after the upload and source digest finish", async () => {
    const request = {
      ...input(response(8)),
      deadlineMs: Date.now() + 150,
      bucket: {
        put: bucket.put.bind(bucket),
        get: () => new Promise<R2ObjectBody | null>(() => {}),
      },
    };
    await expect(transferSongVideoPcm(request)).rejects.toMatchObject({
      phase: "readback",
      errorClass: "TimeoutError",
      pendingPhases: ["readback"],
    });
    expect((await bucket.head(request.objectKey))?.size).toBe(8);
  });

  it("never copies a raw signed URL or unknown exception class into diagnostics", async () => {
    const raw = new Error("https://us-east.storage.cloudconvert.com/private?secret=signed-value");
    raw.name = "secret-provider-error";
    const request = {
      ...input(response(8)),
      bucket: {
        put: bucket.put.bind(bucket),
        get: async () => {
          throw raw;
        },
      },
    };
    const failure = await transferSongVideoPcm(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({ phase: "readback", errorClass: "Error" });
    if (!(failure instanceof SongPcmTransferError)) throw new Error("diagnostic missing");
    expect(failure.message).not.toContain("secret");
    expect(failure.message).not.toContain("https:");
    expect(failure.cause).toBeUndefined();
  });
});
