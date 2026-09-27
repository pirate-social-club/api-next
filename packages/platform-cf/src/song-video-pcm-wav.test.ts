import { describe, expect, test } from "bun:test";
import { makeSongVideoPcmWavHeader } from "./song-video-pcm-wav.ts";

describe("song-video PCM WAV header", () => {
  test("wraps exactly 15 seconds of stereo 48 kHz s16le PCM", () => {
    const header = makeSongVideoPcmWavHeader(720_000);
    const view = new DataView(header.buffer);
    expect(header.byteLength).toBe(44);
    expect(new TextDecoder().decode(header.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(2_880_036);
    expect(new TextDecoder().decode(header.subarray(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(192_000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(new TextDecoder().decode(header.subarray(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(2_880_000);
  });

  test.each([-1, 0, 0.5, 143_999, 720_001, Number.MAX_SAFE_INTEGER])(
    "refuses an invalid sample-frame count: %p",
    (sampleFrames) => {
      expect(() => makeSongVideoPcmWavHeader(sampleFrames)).toThrow(TypeError);
    },
  );
});
