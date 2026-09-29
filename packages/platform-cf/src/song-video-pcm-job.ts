import { SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION } from "./song-video-cloudconvert-recipe.ts";
import { SONG_VIDEO_PCM_MAX_BYTES } from "./song-video-pcm-transfer.ts";

export const SONG_VIDEO_PCM_DECODER_RECIPE = "cloudconvert-song-pcm-s16le-48000-stereo-v1";
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Exact-object source authority is issued separately; no storage credential is exported. */
export function makeSongVideoPcmJob(
  input: Readonly<{
    admissionId: string;
    sourceUrl: string;
    sourceByteLength: number;
    sourceDurationMs: number;
  }>,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(input.admissionId))
    throw new TypeError("invalid song PCM admission identity");
  if (
    !Number.isSafeInteger(input.sourceByteLength) ||
    input.sourceByteLength < 1 ||
    input.sourceByteLength > MAX_SOURCE_BYTES ||
    !Number.isFinite(input.sourceDurationMs) ||
    input.sourceDurationMs <= 0 ||
    input.sourceDurationMs > 240_000
  )
    throw new TypeError("song PCM source exceeds admission bounds");
  const url = new URL(input.sourceUrl);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "")
    throw new TypeError("song PCM source requires credential-free HTTPS");
  return {
    tag: input.admissionId,
    tasks: {
      "import-song": { operation: "import/url", url: input.sourceUrl, filename: "source.audio" },
      "decode-song": {
        operation: "command",
        input: "import-song",
        engine: "ffmpeg",
        engine_version: SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION,
        command: "ffmpeg",
        // The size fence is above admission's maximum. An oversized decode is
        // refused by its actual byte length, never admitted as a truncated song.
        arguments:
          "-hide_banner -nostdin -loglevel error -i /input/import-song/source.audio " +
          "-map 0:a:0 -vn -sn -dn -ac 2 -ar 48000 -c:a pcm_s16le " +
          `-fs ${SONG_VIDEO_PCM_MAX_BYTES + 4} -f s16le /output/song.pcm`,
        capture_output: false,
        timeout: 600,
      },
      "export-pcm": { operation: "export/url", input: "decode-song" },
    },
  } as const;
}
