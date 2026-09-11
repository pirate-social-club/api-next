import type { SongVideoOutputWriter } from "@pirate/application/video/song-render";
import { mediaProcessingPhysicalObjectKey } from "../packages/platform-cf/src/media-immutable-object-key.ts";
import type { SongVideoOutputStore } from "../packages/platform-cf/src/song-video-output-verification.ts";
import { type StagingCredentials, signR2Request } from "./media/r2-seal-probe-staging-signing.ts";
import type { SongVideoMediaReader } from "./song-video-ffmpeg.ts";

/**
 * The render host's production R2 adapters.
 *
 * The host is a separate process, so it reaches the immutable-originals bucket
 * through the signed S3 endpoint rather than a Worker binding. It addresses the
 * same keyspace, applies the same conditional write-once rule, and resolves the
 * same recorded version a Worker-backed adapter does, so a master written here
 * is the object sealing, Stream grants, playback and DATA already expect.
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
      return (input.fetch ?? fetch)(signed.url, {
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
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("song video master read failed");
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        objectVersion: response.headers.get("x-amz-version-id") ?? "",
        etag: response.headers.get("etag") ?? "",
      };
    },
    readVersion: async (objectKey, objectVersion) => {
      const response = await input.transport.send({
        bucket: input.bucket,
        key: physical(objectKey),
        method: "GET",
        query: { versionId: objectVersion },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("song video master version read failed");
      return new Uint8Array(await response.arrayBuffer());
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
      if (response.status === 412) return { status: "occupied" };
      if (!response.ok) throw new Error("song video master write failed");
      const version = response.headers.get("x-amz-version-id");
      const etag = response.headers.get("etag");
      // Sealing resolves the version it verified; an unaddressable write is
      // unusable rather than a master.
      if (version === null || version.length === 0 || etag === null || etag.length === 0) {
        throw new Error("song video output is not addressable");
      }
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
      if (!response.ok) throw new Error("song video media read failed");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
