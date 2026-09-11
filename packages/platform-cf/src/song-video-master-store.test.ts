import { describe, expect, test } from "bun:test";
import {
  makeR2SongVideoMasterSource,
  makeR2SongVideoOutputStore,
} from "./song-video-master-store.ts";

const masterRef = "media://immutable/song-video-masters/song-video-plan:submission-1/g1";
const physicalKey = "immutable/song-video-masters/song-video-plan:submission-1/g1";
const bytes = new TextEncoder().encode("sealed-master-bytes");

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function makeBucket(input: Readonly<{ key?: string; version?: string }> = {}) {
  const seen: string[] = [];
  const object = {
    key: input.key ?? physicalKey,
    version: input.version ?? "version-7",
    etag: "etag-7",
    arrayBuffer: async () => bytes.slice().buffer,
    body: stream(bytes),
  };
  return {
    seen,
    bucket: {
      get: async (key: string) => {
        seen.push(key);
        return key === object.key ? object : null;
      },
    } as unknown as R2Bucket,
  };
}

describe("song video master store", () => {
  test("maps the immutable reference to the shared physical key", async () => {
    const { bucket, seen } = makeBucket();
    const store = makeR2SongVideoOutputStore(bucket);
    expect(await store.read(masterRef)).toEqual({
      bytes,
      objectVersion: "version-7",
      etag: "etag-7",
    });
    expect(seen).toEqual([physicalKey]);
  });

  test("refuses a version that is not the object currently stored", async () => {
    const store = makeR2SongVideoOutputStore(makeBucket().bucket);
    expect(await store.readVersion(masterRef, "version-7")).toEqual(bytes);
    expect(await store.readVersion(masterRef, "version-6")).toBeNull();
  });

  test("streams the accepted master by its exact recorded version", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket().bucket);
    const chunks: Uint8Array[] = [];
    const opened = await source.open(masterRef, "version-7", new AbortController().signal);
    if (opened === null) throw new Error("master not opened");
    for await (const chunk of opened) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  });

  test("refuses a master when the bucket holds a different version", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket({ version: "version-8" }).bucket);
    expect(await source.open(masterRef, "version-7", new AbortController().signal)).toBeNull();
  });

  test("refuses a reference that is not an immutable media reference", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket().bucket);
    expect(
      source.open("song-video-masters/plan/g1", "version-7", new AbortController().signal),
    ).rejects.toThrow("invalid immutable media reference");
  });
});
