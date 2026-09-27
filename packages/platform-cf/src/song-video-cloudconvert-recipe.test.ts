import { describe, expect, test } from "bun:test";
import {
  makeSongVideoCloudConvertCommands,
  SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION,
} from "./song-video-cloudconvert-recipe.ts";

describe("CloudConvert song-video PCM recipe", () => {
  test("pins the PCM trial recipe with an exact 48 kHz movie timescale", () => {
    expect(SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION).toBe("6.1.4");
    const commands = makeSongVideoCloudConvertCommands({
      clipStartSamples: 48_000,
      clipDurationSamples: 720_000,
    });
    expect(commands).toEqual({
      frameCount: 450,
      lastFrameSamples: 1_600,
      passOne:
        "-hide_banner -nostdin -loglevel error " +
        "-i /input/import-video/source.mp4 -i /input/import-song/song.bin " +
        "-filter_complex '[1:a:0]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,atrim=start_sample=48000:end_sample=768000,asetpts=N/SR/TB[a];" +
        "[0:v:0]fps=30,trim=end_frame=450,setpts=PTS-STARTPTS[v]' " +
        "-map '[v]' -map '[a]' -c:v libx264 -preset veryfast -crf 23 " +
        "-pix_fmt yuv420p -bf 0 -c:a pcm_s16le -video_track_timescale 48000 " +
        "-f mp4 /output/pass-one.mp4",
      passTwo:
        "-hide_banner -nostdin -loglevel error " +
        "-i /input/render-pass-one/pass-one.mp4 -map 0 -c copy " +
        "-bsf:v 'setts=duration=if(eq(N\\,449)\\,1600\\,DURATION)' " +
        "-video_track_timescale 48000 -movie_timescale 48000 " +
        "-movflags +faststart -f mp4 /output/master.mp4",
    });
  });

  test("holds the final video frame to a partial sample boundary", () => {
    const commands = makeSongVideoCloudConvertCommands({
      clipStartSamples: 123,
      clipDurationSamples: 5 * 48_000 + 777,
    });
    expect(commands.frameCount).toBe(151);
    expect(commands.lastFrameSamples).toBe(777);
    expect(commands.passTwo).toContain("N\\,150)\\,777\\,DURATION");
  });

  test.each([
    { clipStartSamples: -1, clipDurationSamples: 144_000 },
    { clipStartSamples: 0.5, clipDurationSamples: 144_000 },
    { clipStartSamples: 0, clipDurationSamples: 143_999 },
    { clipStartSamples: 0, clipDurationSamples: 720_001 },
    { clipStartSamples: Number.MAX_SAFE_INTEGER, clipDurationSamples: 144_000 },
  ])("refuses an invalid interval before making a command: %p", (input) => {
    expect(() => makeSongVideoCloudConvertCommands(input)).toThrow(TypeError);
  });
});
