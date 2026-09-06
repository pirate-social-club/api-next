import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mediaSha256Bytes } from "../../application/src/media/submission-service.ts";
import type { MediaIdentificationOutcomeKind } from "../../application/src/media-identification-provider.ts";
import { validateVideoStageFact } from "../../application/src/video/stage-facts.ts";
import { makeVideoRecognitionProvider } from "./video-recognition-provider.ts";

async function fixture(
  outcomes: readonly MediaIdentificationOutcomeKind[],
  disabled = false,
  badDigest = false,
) {
  const bytes = new Uint8Array([255, 251, 144, 0]);
  const digest = await mediaSha256Bytes(bytes);
  const clips = (["primary", "alternate"] as const).map((variant) => ({
    variant,
    artifactRef: `media://derived/video-analysis/${variant}.mp3`,
    canonicalSha256: badDigest ? "a".repeat(64) : digest,
    sizeBytes: bytes.length,
    mediaType: "audio/mpeg" as const,
    offsetMs: variant === "primary" ? 42000 : 126000,
    durationMs: 12000,
  }));
  const calls: string[] = [];
  const reads: string[] = [];
  const sleeps: number[] = [];
  const provider = makeVideoRecognitionProvider({
    identification: disabled
      ? null
      : {
          identify: (input) => {
            calls.push(input.sample.filename);
            expect(input.canonicalAudioSha256).toBe(digest);
            expect(input.analysisRevision).toBe(2);
            expect(input.requestId).toContain("-c2-");
            expect(input.sample.contentType).toBe("audio/mpeg");
            return Effect.succeed({
              context: {
                version: "media-identification-attempt-context-v1",
                operationId: input.operationId,
                audioRevision: input.audioRevision,
                analysisRevision: input.analysisRevision,
                canonicalAudioSha256: input.canonicalAudioSha256,
                requestId: input.requestId,
                adapterRevision: "acrcloud-v1",
              },
              ...(outcomes[calls.length - 1] ?? { outcome: "no_match" }),
            });
          },
        },
    reader: {
      readAudioSample: async (artifact, maximum) => {
        reads.push(artifact.objectKey);
        expect(maximum).toBe(4_000_000);
        return bytes;
      },
      readCoverArtifact: async () => {
        throw new Error("not a cover");
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const [primary, alternate] = clips;
  if (!primary || !alternate) throw new Error("fixture clips missing");
  const result = await provider({
    operationId: "recognition-test",
    videoRevision: 1,
    creationRevision: 2,
    clips: [primary, alternate],
  });
  expect(
    validateVideoStageFact({
      stage: "recognition",
      adapterRevision: result.adapterRevision,
      snapshot: result,
      artifacts: [],
    }).snapshot,
  ).toEqual(result);
  return { result, calls, reads, sleeps };
}
const match = {
  outcome: "retained_reference_match",
  evidence: {
    version: "media-identification-match-evidence-v1",
    provider: "acrcloud",
    matchKind: "music",
    providerMatchId: "external-123",
    title: "Private title",
    artists: ["Private artist"],
    score: 99,
  },
} as const;

test("both clip no-matches clear recognition only", async () => {
  const f = await fixture([{ outcome: "no_match" }, { outcome: "no_match" }]);
  expect(f.result.verification?.status).toBe("no_match");
  expect(f.calls).toEqual(["primary.mp3", "alternate.mp3"]);
  expect(f.reads.every((key) => key.endsWith(".mp3"))).toBe(true);
});
test("primary inconclusive then alternate match retains external identity and private evidence", async () => {
  const f = await fixture([{ outcome: "inconclusive_fingerprint" }, match]);
  expect(f.result.verification).toMatchObject({
    status: "known_recording",
    identified: { kind: "external", providerRef: "external-123" },
  });
  expect(f.result.privateEvidence?.[1]?.match?.title).toBe("Private title");
  expect(JSON.stringify(f.result.verification)).not.toContain("Private title");
  expect(f.result.evidenceRef).toMatch(/^evidence_[a-f0-9]{64}$/u);
});
test("primary match skips alternate and never maps to a Pirate asset", async () => {
  const f = await fixture([match]);
  expect(f.calls).toEqual(["primary.mp3"]);
  expect(f.result.verification?.status).toBe("known_recording");
});
test("genuine inconclusive remains distinct from exhaustion and no-match", async () => {
  for (const outcomes of [
    [{ outcome: "no_match" }, { outcome: "inconclusive_fingerprint" }],
    [{ outcome: "inconclusive_fingerprint" }, { outcome: "no_match" }],
  ] as const)
    expect((await fixture(outcomes)).result.verification?.status).toBe("inconclusive");
});
test("throttling is bounded to three calls then acr_exhausted", async () => {
  const f = await fixture(
    Array.from({ length: 3 }, () => ({
      outcome: "retryable_failure" as const,
      reason: "throttled" as const,
    })),
  );
  expect(f.calls).toHaveLength(3);
  expect(f.sleeps).toEqual([1000, 2000]);
  expect(f.result).toMatchObject({ verification: null, exhaustion: "acr_exhausted" });
});
test("missing provider is skipped; artifact digest failure exhausts before provider IO", async () => {
  const skipped = await fixture([], true);
  expect(skipped.result).toMatchObject({ verification: null, exhaustion: "acr_skipped" });
  expect(skipped.reads).toHaveLength(0);
  const bad = await fixture([], false, true);
  expect(bad.result).toMatchObject({ verification: null, exhaustion: "acr_exhausted" });
  expect(bad.calls).toHaveLength(0);
});
