import { describe, expect, it } from "bun:test";

import {
  copiedPayloadsMatch,
  evaluateCopyEligibility,
  type ProbedVideoPacket,
  selectBriefPacketWindow,
} from "./video-master-renderer-packet-policy.ts";

const packet = (decodeOrder: number, ptsMs: number, keyframe = false): ProbedVideoPacket => ({
  decodeOrder,
  ptsMs,
  dtsMs: ptsMs,
  durationMs: 33.333,
  keyframe,
  payloadSha256: decodeOrder.toString(16).padStart(64, "0"),
});

describe("video master packet-tail policy", () => {
  it("keeps a complete presentation window when decode and presentation order agree", () => {
    const packets = [
      packet(0, 1_000, true),
      packet(1, 1_033.333),
      packet(2, 1_066.666),
      packet(3, 1_099.999),
      packet(4, 1_133.332),
    ];

    const window = selectBriefPacketWindow(packets, 1_000, 120);

    expect(window.packets.map(({ decodeOrder }) => decodeOrder)).toEqual([0, 1, 2]);
    expect(window.effectiveDurationMs).toBeCloseTo(99.999, 3);
    expect(window.isContiguousDecodePrefix).toBe(true);
    expect(window.packetManifestSha256).toHaveLength(64);
    expect(copiedPayloadsMatch(window.packets, window.packets)).toBe(true);
  });

  it("exposes the B-frame tail hole instead of claiming an undecodable copy is valid", () => {
    const packets = [
      packet(0, 2_066.667, true),
      packet(1, 2_200),
      packet(2, 2_133.333),
      packet(3, 2_100),
      packet(4, 2_166.667),
      // This future reference packet crosses the requested presentation end.
      packet(5, 2_966.667),
      // These B-frames are decoded later but presented inside the requested window.
      packet(6, 2_900),
      packet(7, 2_866.667),
      packet(8, 2_933.333),
    ];

    const window = selectBriefPacketWindow(packets, 2_066.667, 900);

    expect(window.packets.map(({ decodeOrder }) => decodeOrder)).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
    expect(window.isContiguousDecodePrefix).toBe(false);
    expect(copiedPayloadsMatch(window.packets, packets.slice(0, 7))).toBe(false);
  });

  it("rejects a start that is not an actual probed keyframe", () => {
    const packets = [packet(0, 1_000, true), packet(1, 1_033.333)];

    expect(() => selectBriefPacketWindow(packets, 1_010, 100)).toThrow(
      "copy start must equal a probed keyframe timestamp",
    );
  });

  it("demotes a stream when the probe or decode-order presentation timeline exposes reordering", () => {
    const firstPacket = packet(0, 1_000, true);
    const secondPacket = packet(1, 1_033.333);
    const packets = [firstPacket, secondPacket];
    expect(
      evaluateCopyEligibility({
        codecName: "h264",
        hasBFrames: 2,
        copyStartIsIdr: true,
        packets,
        startMs: 1_000,
        requestedDurationMs: 60,
      }),
    ).toEqual({ eligible: false, reason: "probe_reports_reordered_frames" });

    const misleadingProbe = [firstPacket, { ...secondPacket, ptsMs: 999, dtsMs: 1_000 }];
    expect(
      evaluateCopyEligibility({
        codecName: "h264",
        hasBFrames: 0,
        copyStartIsIdr: true,
        packets: misleadingProbe,
        startMs: 1_000,
        requestedDurationMs: 60,
      }),
    ).toEqual({ eligible: false, reason: "packet_timeline_reordered" });
  });

  it("accepts diagnostic decode offsets when presentation stays monotonic", () => {
    const packets = [
      { ...packet(0, 1_000, true), dtsMs: 990 },
      { ...packet(1, 1_033.333), dtsMs: 1_028.333 },
    ];
    const result = evaluateCopyEligibility({
      codecName: "h264",
      hasBFrames: 0,
      copyStartIsIdr: true,
      packets,
      startMs: 1_000,
      requestedDurationMs: 70,
    });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.window.decodePresentationOffsetMs).toEqual({ minimum: 5, maximum: 10 });
    }
  });

  it("demotes a keyframe-flagged start without verified IDR evidence", () => {
    const packets = [packet(0, 1_000, true), packet(1, 1_033.333)];
    expect(
      evaluateCopyEligibility({
        codecName: "h264",
        hasBFrames: 0,
        copyStartIsIdr: false,
        packets,
        startMs: 1_000,
        requestedDurationMs: 60,
      }),
    ).toEqual({ eligible: false, reason: "copy_start_not_idr" });
  });
});
