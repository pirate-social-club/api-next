import type { SongVideoOutputWriter } from "@pirate/application/video/song-render";
import { SONG_VIDEO_MASTER_POLICY_V1, VIDEO_INGEST_POLICY_V1 } from "@pirate/domain";
import { mediaProcessingPhysicalObjectKey } from "../packages/platform-cf/src/media-immutable-object-key.ts";
import { normalizeObjectEtag } from "../packages/platform-cf/src/song-video-master-store.ts";
import type { SongVideoOutputStore } from "../packages/platform-cf/src/song-video-output-verification.ts";
import { type StagingCredentials, signR2Request } from "./media/r2-seal-probe-staging-signing.ts";
import type { SongVideoMediaReader } from "./song-video-ffmpeg.ts";

/**
 * The render host's production R2 adapters.
 *
 * The host is a separate process, so it reaches the immutable-originals bucket
 * through the signed S3 endpoint rather than a Worker binding. It addresses the
 * same keyspace, applies the same conditional write-once rule, and records the
 * same normalized-ETag object identity a Worker-backed adapter uses, so a
 * master written here is the object sealing, Stream grants, playback and DATA
 * already expect. Reads are bounded by the ratified policies, and a refused
 * response is cancelled rather than left dangling.
 */

export type HostR2Transport = Readonly<{
  send: (request: {
    readonly bucket: string;
    readonly key?: string;
    readonly method: "GET" | "HEAD" | "PUT";
    readonly query?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
  }) => Promise<Response>;
}>;

export function makeHostR2Transport(
  input: Readonly<{
    accountId: string;
    credentials: StagingCredentials;
    endpoint?: string;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => Date;
  }>,
): HostR2Transport {
  return {
    send: async (request) => {
      const signed = await signR2Request({
        accountId: input.accountId,
        bucket: request.bucket,
        ...(request.key === undefined ? {} : { key: request.key }),
        method: request.method,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: request.body }),
        now: input.now?.() ?? new Date(),
        credentials: input.credentials,
      });
      const url =
        input.endpoint === undefined
          ? signed.url
          : signed.url.replace(/^https:\/\/[^/]+/u, input.endpoint.replace(/\/$/u, ""));
      return (input.fetch ?? fetch)(url, {
        method: signed.method,
        headers: signed.headers,
        body: signed.body as unknown as BodyInit,
        redirect: "error",
        cache: "no-store",
      });
    },
  };
}

function hexToBase64(hex: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hex)) throw new Error("invalid sha256 digest");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes));
}

const discard = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      await discard(response);
      throw new Error("song video response exceeds the read bound");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) throw new Error("song video response exceeds the read bound");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type HostAdapterInput = Readonly<{ transport: HostR2Transport; bucket: string }>;

export function makeHostMasterOutputStore(input: HostAdapterInput): SongVideoOutputStore {
  const physical = (objectKey: string) => mediaProcessingPhysicalObjectKey(objectKey);
  return {
    read: async (objectKey) => {
      const response = await input.transport.send({
        bucket: input.bucket,
        key: physical(objectKey),
        method: "GET",
      });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw new Error("song video master read failed");
      }
      const bytes = await readBoundedBytes(response, SONG_VIDEO_MASTER_POLICY_V1.maxBytes);
      const etag = normalizeObjectEtag(response.headers.get("etag") ?? "");
      return { bytes, objectVersion: etag, etag };
    },
    readVersion: async (objectKey, objectVersion) => {
      const response = await input.transport.send({
        bucket: input.bucket,
        key: physical(objectKey),
        method: "GET",
      });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw new Error("song video master version read failed");
      }
      // The recorded identity is the normalized ETag, so the current object is
      // read and compared; no S3 version field is assumed to match a binding.
      if (normalizeObjectEtag(response.headers.get("etag") ?? "") !== objectVersion) {
        await discard(response);
        return null;
      }
      return readBoundedBytes(response, SONG_VIDEO_MASTER_POLICY_V1.maxBytes);
    },
  };
}

export function makeHostMasterOutputWriter(input: HostAdapterInput): SongVideoOutputWriter {
  return {
    writeOnce: async (objectKey, bytes, sha256) => {
      const response = await input.transport.send({
        bucket: input.bucket,
        key: mediaProcessingPhysicalObjectKey(objectKey),
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-length": String(bytes.byteLength),
          // The address is written once; the checksum makes the store refuse a
          // payload it did not accept.
          "if-none-match": "*",
          "x-amz-checksum-sha256": hexToBase64(sha256),
        },
        body: bytes,
      });
      if (response.status === 412) {
        await discard(response);
        return { status: "occupied" };
      }
      if (!response.ok) {
        await discard(response);
        throw new Error("song video master write failed");
      }
      // The recorded identity is the normalized ETag; an object the store
      // cannot name is unusable rather than a master.
      if (normalizeObjectEtag(response.headers.get("etag") ?? "").length === 0) {
        await discard(response);
        throw new Error("song video output is not addressable");
      }
      await discard(response);
      return { status: "written" };
    },
  };
}

export function makeHostMediaReader(input: HostAdapterInput): SongVideoMediaReader {
  return {
    read: async (reference) => {
      const response = await input.transport.send({
        bucket: input.bucket,
        key: mediaProcessingPhysicalObjectKey(reference),
        method: "GET",
      });
      if (!response.ok) {
        await discard(response);
        throw new Error("song video media read failed");
      }
      return readBoundedBytes(response, VIDEO_INGEST_POLICY_V1.maxBytes);
    },
  };
}
