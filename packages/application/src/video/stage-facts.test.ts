import { expect, test } from "bun:test";
import { validateVideoStageFact } from "./stage-facts.ts";

const sha = "a".repeat(64);
const frames = ["poster", "first", "midpoint"].map((role) => ({
  role,
  requestedTimestampMs: role === "poster" ? 1000 : null,
  timestampMs: 1000,
  sha256: sha,
  artifactRef: `media://derived/video-analysis/${role}.jpg`,
}));
const fixtures = [
  {
    stage: "probe",
    adapterRevision: "v1",
    artifacts: [],
    snapshot: {
      evidenceRef: "probe:1",
      ingestPolicyRevision: 1,
      durationMs: 3000,
      width: 1080,
      height: 1920,
      frameRateMillihertz: 30000,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
    },
  },
  {
    stage: "frames",
    adapterRevision: "v1",
    snapshot: {
      evidenceRef: "frames:1",
      adapterRevision: "v1",
      sourceSha256: sha,
      videoRevision: 1,
      posterPolicyRevision: 1,
      frames,
    },
    artifacts: frames.map((f) => ({
      artifactRef: f.artifactRef,
      canonicalSha256: sha,
      sizeBytes: 42,
      contentType: "image/jpeg",
    })),
  },
  {
    stage: "recognition",
    adapterRevision: "v1",
    artifacts: [],
    snapshot: {
      verification: {
        status: "no_match",
        evidenceRef: "acr:1",
        adapterRevision: "v1",
      },
      evidenceRef: "acr:1",
      adapterRevision: "v1",
    },
  },
  {
    stage: "recognition",
    adapterRevision: "v1",
    artifacts: [],
    snapshot: {
      verification: null,
      exhaustion: "acr_exhausted",
      evidenceRef: "acr:1",
      adapterRevision: "v1",
    },
  },
  {
    stage: "safety",
    adapterRevision: "v1",
    artifacts: [],
    snapshot: {
      requestId: "safety:1",
      evidenceRef: "safety:1",
      minorSafetyEvidenceRef: null,
      mediaSafety: "allow",
      captionSafety: "not_applicable",
      automatedRating: "general",
      policyRevision: "safety-v1",
      adapterRevision: "v1",
    },
  },
];
for (const [index, fact] of fixtures.entries()) {
  test(`closed video stage snapshot ${index}: ${fact.stage}`, () => {
    expect(validateVideoStageFact(fact) as unknown).toEqual(fact);
    expect(() =>
      validateVideoStageFact({ ...fact, snapshot: { ...fact.snapshot, untrusted: true } }),
    ).toThrow();
    expect(() => validateVideoStageFact({ ...fact, snapshot: {} })).toThrow();
  });
}
test("rejects duplicate frame roles and malformed nested recognition", () => {
  const fact = fixtures[1];
  expect(() =>
    validateVideoStageFact({
      ...fact,
      snapshot: { ...fact?.snapshot, frames: [frames[0], frames[0], frames[2]] },
    }),
  ).toThrow();
  expect(() =>
    validateVideoStageFact({
      ...fixtures[2],
      snapshot: {
        verification: {
          status: "known_recording",
          evidenceRef: "acr:1",
          adapterRevision: "v1",
          identified: { kind: "external", providerRef: "external:1", callerSupplied: true },
        },
        evidenceRef: "acr:1",
        adapterRevision: "v1",
      },
    }),
  ).toThrow();
});
