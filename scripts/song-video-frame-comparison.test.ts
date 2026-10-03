import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPinnedTool } from "./pinned-ffmpeg.ts";
import {
  checkMasterTimeline,
  compareSongVideoFrames,
  type FrameManifest,
  parseFrameMetrics,
  validateManifest,
} from "./song-video-frame-comparison.ts";
import {
  type FrameMetrics,
  frameCount,
  frameVerdict,
  matchesQualificationVersion,
} from "./song-video-frame-policy.ts";

const exact = {
  frame: 1,
  ssim: { all: 1, y: 1, u: 1, v: 1 },
  psnr: { all: Infinity, y: Infinity, u: Infinity, v: Infinity },
};

describe("frame comparison admission", () => {
  test("pins the exact decoder revision and rejects missing metric properties", () => {
    expect(matchesQualificationVersion("ffmpeg", "ffmpeg version 6.1.1-3ubuntu5 Copyright")).toBe(
      true,
    );
    expect(matchesQualificationVersion("ffmpeg", "ffmpeg version 6.1.10 Copyright")).toBe(false);
    expect(matchesQualificationVersion("ffprobe", "ffmpeg version 6.1.1 Copyright")).toBe(false);
    const missing = JSON.parse(
      JSON.stringify({ ...exact, psnr: { y: 40, u: 40, v: 40 } }),
    ) as FrameMetrics;
    expect(frameVerdict([missing], 1).passed).toBe(false);
  });
  test("requires every ordered frame rather than an aggregate", () => {
    expect(frameVerdict([exact], 2).passed).toBe(false);
    expect(frameVerdict([{ ...exact, frame: 2 }], 1).passed).toBe(false);
    expect(
      frameVerdict([exact, { ...exact, frame: 2, ssim: { ...exact.ssim, all: 0.94 } }], 2).passed,
    ).toBe(false);
  });
  test("rejects nonfinite SSIM, NaN PSNR and a changed chroma plane", () => {
    expect(frameVerdict([{ ...exact, ssim: { ...exact.ssim, all: NaN } }], 1).passed).toBe(false);
    expect(frameVerdict([{ ...exact, psnr: { ...exact.psnr, all: NaN } }], 1).passed).toBe(false);
    expect(frameVerdict([{ ...exact, psnr: { ...exact.psnr, u: 27.99 } }], 1).passed).toBe(false);
    expect(frameVerdict([exact], 1).passed).toBe(true);
  });
  test("requires complete jointly bound SSIM and PSNR statistics", () => {
    const ssim = "n:1 Y:1 U:1 V:1 All:1 (inf)";
    const psnr = "n:1 psnr_avg:inf psnr_y:inf psnr_u:inf psnr_v:inf";
    expect(parseFrameMetrics(ssim, psnr)).toEqual([exact]);
    expect(() => parseFrameMetrics(ssim, psnr.replace("n:1", "n:2"))).toThrow();
    expect(() => parseFrameMetrics(ssim, "n:1 psnr_avg:inf")).toThrow();
  });
  test("bounds intervals and keeps a partial final frame", () => {
    expect(frameCount(144_001)).toBe(91);
    for (const value of [144_000.5, 143_999, 720_001, NaN])
      expect(() => frameCount(value)).toThrow();
  });
  test("independently rejects missing frames, shifted PTS and wrong final duration", () => {
    const probe = {
      streams: [
        {
          width: 160,
          height: 128,
          time_base: "1/48000",
          duration_ts: 144_001,
          sample_aspect_ratio: "1:1",
          pix_fmt: "yuv420p",
          codec_name: "h264",
        },
      ],
      frames: Array.from({ length: 91 }, (_, n) => ({
        pts: n * 1600,
        pkt_duration: n === 90 ? 1 : 1600,
        width: 160,
        height: 128,
      })),
    };
    expect(() => checkMasterTimeline(probe, 144_001)).not.toThrow();
    const first = probe.streams[0];
    if (!first) throw new Error("fixture stream absent");
    const { sample_aspect_ratio: _sar, ...unspecified } = first;
    expect(() => checkMasterTimeline({ ...probe, streams: [unspecified] }, 144_001)).not.toThrow();
    expect(() =>
      checkMasterTimeline(
        { ...probe, streams: [{ ...first, sample_aspect_ratio: "2:1" }] },
        144_001,
      ),
    ).toThrow();
    expect(() =>
      checkMasterTimeline({ ...probe, frames: probe.frames.slice(1) }, 144_001),
    ).toThrow();
    expect(() =>
      checkMasterTimeline(
        { ...probe, frames: probe.frames.map((f, n) => (n === 10 ? { ...f, pts: f.pts + 1 } : f)) },
        144_001,
      ),
    ).toThrow();
    expect(() =>
      checkMasterTimeline(
        {
          ...probe,
          frames: probe.frames.map((f, n) => (n === 90 ? { ...f, pkt_duration: 1600 } : f)),
        },
        144_001,
      ),
    ).toThrow();
  });
});

