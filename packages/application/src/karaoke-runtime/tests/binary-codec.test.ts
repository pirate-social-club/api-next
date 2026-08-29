import { describe, expect, test } from "bun:test";
import {
  decodeKaraokeBinaryFrame,
  encodeKaraokeBinaryFrame,
  KARAOKE_BINARY_HEADER_BYTES,
  KARAOKE_MAX_BINARY_FRAME_BYTES,
} from "../binary-codec";
import type { KaraokeClientBinaryFrame } from "../transport";

function frame(overrides: Partial<KaraokeClientBinaryFrame> = {}): KaraokeClientBinaryFrame {
  return {
    attemptId: "attempt-1",
    chunkId: 1,
    pcm16: new Uint8Array([1, 2, 3, 4]).buffer,
    protocolVersion: 1,
    sampleRate: 16_000,
    sequence: 4,
    sessionId: "session-1",
    songEndMs: 200,
    songStartMs: 100,
    type: "audio_chunk",
    ...overrides,
  };
}

function decode(buffer: ArrayBuffer) {
  return decodeKaraokeBinaryFrame(buffer, {
    attemptId: "attempt-1",
    sessionId: "session-1",
  });
}

describe("karaoke binary codec", () => {
  test("round-trips the fixed header and PCM payload", () => {
    const input = frame();
    const result = decode(encodeKaraokeBinaryFrame(input));
    expect(result.error).toBeUndefined();
    expect(
      result.frame && { ...result.frame, pcm16: [...new Uint8Array(result.frame.pcm16)] },
    ).toEqual({
      ...input,
      pcm16: [1, 2, 3, 4],
    });
  });

  test("rejects magic, version, flags, and header-length mismatches", () => {
    const magic = encodeKaraokeBinaryFrame(frame());
    new Uint8Array(magic)[0] = 0;
    expect(decode(magic).error?.code).toBe("binary_magic_mismatch");

    const version = encodeKaraokeBinaryFrame(frame());
    new DataView(version).setUint8(4, 2);
    expect(decode(version).error?.code).toBe("binary_version_mismatch");

    const flags = encodeKaraokeBinaryFrame(frame());
    new DataView(flags).setUint8(5, 1);
    expect(decode(flags).error?.code).toBe("binary_unknown_flags");

    const header = encodeKaraokeBinaryFrame(frame());
    new DataView(header).setUint16(6, KARAOKE_BINARY_HEADER_BYTES + 1, false);
    expect(decode(header).error?.code).toBe("binary_truncated");
  });

  test("rejects truncated, oversized, odd PCM, and invalid sample-rate frames", () => {
    expect(decode(new ArrayBuffer(10)).error?.code).toBe("binary_truncated");
    expect(decode(new ArrayBuffer(KARAOKE_MAX_BINARY_FRAME_BYTES + 1)).error?.code).toBe(
      "binary_oversized_frame",
    );

    const odd = new ArrayBuffer(KARAOKE_BINARY_HEADER_BYTES + 1);
    new Uint8Array(odd).set(
      new Uint8Array(encodeKaraokeBinaryFrame(frame({ pcm16: new ArrayBuffer(0) }))),
    );
    expect(decode(odd).error?.code).toBe("binary_odd_pcm_length");

    const rate = encodeKaraokeBinaryFrame(frame());
    new DataView(rate).setUint32(16, 48_000, false);
    expect(decode(rate).error?.code).toBe("binary_invalid_sample_rate");
  });

  test("rejects zero chunk IDs and reversed timestamps", () => {
    const chunk = encodeKaraokeBinaryFrame(frame());
    new DataView(chunk).setUint32(12, 0, false);
    expect(decode(chunk).error?.code).toBe("invalid_event_payload");

    const timestamps = encodeKaraokeBinaryFrame(frame());
    new DataView(timestamps).setUint32(20, 300, false);
    new DataView(timestamps).setUint32(24, 200, false);
    expect(decode(timestamps).error?.code).toBe("invalid_event_payload");
    expect(() => encodeKaraokeBinaryFrame(frame({ chunkId: -1 }))).toThrow(RangeError);
  });

  test("does not allow a caller to raise the hard frame-size cap", () => {
    const result = decodeKaraokeBinaryFrame(new ArrayBuffer(KARAOKE_MAX_BINARY_FRAME_BYTES + 1), {
      attemptId: "attempt-1",
      maxFrameBytes: KARAOKE_MAX_BINARY_FRAME_BYTES * 2,
      sessionId: "session-1",
    });
    expect(result.error?.code).toBe("binary_oversized_frame");
  });
});
