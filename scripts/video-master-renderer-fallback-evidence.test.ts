import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWebmFallbackEvidence } from "./video-master-renderer-fallback-evidence.ts";

describe("fixed WebM fallback transcode template", () => {
  let workingDirectory: string;
  let evidence: Awaited<ReturnType<typeof runWebmFallbackEvidence>>;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "api-video-fallback-test-"));
    evidence = await runWebmFallbackEvidence(workingDirectory);
  }, 30_000);

  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("transcodes the admitted browser fallback into the fixed master profile", () => {
    expect(evidence.sourceVideoCodec).toBe("vp9");
    expect(evidence.sourceAudioCodec).toBe("opus");
    expect(evidence.sourceSampleAspectRatio).toBe("4:3");
    expect(evidence.outputVideoCodec).toBe("h264");
    expect(evidence.outputAudioCodec).toBe("aac");
    expect(evidence.outputWidth).toBe(320);
    expect(evidence.outputHeight).toBe(568);
    expect(evidence.outputSampleAspectRatio).toBe("1:1");
    expect(evidence.outputVideoFrames).toBe(54);
    expect(evidence.outputChannels).toBe(2);
    expect(evidence.outputChannelLayout).toBe("stereo");
  });

  it("keeps exact public A/V duration while containing AAC frame padding", () => {
    expect(evidence.targetPcmSamplesPerChannel).toBe(86_400);
    expect(evidence.paddedPcmSamplesPerChannel).toBe(87_040);
    expect(evidence.audioPresentationSamplesPerChannel).toBe(86_400);
    expect(evidence.decodedAudioSamplesPerChannel).toBe(87_040);
    expect(evidence.masterVideoDurationMs).toBe(1_800);
    expect(evidence.masterAudioDurationMs).toBe(1_800);
    expect(evidence.audioVideoDeltaMs).toBe(0);
  });

  it("records one local process resource observation without making it a budget claim", () => {
    expect(evidence.resources.wallMs).toBeGreaterThan(0);
    expect(evidence.resources.userSeconds).toBeGreaterThanOrEqual(0);
    expect(evidence.resources.systemSeconds).toBeGreaterThanOrEqual(0);
    expect(evidence.resources.maximumResidentSetKiB).toBeGreaterThan(0);
  });

  it("extracts the poster from the normalized final timeline", () => {
    expect(evidence.posterTimelineMs).toBe(900);
    expect(evidence.posterWidth).toBe(320);
    expect(evidence.posterHeight).toBe(568);
    expect(evidence.posterSha256).toHaveLength(64);
  });

  it("keeps all codec, filter, and output choices server-owned", () => {
    expect(evidence.renderArguments).toContain("libx264");
    expect(evidence.renderArguments).toContain("aac");
    expect(evidence.renderArguments).toContain("-movie_timescale");
    expect(evidence.renderArguments).toContain("48000");
    expect(evidence.renderArguments).not.toContain("copy");
  });
});
