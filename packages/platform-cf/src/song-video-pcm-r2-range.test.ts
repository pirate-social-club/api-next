import { describe, expect, test } from "bun:test";
import { makeR2SongVideoPcmRangeReader } from "./song-video-pcm-r2-range.ts";

const request = {
  key: "song-video-pcm/song/r1",
  version: "v1",
  etag: "etag1",
  offset: 8,
  length: 4,
};

function object(bytes: Uint8Array, patch: Record<string, unknown> = {}) {
  return {
    key: request.key,
    version: request.version,
    etag: request.etag,
    range: { offset: request.offset, length: request.length },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    ...patch,
  };
}

describe("R2 song-video PCM range", () => {
  test("passes a conditional exact range and returns only matching bytes", async () => {
    const calls: unknown[] = [];
    const reader = makeR2SongVideoPcmRangeReader({
      get: async (key, options) => {
        calls.push({ key, options });
        return object(new Uint8Array([1, 2, 3, 4])) as R2ObjectBody;
      },
    });
    expect(await reader.readExact(request)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(calls).toEqual([
      {
        key: request.key,
        options: { onlyIf: { etagMatches: request.etag }, range: { offset: 8, length: 4 } },
      },
    ]);
  });

  test("rejects a changed object, omitted range, short read or extra bytes", async () => {
    for (const result of [
      object(new Uint8Array(4), { version: "v2" }),
      object(new Uint8Array(4), { range: undefined }),
      object(new Uint8Array(3)),
      object(new Uint8Array(5)),
      null,
    ]) {
      const reader = makeR2SongVideoPcmRangeReader({
        get: async () => result as R2ObjectBody | null,
      });
      expect(await reader.readExact(request)).toBeNull();
    }
  });
});
