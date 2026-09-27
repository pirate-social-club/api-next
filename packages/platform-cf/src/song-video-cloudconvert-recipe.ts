/** The two pinned CloudConvert commands for the admitted PCM-in-MP4 master. */

export const SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION = "6.1.4";

const SAMPLE_RATE_HZ = 48_000;
const MIN_DURATION_SAMPLES = 3 * SAMPLE_RATE_HZ;
const MAX_DURATION_SAMPLES = 15 * SAMPLE_RATE_HZ;
const SAMPLES_PER_VIDEO_FRAME = SAMPLE_RATE_HZ / 30;

export type SongVideoCloudConvertCommands = Readonly<{
  passOne: string;
  passTwo: string;
  frameCount: number;
  lastFrameSamples: number;
}>;

/**
 * Paths are fixed CloudConvert task inputs, not caller-controlled shell text.
 * The caller must still bind the imported bytes to the frozen source and song.
 */
export function makeSongVideoCloudConvertCommands(
  input: Readonly<{
    clipStartSamples: number;
    clipDurationSamples: number;
  }>,
): SongVideoCloudConvertCommands {
  const { clipStartSamples: start, clipDurationSamples: duration } = input;
  const end = start + duration;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(duration) ||
    duration < MIN_DURATION_SAMPLES ||
    duration > MAX_DURATION_SAMPLES ||
    !Number.isSafeInteger(end)
  ) {
    throw new TypeError("song-video CloudConvert interval must be a bounded sample interval");
  }

  const frameCount = Math.ceil(duration / SAMPLES_PER_VIDEO_FRAME);
  const lastFrameSamples = duration - (frameCount - 1) * SAMPLES_PER_VIDEO_FRAME;
  const passOne =
    "-hide_banner -nostdin -loglevel error " +
    "-i /input/import-video/source.mp4 -i /input/import-song/song.bin " +
    `-filter_complex '[1:a:0]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,atrim=start_sample=${start}:end_sample=${end},asetpts=N/SR/TB[a];` +
    `[0:v:0]fps=30,trim=end_frame=${frameCount},setpts=PTS-STARTPTS[v]' ` +
    "-map '[v]' -map '[a]' -c:v libx264 -preset veryfast -crf 23 " +
    "-pix_fmt yuv420p -bf 0 -c:a pcm_s16le -video_track_timescale 48000 " +
    "-f mp4 /output/pass-one.mp4";
  const passTwo =
    "-hide_banner -nostdin -loglevel error " +
    "-i /input/render-pass-one/pass-one.mp4 -map 0 -c copy " +
    `-bsf:v 'setts=duration=if(eq(N\\,${frameCount - 1})\\,${lastFrameSamples}\\,DURATION)' ` +
    // The 1 kHz MP4 default rounds non-frame-aligned sample durations in its
    // edit list. Match the 48 kHz tracks so the verifier can check exact time.
    "-video_track_timescale 48000 -movie_timescale 48000 " +
    "-movflags +faststart -f mp4 /output/master.mp4";

  return { passOne, passTwo, frameCount, lastFrameSamples };
}
