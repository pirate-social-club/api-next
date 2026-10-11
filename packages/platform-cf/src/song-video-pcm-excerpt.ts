import type { SongVideoPcmReference } from "@pirate/application/video/song-interval";
import { makeSongVideoPcmWavHeader } from "./song-video-pcm-wav.ts";

const BYTES_PER_SAMPLE_FRAME = 4;
const DIGEST = /^[0-9a-f]{64}$/u;

/** The reader must return bytes only if the exact admitted R2 version and ETag still match. */
export type SongVideoPcmRangeReader = Readonly<{
  readExact: (
    input: Readonly<{
      key: string;
      version: string;
      etag: string;
      offset: number;
      length: number;
    }>,
  ) => Promise<Uint8Array | null>;
}>;

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes as unknown as ArrayBuffer)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""),
    );
}

/** Reads only the frozen interval, then wraps those exact bytes in a 44-byte WAV. */
export async function makeSongVideoPcmExcerpt(
  input: Readonly<{
    reference: SongVideoPcmReference;
    clipStartSamples: number;
    clipDurationSamples: number;
    reader: SongVideoPcmRangeReader;
  }>,
): Promise<Readonly<{ wav: Uint8Array; pcmSha256: string; wavSha256: string }>> {
  const { reference, clipStartSamples: start, clipDurationSamples: duration } = input;
  const header = makeSongVideoPcmWavHeader(duration);
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(reference.durationSamples) ||
    reference.durationSamples <= 0 ||
    start + duration > reference.durationSamples ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength !== reference.durationSamples * BYTES_PER_SAMPLE_FRAME ||
    !DIGEST.test(reference.pcmSha256) ||
    reference.objectKey.length === 0 ||
    reference.objectVersion.length === 0 ||
    reference.objectEtag.length === 0
  ) {
    throw new TypeError("invalid song-video PCM interval or reference");
  }
  const offset = start * BYTES_PER_SAMPLE_FRAME;
  const length = duration * BYTES_PER_SAMPLE_FRAME;
  const pcm = await input.reader.readExact({
    key: reference.objectKey,
    version: reference.objectVersion,
    etag: reference.objectEtag,
    offset,
    length,
  });
  if (pcm === null || pcm.byteLength !== length)
    throw new Error("PCM excerpt identity or length mismatch");
  const wav = new Uint8Array(header.byteLength + length);
  wav.set(header);
  wav.set(pcm, header.byteLength);
  return { wav, pcmSha256: await sha256(pcm), wavSha256: await sha256(wav) };
}
