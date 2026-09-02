import { createHash } from "node:crypto";

export type ProbedVideoPacket = {
  readonly decodeOrder: number;
  readonly ptsMs: number;
  readonly dtsMs: number;
  readonly durationMs: number;
  readonly keyframe: boolean;
  readonly payloadSha256: string;
};

export type CopyEligibility =
  | { readonly eligible: true; readonly window: PacketWindow }
  | {
      readonly eligible: false;
      readonly reason:
        | "codec_not_h264"
        | "probe_reports_reordered_frames"
        | "packet_timeline_reordered"
        | "packet_window_not_decodable";
    };

export type PacketWindow = {
  readonly packets: readonly ProbedVideoPacket[];
  readonly effectiveDurationMs: number;
  readonly isContiguousDecodePrefix: boolean;
  readonly packetManifestSha256: string;
};

const timestampToleranceMs = 0.002;

function packetManifestSha256(packets: readonly ProbedVideoPacket[]): string {
  const hash = createHash("sha256");
  hash.update("video-packet-payload-manifest-v1\0");
  for (const packet of packets) {
    hash.update(packet.payloadSha256);
    hash.update(packet.keyframe ? "\0K\0" : "\0_\0");
  }
  return hash.digest("hex");
}

/**
 * Models the staging brief's copy window exactly. It deliberately does not
 * claim the selected packets form a decodable stream: reordered presentation
 * can make the policy select a non-contiguous decode-order sequence.
 */
export function selectBriefPacketWindow(
  packets: readonly ProbedVideoPacket[],
  startMs: number,
  requestedDurationMs: number,
): PacketWindow {
  if (!Number.isFinite(startMs) || !Number.isFinite(requestedDurationMs)) {
    throw new TypeError("packet-window timestamps must be finite");
  }
  if (requestedDurationMs <= 0) {
    throw new RangeError("requested duration must be positive");
  }

  const startIndex = packets.findIndex(
    (packet) => packet.keyframe && Math.abs(packet.ptsMs - startMs) <= timestampToleranceMs,
  );
  if (startIndex < 0) {
    throw new RangeError("copy start must equal a probed keyframe timestamp");
  }

  const requestedEndMs = startMs + requestedDurationMs;
  const selected = packets.slice(startIndex).filter((packet) => {
    const packetEndMs = packet.ptsMs + packet.durationMs;
    return (
      packet.ptsMs + timestampToleranceMs >= startMs &&
      packetEndMs <= requestedEndMs + timestampToleranceMs
    );
  });
  if (selected.length === 0) {
    throw new RangeError("copy window contains no complete video packet");
  }

  const isContiguousDecodePrefix = selected.every(
    (packet, offset) => packet.decodeOrder === startIndex + offset,
  );
  const visibleEndMs = Math.max(...selected.map((packet) => packet.ptsMs + packet.durationMs));

  return {
    packets: selected,
    effectiveDurationMs: visibleEndMs - startMs,
    isContiguousDecodePrefix,
    packetManifestSha256: packetManifestSha256(selected),
  };
}

export function copiedPayloadsMatch(
  expected: readonly ProbedVideoPacket[],
  observed: readonly ProbedVideoPacket[],
): boolean {
  return (
    expected.length === observed.length &&
    expected.every(
      (packet, index) =>
        packet.payloadSha256 === observed[index]?.payloadSha256 &&
        packet.keyframe === observed[index]?.keyframe,
    )
  );
}

export function evaluateCopyEligibility(input: {
  readonly codecName: string;
  readonly hasBFrames: number;
  readonly packets: readonly ProbedVideoPacket[];
  readonly startMs: number;
  readonly requestedDurationMs: number;
}): CopyEligibility {
  if (input.codecName !== "h264") return { eligible: false, reason: "codec_not_h264" };
  if (input.hasBFrames !== 0) {
    return { eligible: false, reason: "probe_reports_reordered_frames" };
  }
  if (
    input.packets.some(
      (packet, index) =>
        Math.abs(packet.ptsMs - packet.dtsMs) > timestampToleranceMs ||
        (index > 0 && packet.ptsMs + timestampToleranceMs < (input.packets[index - 1]?.ptsMs ?? 0)),
    )
  ) {
    return { eligible: false, reason: "packet_timeline_reordered" };
  }

  const window = selectBriefPacketWindow(input.packets, input.startMs, input.requestedDurationMs);
  if (!window.isContiguousDecodePrefix) {
    return { eligible: false, reason: "packet_window_not_decodable" };
  }
  return { eligible: true, window };
}
