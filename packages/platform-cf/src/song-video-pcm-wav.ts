/** Canonical 44-byte PCM WAV wrapper for one bounded song-video excerpt. */

const SAMPLE_RATE_HZ = 48_000;
const CHANNEL_COUNT = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE_FRAME = CHANNEL_COUNT * (BITS_PER_SAMPLE / 8);
const MIN_SAMPLE_FRAMES = 3 * SAMPLE_RATE_HZ;
const MAX_SAMPLE_FRAMES = 15 * SAMPLE_RATE_HZ;

export function makeSongVideoPcmWavHeader(sampleFrames: number): Uint8Array {
  if (
    !Number.isSafeInteger(sampleFrames) ||
    sampleFrames < MIN_SAMPLE_FRAMES ||
    sampleFrames > MAX_SAMPLE_FRAMES
  ) {
    throw new TypeError("song-video WAV requires a bounded sample-frame count");
  }

  const dataBytes = sampleFrames * BYTES_PER_SAMPLE_FRAME;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      header[offset + index] = value.charCodeAt(index);
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNEL_COUNT, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE_FRAME, true);
  view.setUint16(32, BYTES_PER_SAMPLE_FRAME, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}
