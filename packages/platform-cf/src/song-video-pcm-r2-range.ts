import type { SongVideoPcmRangeReader } from "./song-video-pcm-excerpt.ts";

const MAX_EXCERPT_BYTES = 15 * 48_000 * 4;

/** Conditional R2 range read, bound to the admitted object's version and ETag. */
export function makeR2SongVideoPcmRangeReader(
  bucket: Pick<R2Bucket, "get">,
): SongVideoPcmRangeReader {
  return {
    async readExact(input) {
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.length) ||
        input.length <= 0 ||
        input.length > MAX_EXCERPT_BYTES
      ) {
        throw new TypeError("invalid PCM range");
      }
      const object = await bucket.get(input.key, {
        onlyIf: { etagMatches: input.etag },
        range: { offset: input.offset, length: input.length },
      });
      if (object === null || !("body" in object)) return null;
      const range = object.range;
      if (
        object.key !== input.key ||
        object.version !== input.version ||
        object.etag !== input.etag ||
        range === undefined ||
        !("offset" in range) ||
        !("length" in range) ||
        range.offset !== input.offset ||
        range.length !== input.length
      ) {
        await object.body.cancel();
        return null;
      }
      const bytes = new Uint8Array(input.length);
      const reader = object.body.getReader();
      let offset = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (offset + next.value.byteLength > input.length) return null;
          bytes.set(next.value, offset);
          offset += next.value.byteLength;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return offset === input.length ? bytes : null;
    },
  };
}
