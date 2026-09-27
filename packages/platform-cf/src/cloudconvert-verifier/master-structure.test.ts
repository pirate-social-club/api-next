import { describe, expect, test } from "bun:test";

import {
  CloudConvertMasterRejection,
  inspectCloudConvertMasterStructure,
  MAX_CLOUDCONVERT_MASTER_BYTES,
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

describe("strict CloudConvert master structure", () => {
  test("pins the two synthetic master fixtures", async () => {
    const short = await fixture("master.mp4");
    const full = await fixture("master-15s.mp4");
    expect(await digest(short)).toBe(
      "4aab52a097d068f08af7bd1646f7575f20b0f18dbdf20ad7e07783d7f5d5146b",
    );
    expect(await digest(full)).toBe(
      "e709fb0373177ef21c9195cd783771b7c89fb5808242b618a05210af7f5c1b8c",
    );
    expect(inspectCloudConvertMasterStructure(short, 150_000)).toMatchObject({
      videoFrameCount: 94,
      audioPacketCount: 33,
    });
    expect(inspectCloudConvertMasterStructure(full, 720_000)).toMatchObject({
      videoFrameCount: 450,
      audioPacketCount: 157,
    });
  });

  test("rejects missing, overlong and invalid-size master bytes before parsing", async () => {
    const bytes = await fixture("master.mp4");
    expect(() => inspectCloudConvertMasterStructure(new Uint8Array(0), 150_000)).toThrow(
      "master_size",
    );
    expect(() =>
      inspectCloudConvertMasterStructure(
        new Uint8Array(MAX_CLOUDCONVERT_MASTER_BYTES + 1),
        150_000,
      ),
    ).toThrow("master_size");
    expect(() =>
      inspectCloudConvertMasterStructure(bytes.subarray(0, bytes.length - 1), 150_000),
    ).toThrow("invalid_box_envelope");
    expect(() => inspectCloudConvertMasterStructure(bytes, 150_001)).toThrow(
      CloudConvertMasterRejection,
    );
    expect(() => inspectCloudConvertMasterStructure(bytes, 15 * 48_000 + 1)).toThrow(
      "invalid_expected_duration",
    );
  });

  test("refuses unknown top-level boxes and an unadmitted file brand", async () => {
    const bytes = await fixture("master.mp4");
    const extra = new Uint8Array(bytes.length + 8);
    extra.set(bytes);
    new DataView(extra.buffer).setUint32(bytes.length, 8);
    extra.set(new TextEncoder().encode("junk"), bytes.length + 4);
    expect(() => inspectCloudConvertMasterStructure(extra, 150_000)).toThrow(
      "unexpected_box_layout",
    );
    const brand = bytes.slice();
    brand.set(new TextEncoder().encode("evil"), 8);
    expect(() => inspectCloudConvertMasterStructure(brand, 150_000)).toThrow("invalid_ftyp");
  });

  test("refuses substituted codecs, audio sample extents and video packet timing", async () => {
    const bytes = await fixture("master.mp4");
    const codec = bytes.slice();
    codec.set(new TextEncoder().encode("mp4a"), boxTypeOffset(codec, "fLaC"));
    expect(() => inspectCloudConvertMasterStructure(codec, 150_000)).toThrow();

    const extent = bytes.slice();
    const audioSizes = boxTypeOffset(extent, "stsz", 1);
    const lastAudioSize = audioSizes + 12 + 32 * 4;
    new DataView(extent.buffer).setUint32(
      lastAudioSize,
      new DataView(extent.buffer).getUint32(lastAudioSize) + 1,
    );
    expect(() => inspectCloudConvertMasterStructure(extent, 150_000)).toThrow();

    const timing = bytes.slice();
    const videoTimes = boxTypeOffset(timing, "stts");
    const lastFrameDuration = videoTimes + 24;
    new DataView(timing.buffer).setUint32(lastFrameDuration, 1_199);
    expect(() => inspectCloudConvertMasterStructure(timing, 150_000)).toThrow();
  });

  test("rejects a malformed FLAC configuration before MP4Box's tolerant parser", async () => {
    const bytes = await fixture("master.mp4");
    const changed = bytes.slice();
    const dfLa = boxTypeOffset(changed, "dfLa");
    changed[dfLa + 8] = 0;
    expect(() => inspectCloudConvertMasterStructure(changed, 150_000)).toThrow(
      "invalid_flac_config",
    );
  });

  test("bounds declared sample counts before MP4Box allocates samples", async () => {
    const bytes = await fixture("master.mp4");
    const changed = bytes.slice();
    const sizes = boxTypeOffset(changed, "stsz");
    new DataView(changed.buffer).setUint32(sizes + 12, 0xffff_ffff);
    expect(() => inspectCloudConvertMasterStructure(changed, 150_000)).toThrow("invalid_stsz");
  });
});
