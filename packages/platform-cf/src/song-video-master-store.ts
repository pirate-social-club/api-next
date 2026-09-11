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
 * version is not what the bucket currently holds.
 */

export function makeR2SongVideoOutputStore(bucket: R2Bucket): SongVideoOutputStore {
  const read = async (objectKey: string) => {
    const object = await bucket.get(mediaProcessingPhysicalObjectKey(objectKey));
    if (object === null) return null;
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      objectVersion: object.version,
      etag: object.etag,
    };
  };
  return {
    read,
    readVersion: async (objectKey, objectVersion) => {
      const current = await read(objectKey);
      // Write-once keys make the latest object the only candidate; the version
      // still has to match, so a replaced or unversioned object refuses.
      return current === null || current.objectVersion !== objectVersion ? null : current.bytes;
    },
  };
}

export function makeR2SongVideoMasterSource(bucket: R2Bucket): DataRegistrationMasterSource {
  return {
    open: async (objectKey, objectVersion, signal) => {
      const object = await bucket.get(mediaProcessingPhysicalObjectKey(objectKey));
      if (object === null) return null;
      if (object.version !== objectVersion) return null;
      const reader = object.body.getReader();
      return (async function* () {
        try {
          while (true) {
            if (signal.aborted) throw new DOMException("cancelled", "AbortError");
            const chunk = await reader.read();
            if (chunk.done) break;
            yield chunk.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      })();
    },
  };
}
