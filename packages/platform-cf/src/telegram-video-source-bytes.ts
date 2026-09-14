import type { SealedMediaObject } from "./telegram-poster-bytes.ts";
import type { TelegramVideoSource } from "./video-post-source-authority.ts";

/**
 * Bounded multipart ceiling. Telegram accepts bot video uploads up to 50 MB,
 * but a Worker buffers the object and the multipart copy, so the transfer
 * stays well below the provider ceiling and the Worker memory limit. This is
 * an explicit policy constant, not a provider limit.
 */
export const TELEGRAM_VIDEO_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function readBounded(found: SealedMediaObject): Promise<Uint8Array | null> {
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
 * Reads the accepted video source and verifies it before transfer: the key
 * must match the authority's physical key, the size must be positive and
 * within the upload ceiling, a declared content type must be video, and the
 * SHA-256 of the bytes must equal the accepted revision's canonical hash. Any
 * failure, including an interrupted stream, returns null so the caller falls
 * back to the poster or text.
 */
export function makeTelegramVideoSourceBytes(bucket: {
  get(key: string): Promise<SealedMediaObject | null>;
}) {
  return async (
    source: TelegramVideoSource,
  ): Promise<Readonly<{ bytes: Uint8Array; contentType: "video/mp4" }> | null> => {
    try {
      const found = await bucket.get(source.physicalKey);
      if (found === null || found.key !== source.physicalKey) return null;
      if (
        !Number.isSafeInteger(found.size) ||
        found.size <= 0 ||
        found.size > TELEGRAM_VIDEO_UPLOAD_MAX_BYTES
      )
        return null;
      const declared = found.httpMetadata?.contentType;
      if (declared !== undefined && !declared.startsWith("video/")) return null;
      const bytes = await readBounded(found);
      if (bytes === null || bytes.byteLength !== found.size || bytes.byteLength === 0) return null;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if (hex(digest) !== source.canonicalSha256) return null;
      return { bytes, contentType: "video/mp4" };
    } catch {
      return null;
    }
  };
}
