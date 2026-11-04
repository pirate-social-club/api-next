import { describe, expect, test } from "bun:test";
import { makeSongVideoCloudConvertJob } from "./song-video-cloudconvert-job.ts";

const valid = {
  attemptId: "song-video-plan:qualification-1:g1",
  sourceUrl: "https://source.example.test/video?signature=source",
  excerptUrl: "https://source.example.test/audio?signature=excerpt",
  clipDurationSamples: 720_000,
} as const;

describe("CloudConvert song-video job", () => {
  test("imports only the sealed source and pre-cut WAV, then exports the fixed master", () => {
    const job = makeSongVideoCloudConvertJob(valid);
    expect(job.tag).toBe(valid.attemptId);
    expect(job.tasks["import-video"]).toEqual({
      operation: "import/url",
      url: valid.sourceUrl,
      filename: "source.mp4",
    });
    expect(job.tasks["import-song-excerpt"]).toEqual({
      operation: "import/url",
      url: valid.excerptUrl,
      filename: "excerpt.wav",
    });
    expect(job.tasks["render-pass-one"]).toMatchObject({
      operation: "command",
      input: ["import-video", "import-song-excerpt"],
      engine: "ffmpeg",
      engine_version: "6.1.4",
      command: "ffmpeg",
      capture_output: false,
      timeout: 600,
    });
    expect(job.tasks["render-pass-one"].arguments).toContain(
      "/input/import-song-excerpt/excerpt.wav",
    );
    expect(job.tasks["render-pass-one"].arguments).not.toContain("-ss ");
    expect(job.tasks["render-pass-two"]).toMatchObject({
      operation: "command",
      input: "render-pass-one",
      engine_version: "6.1.4",
      capture_output: false,
      timeout: 600,
    });
    expect(job.tasks["render-pass-two"].arguments).toContain("/input/render-pass-one/pass-one.mp4");
    expect(job.tasks["export-master"]).toEqual({
      operation: "export/url",
      input: "render-pass-two",
    });
  });

  test("rejects an invalid tag, URL, or interval before a provider request exists", () => {
    expect(() => makeSongVideoCloudConvertJob({ ...valid, attemptId: "bad tag" })).toThrow();
    expect(() =>
      makeSongVideoCloudConvertJob({ ...valid, sourceUrl: "http://source.example.test/video" }),
    ).toThrow();
    expect(() =>
      makeSongVideoCloudConvertJob({
        ...valid,
        excerptUrl: "https://user:pass@source.example.test/audio",
      }),
    ).toThrow();
    expect(() => makeSongVideoCloudConvertJob({ ...valid, clipDurationSamples: 0 })).toThrow();
  });

  test("never places signed URLs in command arguments", () => {
    const job = makeSongVideoCloudConvertJob(valid);
    expect(job.tasks["render-pass-one"].arguments).not.toContain("signature=");
    expect(job.tasks["render-pass-two"].arguments).not.toContain("signature=");
  });
});
