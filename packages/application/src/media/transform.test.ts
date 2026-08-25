import { describe, expect, test } from "bun:test";
import { MEDIA_TRANSFORM_SAMPLE_TARGET_MS, mediaTransformSampleWindow } from "./transform.ts";

describe("MediaTransform sample policy", () => {
  test("selects deterministic non-overlapping primary and alternate windows", () => {
    expect(mediaTransformSampleWindow(60_000, "primary")).toEqual({
      offsetMs: 12_000,
      durationMs: MEDIA_TRANSFORM_SAMPLE_TARGET_MS,
    });
    expect(mediaTransformSampleWindow(60_000, "alternate")).toEqual({
      offsetMs: 36_000,
      durationMs: MEDIA_TRANSFORM_SAMPLE_TARGET_MS,
    });
  });

  test("uses the whole source when it is shorter than the normalized target", () => {
    expect(mediaTransformSampleWindow(8_250, "primary")).toEqual({
      offsetMs: 0,
      durationMs: 8_250,
    });
    expect(mediaTransformSampleWindow(8_250, "alternate")).toEqual({
      offsetMs: 0,
      durationMs: 8_250,
    });
  });
});
