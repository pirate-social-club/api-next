import { describe, expect, it } from "bun:test";

import {
  isH264IdrAccessUnit,
  parseFfprobeHexdump,
  readAvccNalUnitTypes,
} from "./video-master-renderer-h264.ts";

describe("bounded H.264 AVCC access-unit inspection", () => {
  it("recognizes an IDR NAL in a length-prefixed packet", () => {
    const packet = Uint8Array.from([0, 0, 0, 2, 0x65, 0x80]);
    expect(readAvccNalUnitTypes(packet)).toEqual([5]);
    expect(isH264IdrAccessUnit(packet)).toBe(true);
  });

  it("rejects a keyframe-flagged non-IDR intra packet", () => {
    const keyframeFlagFromProbe = true;
    const packet = Uint8Array.from([0, 0, 0, 2, 0x41, 0x80]);
    expect(keyframeFlagFromProbe).toBe(true);
    expect(readAvccNalUnitTypes(packet)).toEqual([1]);
    expect(isH264IdrAccessUnit(packet)).toBe(false);
  });

  it("parses bounded ffprobe hex output and fails closed on malformed AVCC", () => {
    const bytes = parseFfprobeHexdump(
      "\n00000000: 0000 0002 6580                           ....e.\n",
    );
    expect([...bytes]).toEqual([0, 0, 0, 2, 0x65, 0x80]);
    expect(() => readAvccNalUnitTypes(Uint8Array.from([0, 0, 1]))).toThrow(
      "truncated AVCC NAL length",
    );
  });
});
