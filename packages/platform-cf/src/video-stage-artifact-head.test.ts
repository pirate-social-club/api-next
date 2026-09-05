import { describe, expect, test } from "bun:test";
import {
  type VideoStageFact,
  validateVideoStageFact,
  verifyVideoStageArtifacts,
} from "@pirate/application/video/stage-facts";
import { makeVideoStageArtifactHead } from "./video-stage-artifact-head.ts";

const ref = "media://derived/video-analysis/op/v1/c1/a1/soundtrack.m4a";
const digest = "a".repeat(64);
const audio: VideoStageFact = {
  stage: "audio",
  adapterRevision: "qencode-v1",
  snapshot: {
    artifactRef: ref,
    canonicalSha256: digest,
    sourceSha256: "b".repeat(64),
    videoRevision: 1,
    mediaType: "audio/mp4",
    policyRevision: "audio-v1",
    adapterRevision: "qencode-v1",
  },
  artifacts: [
    { artifactRef: ref, canonicalSha256: digest, sizeBytes: 42, contentType: "audio/mp4" },
  ],
};

describe("sealed video stage recovery", () => {
  test("verifies sealed artifacts by HEAD without fetching temporary provider output", async () => {
    const keys: string[] = [];
    const head = makeVideoStageArtifactHead({
      head: async (key) => {
        keys.push(key);
        return {
          size: 42,
          customMetadata: { sha256: digest },
          httpMetadata: { contentType: "audio/mp4" },
        };
      },
    });
    await verifyVideoStageArtifacts(audio, head);
    expect(keys).toEqual([ref.slice("media://derived/".length)]);
  });
  for (const mismatch of [
    null,
    { canonicalSha256: "c".repeat(64), sizeBytes: 42, contentType: "audio/mp4" },
    { canonicalSha256: digest, sizeBytes: 43, contentType: "audio/mp4" },
    { canonicalSha256: digest, sizeBytes: 42, contentType: "image/jpeg" },
  ]) {
    test(`fails closed for artifact identity mismatch ${JSON.stringify(mismatch)}`, async () => {
      await expect(verifyVideoStageArtifacts(audio, async () => mismatch)).rejects.toThrow(
        "video sealed stage artifact identity rejected",
      );
    });
  }
  test("requires exact snapshot and artifact bindings", () => {
    expect(validateVideoStageFact(audio)).toEqual(audio);
    expect(() =>
      validateVideoStageFact({
        ...audio,
        snapshot: { ...audio.snapshot, providerUrl: "https://provider.invalid/output" },
      }),
    ).toThrow();
    expect(() => validateVideoStageFact({ ...audio, artifacts: [] })).toThrow(
      "video stage artifact binding rejected",
    );
    expect(() =>
      validateVideoStageFact({
        ...audio,
        artifacts: [{ ...audio.artifacts[0], canonicalSha256: "c".repeat(64) }],
      }),
    ).toThrow();
  });
  test("refuses traversal and URL-shaped references before HEAD", async () => {
    let calls = 0;
    const head = makeVideoStageArtifactHead({
      head: async () => {
        calls++;
        return null;
      },
    });
    for (const invalid of [
      "https://provider.invalid/output",
      "media://derived/../private",
      "media://derived/%2e%2e/private",
    ])
      await expect(head(invalid)).rejects.toThrow("invalid derived artifact reference");
    expect(calls).toBe(0);
  });
});
