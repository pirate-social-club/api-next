import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRotationEvidence } from "./video-master-renderer-rotation-evidence.ts";

describe("fixed display-rotation normalization", () => {
  let workingDirectory: string;
  let evidence: Awaited<ReturnType<typeof runRotationEvidence>>;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "api-video-rotation-test-"));
    evidence = await runRotationEvidence(workingDirectory);
  }, 30_000);

  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("applies display rotation during decode and removes metadata from the master", () => {
    expect(Math.abs(evidence.inputDisplayRotationDegrees)).toBe(90);
    expect(evidence.inputStoredWidth).toBe(320);
    expect(evidence.inputStoredHeight).toBe(180);
    expect(evidence.outputCodec).toBe("h264");
    expect(evidence.outputWidth).toBe(320);
    expect(evidence.outputHeight).toBe(568);
    expect(evidence.outputSampleAspectRatio).toBe("1:1");
    expect(evidence.outputDisplayRotationDegrees).toBe(0);
    expect(evidence.outputFrames).toBe(30);
  });

  it("keeps rotation and output geometry inside the fixed server template", () => {
    expect(evidence.renderArguments).toContain(
      "scale=320:568:flags=bicubic,setsar=1,format=yuv420p",
    );
    expect(evidence.renderArguments).toContain("rotate=0");
    expect(evidence.renderArguments).toContain("libx264");
  });
});
