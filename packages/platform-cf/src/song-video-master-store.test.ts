import { describe, expect, test } from "bun:test";
import { SONG_VIDEO_MASTER_POLICY_V1 } from "@pirate/domain";
import {
  makeR2SongVideoMasterSource,
  makeR2SongVideoOutputStore,
} from "./song-video-master-store.ts";

const masterRef = "media://immutable/song-video-masters/song-video-plan:submission-1/g1";
const physicalKey = "immutable/song-video-masters/song-video-plan:submission-1/g1";
const bytes = new TextEncoder().encode("sealed-master-bytes");

type BucketOptions = Readonly<{
  key?: string;
  version?: string;
  size?: number;
  bytes?: Uint8Array;
  /** No data is enqueued, so a read stays pending until the body is cancelled. */
  pending?: boolean;
}>;

function makeBucket(input: BucketOptions = {}) {
  const seen: string[] = [];
  let cancelled = 0;
  let buffered = 0;
  const bodyBytes = input.bytes ?? bytes;
  const bucket = {
    get: async (key: string) => {
      seen.push(key);
      if (key !== (input.key ?? physicalKey)) return null;
      return {
        key,
        version: input.version ?? "version-7",
        etag: "etag-7",
        size: input.size ?? bodyBytes.byteLength,
        arrayBuffer: async () => {
          buffered += 1;
          return bodyBytes.slice().buffer;
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            if (input.pending !== true) {
              controller.enqueue(bodyBytes);
              controller.close();
            }
          },
          cancel() {
            cancelled += 1;
          },
        }),
      };
    },
  } as unknown as R2Bucket;
  return { seen, bucket, counters: () => ({ cancelled, buffered }) };
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

  test("refuses a version that is not the object currently stored, before buffering", async () => {
    const store = makeR2SongVideoOutputStore(makeBucket().bucket);
    expect(await store.readVersion(masterRef, "version-7")).toEqual(bytes);
    const stale = makeBucket();
    expect(
      await makeR2SongVideoOutputStore(stale.bucket).readVersion(masterRef, "version-6"),
    ).toBeNull();
    expect(stale.counters()).toEqual({ cancelled: 1, buffered: 0 });
  });

  test("refuses an oversized object before allocating", async () => {
    const oversized = makeBucket({ size: SONG_VIDEO_MASTER_POLICY_V1.maxBytes + 1 });
    const store = makeR2SongVideoOutputStore(oversized.bucket);
    expect(await store.read(masterRef)).toBeNull();
    expect(await store.readVersion(masterRef, "version-7")).toBeNull();
    expect(oversized.counters()).toEqual({ cancelled: 2, buffered: 0 });
  });

  test("streams the accepted master by its exact recorded version", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket().bucket);
    const chunks: Uint8Array[] = [];
    const opened = await source.open(masterRef, "version-7", new AbortController().signal);
    if (opened === null) throw new Error("master not opened");
    for await (const chunk of opened) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  });

  test("refuses a master when the bucket holds a different version and cancels the body", async () => {
    const other = makeBucket({ version: "version-8" });
    const source = makeR2SongVideoMasterSource(other.bucket);
    expect(await source.open(masterRef, "version-7", new AbortController().signal)).toBeNull();
    expect(other.counters()).toEqual({ cancelled: 1, buffered: 0 });
  });

  test("abort interrupts a pending read and releases the body", async () => {
    const pending = makeBucket({ pending: true });
    const source = makeR2SongVideoMasterSource(pending.bucket);
    const controller = new AbortController();
    const opened = await source.open(masterRef, "version-7", controller.signal);
    if (opened === null) throw new Error("master not opened");
    const next = opened[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(next).rejects.toThrow("cancelled");
    expect(pending.counters().cancelled).toBeGreaterThanOrEqual(1);
  });

  test("refuses a reference that is not an immutable media reference", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket().bucket);
    expect(
      source.open("song-video-masters/plan/g1", "version-7", new AbortController().signal),
    ).rejects.toThrow("invalid immutable media reference");
  });
});
