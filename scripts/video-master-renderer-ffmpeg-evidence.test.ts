import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runNoReorderCopyEvidence } from "./video-master-renderer-ffmpeg-evidence.ts";

describe("fixed FFmpeg no-reorder copy template", () => {
  let workingDirectory: string;
  let evidence: Awaited<ReturnType<typeof runNoReorderCopyEvidence>>;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "api-video-renderer-test-"));
    evidence = await runNoReorderCopyEvidence(workingDirectory);
  }, 30_000);

  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("admits only the probed no-reordering source and copies the exact packet payload sequence", () => {
    expect(evidence.sourceHasBFrames).toBe(0);
    expect(evidence.sourceStartMs).toBe(1_000);
    expect(evidence.selectedVideoPackets).toBe(56);
    expect(evidence.copiedPacketPayloadsMatch).toBe(true);
    expect(evidence.masterPacketManifestSha256).toBe(evidence.sourcePacketManifestSha256);
  });

  it("makes copied video duration the master clock", () => {
    expect(evidence.requestedDurationMs).toBe(1_887);
    expect(evidence.effectiveDurationMs).toBeCloseTo(1_866.666, 3);
    expect(evidence.masterVideoDurationMs).toBeCloseTo(1_866.667, 3);
    expect(Math.abs(evidence.masterVideoDurationMs - evidence.effectiveDurationMs)).toBeLessThan(
      1 / 15.36,
    );
  });

  it("pads PCM only to the AAC frame boundary and bounds public audio to video", () => {
    expect(evidence.targetPcmSamples).toBe(89_600);
    expect(evidence.paddedPcmSamples).toBe(90_112);
    expect(evidence.zeroPaddingSamples).toBe(512);
    expect(evidence.paddedPcmSamples % 1_024).toBe(0);
    expect(evidence.audioPrimingSkipSamples).toBe(1_024);
    // Decoding packets exposes the full padded AAC payload. The MP4 track edit
    // is the public presentation fence and is intentionally shorter.
    expect(evidence.decodedAudioSamples).toBe(evidence.paddedPcmSamples);
    expect(evidence.audioDurationSamples).toBe(89_568);
    expect(evidence.masterAudioPresentationDurationMs).toBeLessThanOrEqual(
      evidence.masterVideoDurationMs,
    );
    expect(
      evidence.masterVideoDurationMs - evidence.masterAudioPresentationDurationMs,
    ).toBeLessThan(1_024 / 48);
  });

  it("uses the frozen server-owned command template", () => {
    expect(evidence.renderArguments).toContain("copy");
    expect(evidence.renderArguments).toContain("aac");
    expect(evidence.renderArguments).toContain("-use_editlist");
    expect(evidence.renderArguments).not.toContain("-c:v libx264");
    expect(evidence.masterSha256).toHaveLength(64);
    expect(evidence.renderWallMs).toBeGreaterThan(0);
  });
});
