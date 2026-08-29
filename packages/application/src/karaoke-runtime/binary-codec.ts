import type { KaraokeClientBinaryFrame, KaraokeTransportError } from "./transport";
import { KARAOKE_TRANSPORT_PROTOCOL_VERSION } from "./transport";

export const KARAOKE_BINARY_PROTOCOL_VERSION = 1 as const;
export const KARAOKE_BINARY_HEADER_BYTES = 28 as const;
export const KARAOKE_MAX_BINARY_FRAME_BYTES = 200_000 as const;

const KARAOKE_BINARY_MAGIC = [0x4b, 0x41, 0x52, 0x41] as const;
const KARAOKE_BINARY_FLAGS_V1 = 0;
const UINT32_MAX = 0xffff_ffff;

export interface DecodeKaraokeBinaryFrameOptions {
  attemptId: string;
  maxFrameBytes?: number;
  sessionId: string;
}

export type DecodeKaraokeBinaryFrameResult =
  | { frame: KaraokeClientBinaryFrame; error?: never }
  | { error: KaraokeTransportError; frame?: never };

function binaryError(
  code: KaraokeTransportError["code"],
  message: string,
  sequence?: number,
): DecodeKaraokeBinaryFrameResult {
  return { error: { code, message, sequence } };
}

function isUint32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX;
}

/**
 * Binary frame wire format v1:
 * - The fixed 28-byte header uses big-endian network byte order.
 * - The payload contains little-endian signed 16-bit PCM samples.
 * - Binary and JSON client messages share one monotonic sequence space.
 */
export function encodeKaraokeBinaryFrame(frame: KaraokeClientBinaryFrame): ArrayBuffer {
  if (!isUint32(frame.sequence)) throw new RangeError("sequence must fit uint32");
  if (!isUint32(frame.chunkId) || frame.chunkId === 0) {
    throw new RangeError("chunkId must be a positive uint32");
  }
  if (frame.sampleRate !== 16_000) throw new RangeError("sampleRate must be 16000");
  if (
    !isUint32(frame.songStartMs) ||
    !isUint32(frame.songEndMs) ||
    frame.songEndMs < frame.songStartMs
  ) {
    throw new RangeError("song timestamps must be an ordered uint32 range");
  }
  if (frame.pcm16.byteLength % 2 !== 0) throw new RangeError("pcm16 byte length must be even");

  const byteLength = KARAOKE_BINARY_HEADER_BYTES + frame.pcm16.byteLength;
  if (byteLength > KARAOKE_MAX_BINARY_FRAME_BYTES) {
    throw new RangeError(`binary frame exceeds ${KARAOKE_MAX_BINARY_FRAME_BYTES} bytes`);
  }

  const encoded = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(encoded);
  bytes.set(KARAOKE_BINARY_MAGIC, 0);
  const view = new DataView(encoded);
  view.setUint8(4, KARAOKE_BINARY_PROTOCOL_VERSION);
  view.setUint8(5, KARAOKE_BINARY_FLAGS_V1);
  view.setUint16(6, KARAOKE_BINARY_HEADER_BYTES, false);
  view.setUint32(8, frame.sequence, false);
  view.setUint32(12, frame.chunkId, false);
  view.setUint32(16, frame.sampleRate, false);
  view.setUint32(20, frame.songStartMs, false);
  view.setUint32(24, frame.songEndMs, false);
  bytes.set(new Uint8Array(frame.pcm16), KARAOKE_BINARY_HEADER_BYTES);
  return encoded;
}

export function decodeKaraokeBinaryFrame(
  buffer: ArrayBuffer,
  options: DecodeKaraokeBinaryFrameOptions,
): DecodeKaraokeBinaryFrameResult {
  const requestedMax = options.maxFrameBytes ?? KARAOKE_MAX_BINARY_FRAME_BYTES;
  const maxFrameBytes = Math.min(requestedMax, KARAOKE_MAX_BINARY_FRAME_BYTES);
  if (buffer.byteLength > maxFrameBytes) {
    return binaryError("binary_oversized_frame", `Binary frame exceeds ${maxFrameBytes} bytes`);
  }
  if (buffer.byteLength < KARAOKE_BINARY_HEADER_BYTES) {
    return binaryError("binary_truncated", "Binary frame is shorter than the v1 header");
  }

  const bytes = new Uint8Array(buffer);
  if (KARAOKE_BINARY_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    return binaryError("binary_magic_mismatch", "Binary frame magic must be KARA");
  }

  const view = new DataView(buffer);
  const version = view.getUint8(4);
  if (version !== KARAOKE_BINARY_PROTOCOL_VERSION) {
    return binaryError(
      "binary_version_mismatch",
      `Unsupported binary protocol version: ${version}`,
    );
  }
  const flags = view.getUint8(5);
  if (flags !== KARAOKE_BINARY_FLAGS_V1) {
    return binaryError("binary_unknown_flags", `Unsupported binary frame flags: ${flags}`);
  }
  const headerLength = view.getUint16(6, false);
  if (headerLength !== KARAOKE_BINARY_HEADER_BYTES) {
    return binaryError(
      "binary_truncated",
      `Binary header length must be ${KARAOKE_BINARY_HEADER_BYTES}`,
    );
  }

  const sequence = view.getUint32(8, false);
  const chunkId = view.getUint32(12, false);
  if (chunkId === 0) {
    return binaryError("invalid_event_payload", "Binary chunkId must be positive", sequence);
  }
  const sampleRate = view.getUint32(16, false);
  if (sampleRate !== 16_000) {
    return binaryError(
      "binary_invalid_sample_rate",
      `Binary sample rate must be 16000, received ${sampleRate}`,
      sequence,
    );
  }
  const songStartMs = view.getUint32(20, false);
  const songEndMs = view.getUint32(24, false);
  if (songEndMs < songStartMs) {
    return binaryError(
      "invalid_event_payload",
      "Binary song timestamps are out of order",
      sequence,
    );
  }

  const pcmByteLength = buffer.byteLength - KARAOKE_BINARY_HEADER_BYTES;
  if (pcmByteLength % 2 !== 0) {
    return binaryError(
      "binary_odd_pcm_length",
      "Binary PCM payload must contain complete int16 samples",
      sequence,
    );
  }

  return {
    frame: {
      attemptId: options.attemptId,
      chunkId,
      pcm16: buffer.slice(KARAOKE_BINARY_HEADER_BYTES),
      protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
      sampleRate: 16_000,
      sequence,
      sessionId: options.sessionId,
      songEndMs,
      songStartMs,
      type: "audio_chunk",
    },
  };
}
