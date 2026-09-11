import { SONG_VIDEO_MASTER_POLICY_V1 } from "@pirate/domain";
import type { DataRegistrationMasterSource } from "./data/registration-artifact-pipeline.ts";
import { mediaProcessingPhysicalObjectKey } from "./media-immutable-object-key.ts";
import type { SongVideoOutputStore } from "./song-video-output-verification.ts";

/**
 * The accepted song-video master as an object in the immutable-originals
 * keyspace, addressed by the logical `media://immutable/...` reference the
 * source gateway, Stream grants, playback and DATA all share. One mapping
 * function turns that reference into the physical key, so a master is not a
 * second addressing scheme: it is an immutable object like any sealed original.
 *
 * The write side belongs to the render host, which is not deployed here. These
 * adapters are its read side, and they fail closed when the exact verified
 * version is not what the bucket currently holds. A refusal never leaves the
 * body dangling, a stale version is refused before it is buffered, and the
 * ratified ceiling bounds any allocation.
 */

const withinReadBound = (size: number): boolean =>
  Number.isSafeInteger(size) && size > 0 && size <= SONG_VIDEO_MASTER_POLICY_V1.maxBytes;

const discard = async (body: ReadableStream<Uint8Array>): Promise<void> => {
  await body.cancel().catch(() => undefined);
};

export function makeR2SongVideoOutputStore(bucket: R2Bucket): SongVideoOutputStore {
  return {
    read: async (objectKey) => {
      const object = await bucket.get(mediaProcessingPhysicalObjectKey(objectKey));
      if (object === null) return null;
      // Refuse an oversized object before allocating, so a wrong key cannot buy
      // an allocation past the ratified ceiling.
      if (!withinReadBound(object.size)) {
        await discard(object.body);
        return null;
      }
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        objectVersion: object.version,
        etag: object.etag,
      };
    },
    readVersion: async (objectKey, objectVersion) => {
      const object = await bucket.get(mediaProcessingPhysicalObjectKey(objectKey));
      if (object === null) return null;
      // A stale or oversized object is refused before a byte is buffered.
      if (object.version !== objectVersion || !withinReadBound(object.size)) {
        await discard(object.body);
        return null;
      }
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

export function makeR2SongVideoMasterSource(bucket: R2Bucket): DataRegistrationMasterSource {
  return {
    open: async (objectKey, objectVersion, signal) => {
      const object = await bucket.get(mediaProcessingPhysicalObjectKey(objectKey));
      if (object === null) return null;
      if (object.version !== objectVersion) {
        // A refused version is refused before any byte is read, and the body is
        // cancelled rather than left dangling.
        await discard(object.body);
        return null;
      }
      const reader = object.body.getReader();
      return (async function* () {
        let abort: ((reason: unknown) => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          abort = reject;
        });
        const onAbort = () => {
          abort?.(new DOMException("cancelled", "AbortError"));
          // Cancelling releases a read that is already pending, which a signal
          // check between reads cannot do.
          void reader.cancel().catch(() => undefined);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        try {
          while (true) {
            const chunk = await Promise.race([reader.read(), aborted]);
            if (signal.aborted) throw new DOMException("cancelled", "AbortError");
            if (chunk.done) break;
            yield chunk.value;
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      })();
    },
  };
}
