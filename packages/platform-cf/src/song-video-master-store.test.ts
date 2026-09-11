import { describe, expect, test } from "bun:test";
import { SONG_VIDEO_MASTER_POLICY_V1 } from "@pirate/domain";
import {
  makeR2SongVideoMasterSource,
  makeR2SongVideoOutputStore,
  makeR2SongVideoOutputWriter,
} from "./song-video-master-store.ts";

const masterRef = "media://immutable/song-video-masters/song-video-plan:submission-1/g1";
const physicalKey = "immutable/song-video-masters/song-video-plan:submission-1/g1";
const bytes = new TextEncoder().encode("sealed-master-bytes");

type BucketOptions = Readonly<{
  key?: string;
  etag?: string;
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
        etag: input.etag ?? "etag-7",
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
      objectVersion: "etag-7",
      etag: "etag-7",
    });
    expect(seen).toEqual([physicalKey]);
  });

  test("records the normalized ETag and refuses a different identity before buffering", async () => {
    const quoted = makeBucket({ etag: '"etag-9"' });
    const store = makeR2SongVideoOutputStore(quoted.bucket);
    expect(await store.read(masterRef)).toMatchObject({
      objectVersion: "etag-9",
      etag: "etag-9",
    });
    expect(await store.readVersion(masterRef, "etag-9")).toEqual(bytes);
    const stale = makeBucket();
    expect(
      await makeR2SongVideoOutputStore(stale.bucket).readVersion(masterRef, "etag-6"),
    ).toBeNull();
    expect(stale.counters()).toEqual({ cancelled: 1, buffered: 0 });
  });

  test("refuses an oversized object before allocating", async () => {
    const oversized = makeBucket({ size: SONG_VIDEO_MASTER_POLICY_V1.maxBytes + 1 });
    const store = makeR2SongVideoOutputStore(oversized.bucket);
    expect(await store.read(masterRef)).toBeNull();
    expect(await store.readVersion(masterRef, "etag-7")).toBeNull();
    expect(oversized.counters()).toEqual({ cancelled: 2, buffered: 0 });
  });

  test("streams the accepted master by its exact recorded version", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket().bucket);
    const chunks: Uint8Array[] = [];
    const opened = await source.open(masterRef, "etag-7", new AbortController().signal);
    if (opened === null) throw new Error("master not opened");
    for await (const chunk of opened) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
  });

  test("refuses a master when the bucket holds a different identity and cancels the body", async () => {
    const other = makeBucket({ etag: '"etag-8"' });
    const source = makeR2SongVideoMasterSource(other.bucket);
    expect(await source.open(masterRef, "etag-7", new AbortController().signal)).toBeNull();
    expect(other.counters()).toEqual({ cancelled: 1, buffered: 0 });
  });

  test("abort interrupts a pending read and releases the body", async () => {
    const pending = makeBucket({ pending: true });
    const source = makeR2SongVideoMasterSource(pending.bucket);
    const controller = new AbortController();
    const opened = await source.open(masterRef, "etag-7", controller.signal);
    if (opened === null) throw new Error("master not opened");
    const next = opened[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(next).rejects.toThrow("cancelled");
    expect(pending.counters().cancelled).toBeGreaterThanOrEqual(1);
  });

  test("refuses a reference that is not an immutable media reference", async () => {
    const source = makeR2SongVideoMasterSource(makeBucket().bucket);
    expect(
      source.open("song-video-masters/plan/g1", "etag-7", new AbortController().signal),
    ).rejects.toThrow("invalid immutable media reference");
  });
});

function makeWriteBucket(input: Readonly<{ unaddressable?: boolean }> = {}) {
  const puts: Array<{
    key: string;
    onlyIf: string | null;
    contentType: string | undefined;
    sha256: string | undefined;
  }> = [];
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (
      key: string,
      value: Uint8Array,
      options: Readonly<{
        onlyIf?: Headers;
        httpMetadata?: Readonly<{ contentType?: string }>;
        sha256?: string;
      }>,
    ) => {
      puts.push({
        key,
        onlyIf: options.onlyIf?.get("if-none-match") ?? null,
        contentType: options.httpMetadata?.contentType,
        sha256: options.sha256,
      });
      // The conditional is real in this fake: an occupied address refuses.
      if (objects.has(key)) return null;
      objects.set(key, value.slice());
      return input.unaddressable === true
        ? { version: "", etag: "" }
        : { version: "version-7", etag: '"etag-7"' };
    },
  } as unknown as R2Bucket;
  return { bucket, puts, objects };
}

describe("song video master write", () => {
  test("writes an attempt's output once under a conditional put", async () => {
    const fake = makeWriteBucket();
    const writer = makeR2SongVideoOutputWriter(fake.bucket);
    const masterBytes = new TextEncoder().encode("sealed-master-bytes");
    expect(await writer.writeOnce(masterRef, masterBytes, "a".repeat(64))).toEqual({
      status: "written",
    });
    expect(
      await writer.writeOnce(masterRef, new TextEncoder().encode("other"), "b".repeat(64)),
    ).toEqual({ status: "occupied" });
    expect(fake.puts).toEqual([
      { key: physicalKey, onlyIf: "*", contentType: "video/mp4", sha256: "a".repeat(64) },
      { key: physicalKey, onlyIf: "*", contentType: "video/mp4", sha256: "b".repeat(64) },
    ]);
    // The first bytes survive the refused second write.
    expect(fake.objects.get(physicalKey)).toEqual(masterBytes);
  });

  test("refuses an output object the store cannot address", async () => {
    const writer = makeR2SongVideoOutputWriter(makeWriteBucket({ unaddressable: true }).bucket);
    expect(
      writer.writeOnce(masterRef, new TextEncoder().encode("sealed-master-bytes"), "a".repeat(64)),
    ).rejects.toThrow("song video output is not addressable");
  });
});
