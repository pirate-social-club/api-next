import type { SongVideoOutputWriter } from "@pirate/application/video/song-render";
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
 * The host writes each attempt's output once, under a conditional put: a
 * second write to the same address reports `occupied` and replaces nothing, so
 * a lost acknowledgement or a restarted execution reconciles from what the
 * store holds. These adapters fail closed when the exact verified version is
 * not what the bucket holds. A refusal never leaves a body dangling, a stale
 * version is refused before it is buffered, and the ratified ceiling bounds
 * any allocation.
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

export function makeR2SongVideoOutputWriter(bucket: R2Bucket): SongVideoOutputWriter {
  return {
    writeOnce: async (objectKey, bytes, sha256) => {
      const object = await bucket.put(mediaProcessingPhysicalObjectKey(objectKey), bytes, {
        // The conditional is the write-once rule: an address that already holds
        // an object is never replaced, whoever wrote it.
        onlyIf: new Headers({ "if-none-match": "*" }),
        httpMetadata: { contentType: "video/mp4" },
        // The store verifies the payload against this digest, so bytes it did
        // not accept never enter the address sealing will read.
        sha256,
      });
      if (object === null) return { status: "occupied" };
      // Sealing resolves the version it verified, so a store that cannot name
      // one has produced an object nothing downstream could accept.
      if (object.version.trim().length === 0 || object.etag.trim().length === 0) {
        throw new Error("song video output is not addressable");
      }
      return { status: "written" };
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
