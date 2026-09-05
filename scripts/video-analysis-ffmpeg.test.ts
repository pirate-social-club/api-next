import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import type {
  MediaTransformAttempt,
  MediaTransformVideoBinding,
  MediaTransformVideoSource,
} from "@pirate/application/media/transform";
import { MediaTransformRequestInvalid } from "@pirate/application/media/transform";
import type { VideoAnalysisSource } from "@pirate/application/video/analysis";
import { VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Effect } from "effect";
import {
  LOCAL_VIDEO_FFMPEG_REVISION,
  makeLocalPinnedFfmpegVideoAnalysisEngine,
} from "./video-analysis-ffmpeg.ts";

let fixtureDirectory = "";
let fixtureBytes = new Uint8Array();
let fixtureSha256 = "";
const localFixtureToolsAvailable = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

beforeAll(async () => {
  if (!localFixtureToolsAvailable) return;
  fixtureDirectory = await mkdtemp(join(tmpdir(), "pirate-trusted-video-fixture-"));
  const fixturePath = join(fixtureDirectory, "trusted-original-audio.mp4");
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-g",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      fixturePath,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error("trusted MP4 fixture generation failed");
  fixtureBytes = new Uint8Array(await readFile(fixturePath));
  fixtureSha256 = await mediaSha256Bytes(fixtureBytes);
});

afterAll(async () => {
  if (fixtureDirectory !== "") await rm(fixtureDirectory, { recursive: true, force: true });
});

function source(): VideoAnalysisSource {
  return {
    operationId: "trusted-video-operation",
    videoRevision: 1,
    immutableRef: "media://immutable/trusted-video-operation/video/1",
    canonicalSha256: fixtureSha256,
    byteLength: fixtureBytes.byteLength,
    mediaType: "video/mp4",
  };
}

function transformSource(): MediaTransformVideoSource {
  return {
    objectKey: source().immutableRef,
    sha256: fixtureSha256,
    byteLength: fixtureBytes.byteLength,
    mediaType: "video/mp4",
  };
}

const attempt: MediaTransformAttempt = {
  version: "media-transform-attempt-v1",
  runtimeFence: {
    submittedAtMs: Date.parse("2026-09-04T00:00:00.000Z"),
    runtimeDeadlineMs: Date.parse("2026-09-04T00:30:00.000Z"),
  },
};

function binding(capability: "probe" | "audio" | "frames"): MediaTransformVideoBinding {
  return {
    operationId: source().operationId,
    videoRevision: 1,
    analysisRevision: 1,
    creationRevision: 1,
    canonicalVideoSha256: fixtureSha256,
    requestId: `trusted-video-${capability}`,
  };
}

function makeEngineHarness() {
  const artifacts = new Map<string, Uint8Array>();
  const engine = makeLocalPinnedFfmpegVideoAnalysisEngine({
    sourceReader: { read: async () => fixtureBytes },
    artifactWriter: {
      write: async ({ artifactKey, bytes, canonicalSha256 }) => {
        expect(await mediaSha256Bytes(bytes)).toBe(canonicalSha256);
        artifacts.set(artifactKey, bytes);
        return { artifactRef: `media://derived/${artifactKey}` };
      },
    },
  });
  return { artifacts, engine };
}

const localFixtureSuite = localFixtureToolsAvailable ? describe : describe.skip;

localFixtureSuite("local pinned-FFmpeg video analysis engine", () => {
  test("probes, hashes, extracts AAC, and emits the three required JPEG roles", async () => {
    const { artifacts, engine } = makeEngineHarness();
    const hash = await engine.hash(source());
    const probeOutcome = await Effect.runPromise(
      engine.probe({
        version: "media-transform-video-probe-input-v1",
        binding: binding("probe"),
        source: transformSource(),
        attempt,
      }),
    );
    if (probeOutcome.status !== "completed") throw new Error("trusted fixture probe failed");
    const audioOutcome = await Effect.runPromise(
      engine.extractVideoAudio({
        version: "media-transform-video-audio-input-v1",
        binding: binding("audio"),
        source: transformSource(),
        extractionPolicyVersion: "video-audio-m4a-aac-44100-stereo-v1",
        attempt,
      }),
    );
    if (audioOutcome.status !== "completed") throw new Error("trusted fixture audio failed");
    const frameOutcome = await Effect.runPromise(
      engine.extractVideoFrames({
        version: "media-transform-video-frames-input-v1",
        binding: binding("frames"),
        source: transformSource(),
        sourceDurationMs: probeOutcome.probe.durationMs,
        sourceDimensions: {
          width: probeOutcome.probe.width,
          height: probeOutcome.probe.height,
        },
        posterTimestampMs: 1_500,
        posterPolicy: VIDEO_POSTER_POLICY_V1,
        attempt,
      }),
    );
    if (frameOutcome.status !== "completed") throw new Error("trusted fixture frames failed");

    expect(hash).toMatchObject({
      canonicalSha256: fixtureSha256,
      byteLength: fixtureBytes.byteLength,
    });
    expect(probeOutcome.probe).toMatchObject({
      durationMs: 4_000,
      width: 320,
      height: 240,
      frameRateMillihertz: 30_000,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
    });
    expect(audioOutcome.artifact).toMatchObject({ adapterRevision: LOCAL_VIDEO_FFMPEG_REVISION });
    expect(frameOutcome.extraction.frames.map((frame) => frame.role)).toEqual([
      "poster",
      "first",
      "midpoint",
    ]);
    expect(
      new Set(frameOutcome.extraction.frames.map((frame) => frame.sha256)).size,
    ).toBeGreaterThan(1);
    expect(artifacts.size).toBe(4);
    expect(
      [...artifacts.entries()]
        .filter(([key]) => key.endsWith(".jpg"))
        .every(([, bytes]) => bytes.byteLength <= VIDEO_POSTER_POLICY_V1.maxBytesPerFrame),
    ).toBe(true);
  });

  test("rejects a URL-shaped source and caller-selected policy before starting FFmpeg", async () => {
    let reads = 0;
    const engine = makeLocalPinnedFfmpegVideoAnalysisEngine({
      sourceReader: {
        read: async () => {
          reads += 1;
          return fixtureBytes;
        },
      },
      artifactWriter: {
        write: async () => ({ artifactRef: "media://derived/unused" }),
      },
    });
    await expect(
      Effect.runPromise(
        engine.probe({
          version: "media-transform-video-probe-input-v1",
          binding: binding("probe"),
          source: { ...transformSource(), objectKey: "https://user.invalid/video.mp4" },
          attempt,
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      Effect.runPromise(
        engine.extractVideoAudio({
          version: "media-transform-video-audio-input-v1",
          binding: binding("audio"),
          source: transformSource(),
          extractionPolicyVersion: "caller-selected-policy",
          attempt,
        }),
      ),
    ).rejects.toBeInstanceOf(MediaTransformRequestInvalid);
    expect(reads).toBe(0);
  });
});
