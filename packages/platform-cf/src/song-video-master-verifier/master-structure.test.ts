import { describe, expect, test } from "bun:test";

import {
  inspectSongVideoMasterStructure,
  MAX_SONG_VIDEO_MASTER_BYTES,
  SongVideoMasterRejection,
} from "./master-structure.ts";

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer());

const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

function boxTypeOffset(bytes: Uint8Array, type: string, occurrence = 0): number {
  const needle = new TextEncoder().encode(type);
  let seen = 0;
  for (let index = 4; index < bytes.length - 4; index++) {
    if (needle.every((byte, part) => bytes[index + part] === byte)) {
      if (seen++ === occurrence) return index;
    }
  }
  throw new Error(`missing fixture box ${type}`);
}

describe("strict Song video master structure", () => {
  test("pins the two synthetic master fixtures", async () => {
    const short = await fixture("master.mp4");
    const full = await fixture("master-15s.mp4");
    expect(await digest(short)).toBe(
      "11bd132263930ba6c3c38706f3e55663656824a16613b2a0f025af452c470058",
    );
    expect(await digest(full)).toBe(
      "e8610deb4ae887cba50abd2bab6b125367b72fe7049064faa6cc0fba77650a3e",
    );
    const shortShape = inspectSongVideoMasterStructure(short, 150_000);
    expect([shortShape.videoFrameCount, shortShape.audioChunkCount]).toEqual([94, 33]);
    const fullShape = inspectSongVideoMasterStructure(full, 720_000);
    expect([fullShape.videoFrameCount, fullShape.audioChunkCount]).toEqual([450, 450]);
  });

  test("rejects missing, overlong and invalid-size master bytes before parsing", async () => {
    const bytes = await fixture("master.mp4");
    expect(() => inspectSongVideoMasterStructure(new Uint8Array(0), 150_000)).toThrow(
      "master_size",
    );
    expect(() =>
      inspectSongVideoMasterStructure(new Uint8Array(MAX_SONG_VIDEO_MASTER_BYTES + 1), 150_000),
    ).toThrow("master_size");
    expect(() =>
      inspectSongVideoMasterStructure(bytes.subarray(0, bytes.length - 1), 150_000),
    ).toThrow("invalid_box_envelope");
    expect(() => inspectSongVideoMasterStructure(bytes, 150_001)).toThrow(SongVideoMasterRejection);
    expect(() => inspectSongVideoMasterStructure(bytes, 15 * 48_000 + 1)).toThrow(
      "invalid_expected_duration",
    );
  });

  test("refuses unknown top-level boxes and an unadmitted file brand", async () => {
    const bytes = await fixture("master.mp4");
    const extra = new Uint8Array(bytes.length + 8);
    extra.set(bytes);
    new DataView(extra.buffer).setUint32(bytes.length, 8);
    extra.set(new TextEncoder().encode("junk"), bytes.length + 4);
    expect(() => inspectSongVideoMasterStructure(extra, 150_000)).toThrow("unexpected_box_layout");
    const brand = bytes.slice();
    brand.set(new TextEncoder().encode("evil"), 8);
    expect(() => inspectSongVideoMasterStructure(brand, 150_000)).toThrow("invalid_ftyp");

    const metadata = bytes.slice();
    metadata.set(new TextEncoder().encode("junk"), boxTypeOffset(metadata, "udta"));
    expect(() => inspectSongVideoMasterStructure(metadata, 150_000)).toThrow(
      "unexpected_box_layout",
    );
  });

  test("refuses substituted codecs, audio sample extents and video packet timing", async () => {
    const bytes = await fixture("master.mp4");
    const codec = bytes.slice();
    codec.set(new TextEncoder().encode("mp4a"), boxTypeOffset(codec, "ipcm"));
    expect(() => inspectSongVideoMasterStructure(codec, 150_000)).toThrow();

    const extent = bytes.slice();
    const audioOffsets = boxTypeOffset(extent, "stco", 1);
    const firstAudioOffset = audioOffsets + 12;
    new DataView(extent.buffer).setUint32(
      firstAudioOffset,
      new DataView(extent.buffer).getUint32(firstAudioOffset) + 1,
    );
    expect(() => inspectSongVideoMasterStructure(extent, 150_000)).toThrow();

    const timing = bytes.slice();
    const videoTimes = boxTypeOffset(timing, "stts");
    const lastFrameDuration = videoTimes + 24;
    new DataView(timing.buffer).setUint32(lastFrameDuration, 1_199);
    expect(() => inspectSongVideoMasterStructure(timing, 150_000)).toThrow();
  });

  test("rejects a malformed PCM sample entry", async () => {
    const bytes = await fixture("master.mp4");
    const changed = bytes.slice();
    const pcmC = boxTypeOffset(changed, "pcmC");
    changed[pcmC + 9] = 24;
    expect(() => inspectSongVideoMasterStructure(changed, 150_000)).toThrow("invalid_pcm_config");
  });

  test("rejects a video entry without AVC decoder configuration", async () => {
    const bytes = await fixture("master.mp4");
    const changed = bytes.slice();
    changed.set(new TextEncoder().encode("junk"), boxTypeOffset(changed, "avcC"));
    expect(() => inspectSongVideoMasterStructure(changed, 150_000)).toThrow(
      "unexpected_track_shape",
    );
  });

  test("bounds declared sample counts before walking chunks", async () => {
    const bytes = await fixture("master.mp4");
    const changed = bytes.slice();
    const sizes = boxTypeOffset(changed, "stsz");
    new DataView(changed.buffer).setUint32(sizes + 12, 0xffff_ffff);
    expect(() => inspectSongVideoMasterStructure(changed, 150_000)).toThrow("invalid_stsz");
  });
});
