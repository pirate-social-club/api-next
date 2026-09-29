import {
  makeSongVideoCloudConvertCommands,
  SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION,
} from "./song-video-cloudconvert-recipe.ts";

const ATTEMPT_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const COMMAND_TIMEOUT_SECONDS = 600;

function importUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("CloudConvert import URL must be credential-free HTTPS");
  }
  return value;
}

/**
 * Builds the fixed two-pass render job. The caller must issue exact-object,
 * expiring URLs for the sealed video and the independently verified WAV.
 * Signed URLs are payload data and must never enter logs or error messages.
 */
export function makeSongVideoCloudConvertJob(
  input: Readonly<{
    attemptId: string;
    sourceUrl: string;
    excerptUrl: string;
    clipDurationSamples: number;
  }>,
) {
  if (!ATTEMPT_TAG.test(input.attemptId)) {
    throw new TypeError("invalid CloudConvert render attempt tag");
  }
  const sourceUrl = importUrl(input.sourceUrl);
  const excerptUrl = importUrl(input.excerptUrl);
  const commands = makeSongVideoCloudConvertCommands({
    clipDurationSamples: input.clipDurationSamples,
  });
  return {
    tag: input.attemptId,
    tasks: {
      "import-video": {
        operation: "import/url",
        url: sourceUrl,
        filename: "source.mp4",
      },
      "import-song-excerpt": {
        operation: "import/url",
        url: excerptUrl,
        filename: "excerpt.wav",
      },
      "render-pass-one": {
        operation: "command",
        input: ["import-video", "import-song-excerpt"],
        engine: "ffmpeg",
        engine_version: SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION,
        command: "ffmpeg",
        arguments: commands.passOne,
        capture_output: false,
        timeout: COMMAND_TIMEOUT_SECONDS,
      },
      "render-pass-two": {
        operation: "command",
        input: "render-pass-one",
        engine: "ffmpeg",
        engine_version: SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION,
        command: "ffmpeg",
        arguments: commands.passTwo,
        capture_output: false,
        timeout: COMMAND_TIMEOUT_SECONDS,
      },
      "export-master": {
        operation: "export/url",
        input: "render-pass-two",
      },
    },
  } as const;
}
