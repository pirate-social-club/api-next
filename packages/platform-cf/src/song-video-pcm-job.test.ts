import { describe, expect, test } from "bun:test";
import { makeSongVideoPcmJob, SONG_VIDEO_PCM_DECODER_RECIPE } from "./song-video-pcm-job.ts";

const input = {
  admissionId: "song-pcm-123-a1",
  sourceUrl: "https://source.example/opaque-capability",
  sourceByteLength: 8_000_000,
  sourceDurationMs: 240_000,
};

describe("bounded whole-song PCM job", () => {
  test("pins one full decode and exports raw stereo PCM without output credentials", () => {
    const job = makeSongVideoPcmJob(input);
    expect(job.tag).toBe(input.admissionId);
    expect(Object.keys(job.tasks)).toEqual(["import-song", "decode-song", "export-pcm"]);
    expect(job.tasks["decode-song"].engine_version).toBe("6.1.4");
    expect(job.tasks["decode-song"].arguments).toContain("-fs 46080004 -f s16le /output/song.pcm");
    expect(job.tasks["decode-song"].arguments).not.toContain("-t ");
    expect(job.tasks["decode-song"].arguments).not.toContain("-ss ");
    expect(job.tasks["decode-song"].capture_output).toBe(false);
    expect(SONG_VIDEO_PCM_DECODER_RECIPE).toBe("cloudconvert-song-pcm-s16le-48000-stereo-v1");
  });

  test("refuses excessive, missing, nonfinite and fractional source facts before dispatch", () => {
    for (const sourceByteLength of [0, -1, 1.5, NaN, Infinity, 64 * 1024 * 1024 + 1])
      expect(() => makeSongVideoPcmJob({ ...input, sourceByteLength })).toThrow();
    for (const sourceDurationMs of [0, -1, NaN, Infinity, 240_001])
      expect(() => makeSongVideoPcmJob({ ...input, sourceDurationMs })).toThrow();
  });

  test("refuses shell identities and non-HTTPS or embedded credentials", () => {
    for (const admissionId of ["", "x;bad", "x\n", "x".repeat(193)])
      expect(() => makeSongVideoPcmJob({ ...input, admissionId })).toThrow();
    for (const sourceUrl of [
      "http://source.example/x",
      "https://user:pass@source.example/x",
      "https://source.example/x#fragment",
    ])
      expect(() => makeSongVideoPcmJob({ ...input, sourceUrl })).toThrow();
  });
});
