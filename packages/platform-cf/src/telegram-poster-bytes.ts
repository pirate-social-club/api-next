import type { TelegramPublicationPoster } from "@pirate/application/telegram";
import { matchesSealedVideoPoster } from "./video-poster-object.ts";

/** Minimal structural shape of the sealed derived-media bucket object. */
export interface SealedMediaObject {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string; readonly contentEncoding?: string };
  readonly customMetadata?: Record<string, string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  readonly body?: ReadableStream<Uint8Array>;
}

export interface SealedMediaBucket {
  get(key: string): Promise<SealedMediaObject | null>;
}

async function readBytes(found: SealedMediaObject): Promise<Uint8Array | null> {
  if (typeof found.arrayBuffer === "function") return new Uint8Array(await found.arrayBuffer());
  if (found.body === undefined) return null;
  const reader = found.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > found.size) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads sealed poster bytes for an authorized identity. The object must match
 * the authority's key, size ceiling, content type and hashes, so a bucket
 * entry alone is never enough. Missing storage, a mismatched object or a read
 * failure all return null and the caller falls back to text.
 */
export function makeTelegramPosterBytes(bucket: SealedMediaBucket) {
  return async (poster: TelegramPublicationPoster): Promise<Uint8Array | null> => {
    try {
      const found = await bucket.get(poster.key);
      if (found === null) return null;
      if (!matchesSealedVideoPoster(found, poster)) return null;
      const bytes = await readBytes(found);
      if (bytes === null || bytes.byteLength === 0 || bytes.byteLength !== found.size) return null;
      return bytes;
    } catch {
      return null;
    }
  };
}
