import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { disabledMediaTransform } from "./media-transform.ts";

describe("disabled media transform", () => {
  test("is inert for every provider-owned capability", async () => {
    const attempt = {
      version: "media-transform-attempt-v1" as const,
      runtimeFence: { submittedAtMs: 1, runtimeDeadlineMs: 2 },
    };
    const source = {
      objectKey: "immutable/video.mp4",
      sha256: "a".repeat(64),
      byteLength: 1,
      mediaType: "video/mp4" as const,
    };
    const binding = {
      operationId: "operation",
      videoRevision: 1,
      analysisRevision: 1,
      canonicalVideoSha256: "a".repeat(64),
      requestId: "request",
    };

    await expect(
      Effect.runPromise(
        disabledMediaTransform.probe({
          version: "media-transform-video-probe-input-v1",
          binding,
          source,
          attempt,
        }),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "disabled", attempt });
    await expect(
      Effect.runPromise(
        disabledMediaTransform.extractVideoAudio({
          version: "media-transform-video-audio-input-v1",
          binding,
          source,
          extractionPolicyVersion: "video-audio-aac-44100-stereo-v1",
          attempt,
        }),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "disabled", attempt });
    await expect(
      Effect.runPromise(
        disabledMediaTransform.cancelJob({
          version: "media-transform-cancel-input-v1",
          requestId: "request",
          providerJobId: "job",
        }),
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "disabled" });
  });
});