// Qualification tests use synthetic local media only. Required mode fails
// rather than crediting a skip if either pinned tool is unavailable.
const pinned = ["ffmpeg", "ffprobe"].every((name) => {
  const binary = Bun.which(name);
  return (
    binary !== null &&
    new TextDecoder()
      .decode(Bun.spawnSync([binary, "-version"]).stdout)
      .startsWith(`${name} version 6.1.1`)
  );
});
if (process.env.VIDEO_FRAME_COMPARISON_REQUIRED === "1" && !pinned)
  throw new Error("required frame qualification decoder absent");
const suite = pinned ? describe : describe.skip;

suite("real decoder frame comparison", () => {
  let directory = "";
  let source = "";
  let master = "";
  let manifest: FrameManifest;
  let outputs = 0;
  const run = (args: string[]) =>
    runPinnedTool(
      ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-threads", "2", ...args],
      30_000,
    );
  const identity = async (path: string, key: string) => {
    const bytes = await readFile(path);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      objectKey: `media://immutable/${key}`,
      objectVersion: "a".repeat(32),
    };
  };
  const compare = (selected: FrameManifest, path = master) =>
    compareSongVideoFrames({
      manifest: selected,
      sourcePath: source,
      masterPath: path,
      outputDirectory: join(directory, `comparison-${outputs++}`),
    });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "song-video-frame-test-"));
    source = join(directory, "source.mkv");
    master = join(directory, "master.mp4");
    await run([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x128:rate=30:duration=3",
      "-c:v",
      "ffv1",
      source,
    ]);
    await run([
      "-i",
      source,
      "-vf",
      "fps=30,trim=end_frame=90,setpts=PTS-STARTPTS",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "0",
      "-video_track_timescale",
      "48000",
      "-movie_timescale",
      "48000",
      master,
    ]);
    manifest = {
      submissionId: "fixture",
      planId: "song-video-plan:fixture",
      attemptId: "song-video-plan:fixture:g1",
      masterRevisionId: "song-video-plan:fixture:g1:master",
      clipDurationSamples: 144_000,
      source: await identity(source, "source"),
      master: await identity(master, "master"),
    };
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test("accepts the reviewed CRF23 recipe and retains all 90 frames", async () => {
    const result = await compare(manifest);
    expect(result.verdict.passed).toBe(true);
    expect(result.comparedFrames).toBe(90);
  }, 30_000);
  test("refuses a digest mismatch and a crossed plan before decoding", async () => {
    await expect(
      compare({ ...manifest, source: { ...manifest.source, sha256: "f".repeat(64) } }),
    ).rejects.toThrow();
    expect(() =>
      validateManifest({ ...manifest, masterRevisionId: "other-plan:master" }),
    ).toThrow();
  });
  test("rejects one substituted frame even when 89 others are correct", async () => {
    const path = join(directory, "one-black-frame.mp4");
    await run([
      "-i",
      source,
      "-vf",
      "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,30)'",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-bf",
      "0",
      "-video_track_timescale",
      "48000",
      "-movie_timescale",
      "48000",
      path,
    ]);
    const result = await compare({ ...manifest, master: await identity(path, "changed") }, path);
    expect(result.verdict.passed).toBe(false);
    expect(result.verdict.failedFrames).toContain(31);
  }, 30_000);
  test("records that a tiny localized alteration can pass the lossy tolerance", async () => {
    const path = join(directory, "tiny-corner.mp4");
    await run([
      "-i",
      source,
      "-vf",
      "drawbox=x=0:y=0:w=2:h=2:color=magenta:t=fill:enable='eq(n,30)'",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-bf",
      "0",
      "-video_track_timescale",
      "48000",
      "-movie_timescale",
      "48000",
      path,
    ]);
    const result = await compare(
      { ...manifest, master: await identity(path, "tiny-corner") },
      path,
    );
    expect(result.comparedFrames).toBe(90);
    expect(result.verdict.passed).toBe(true);
    // This is a recorded residual-trust limit. Tightening the floors later
    // requires requalification rather than silently relabeling this result.
  }, 30_000);
  test("rejects a mirrored picture with a correct timeline", async () => {
    const path = join(directory, "mirrored.mp4");
    await run([
      "-i",
      source,
      "-vf",
      "hflip",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-bf",
      "0",
      "-video_track_timescale",
      "48000",
      "-movie_timescale",
      "48000",
      path,
    ]);
    expect(
      (await compare({ ...manifest, master: await identity(path, "mirrored") }, path)).verdict
        .passed,
    ).toBe(false);
  }, 30_000);
});
