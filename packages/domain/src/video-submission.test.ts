import { describe, expect, test } from "bun:test";
import {
  attachImmutableVideo,
  attachVideoDecision,
  createOriginalVideoSubmission,
  decideOriginalAudioVideo,
  type OriginalAudioVerification,
  publishOriginalVideo,
  VIDEO_DERIVED_ARTIFACT_RETENTION_POLICY_V1,
  VIDEO_INGEST_POLICY_V1,
  type VideoSubmissionState,
  type VideoTrustedAnalysis,
  validateVideoTrustedAnalysis,
} from "./video-submission.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

function sealedState(caption: string | null = null): VideoSubmissionState {
  return attachImmutableVideo(
    createOriginalVideoSubmission({
      submissionId: "video-submission-1",
      operationId: "video-operation-1",
      communityId: "community-1",
      actorAccountId: "account-1",
      authorPersonaId: "persona-1",
      reservationId: "video-reservation-1",
      caption,
      authorDeclaredRating: "general",
    }),
    {
      videoRevision: 1,
      immutableRef: "r2://immutable/video-operation-1/original",
      canonicalSha256: HASH_A,
      contentType: "video/mp4",
      sizeBytes: 10_000,
    },
  );
}

function analysis(
  verification: OriginalAudioVerification | null = {
    status: "no_match",
    evidenceRef: "acr-evidence-1",
    adapterRevision: "acr-v1",
  },
): VideoTrustedAnalysis {
  return {
    version: "video-trusted-analysis-v1",
    operationId: "video-operation-1",
    videoRevision: 1,
    analysisRevision: 1,
    finalizedVideoRef: "r2://immutable/video-operation-1/original",
    canonicalVideoSha256: HASH_A,
    byteLength: 10_000,
    mediaType: "video/mp4",
    probe: {
      evidenceRef: "probe-evidence-1",
      ingestPolicyRevision: 1,
      durationMs: 3_000,
      width: 1_920,
      height: 1_080,
      frameRateMillihertz: 60_000,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
    },
    audio: {
      intent: "original_audio",
      soundtrack:
        verification === null
          ? {
              extractedAudioRef: "private://audio/video-operation-1",
              extractedAudioSha256: HASH_B,
              verification: null,
              exhaustion: "acr_exhausted",
              evidenceRef: "acr-exhaustion-1",
              policyRevision: "audio-extraction-v1",
            }
          : {
              extractedAudioRef: "private://audio/video-operation-1",
              extractedAudioSha256: HASH_B,
              verification,
              policyRevision: "audio-extraction-v1",
            },
    },
    frames: {
      posterPolicyRevision: 1,
      evidenceRef: "frames-evidence-1",
      adapterRevision: "frames-v1",
      extracted: [
        {
          role: "poster",
          requestedTimestampMs: 1_000,
          timestampMs: 1_000,
          sha256: HASH_C,
          artifactRef: "private://frame/poster",
        },
        {
          role: "first",
          requestedTimestampMs: null,
          timestampMs: 0,
          sha256: HASH_D,
          artifactRef: "private://frame/first",
        },
        {
          role: "midpoint",
          requestedTimestampMs: null,
          timestampMs: 1_500,
          sha256: HASH_E,
          artifactRef: "private://frame/midpoint",
        },
      ],
    },
    safetyRequest: {
      requestId: "safety-request-1",
      frameSha256s: [HASH_C, HASH_D, HASH_E],
      captionSha256: null,
      evidenceRef: "safety-evidence-1",
      minorSafetyEvidenceRef: "minor-safety-evidence-1",
    },
    mediaSafety: "allow",
    captionSafety: "not_applicable",
    automatedRating: "general",
    safetyPolicyRevision: "safety-v1",
    adapterRevisions: {
      probe: "probe-v1",
      acr: "acr-v1",
      frames: "frames-v1",
      safety: "safety-v1",
    },
  };
}

const decide = (state: VideoSubmissionState, value: VideoTrustedAnalysis) =>
  decideOriginalAudioVideo({
    state,
    analysis: value,
    canonicalCaptionSha256: value.safetyRequest.captionSha256,
    decidedAt: "2026-09-04T10:00:00.000Z",
  });

describe("original-audio video policy", () => {
  test("pins the ratified ingest and retention limits", () => {
    expect(VIDEO_INGEST_POLICY_V1).toMatchObject({
      minDurationMs: 3_000,
      maxDurationMs: 180_000,
      maxBytes: 500 * 1024 * 1024,
      maxLongEdgePx: 1_920,
      maxFrameRateMillihertz: 60_000,
      videoCodecs: ["h264"],
      audioCodecs: ["aac"],
    });
    expect(VIDEO_DERIVED_ARTIFACT_RETENTION_POLICY_V1.extractedAudioMayOutliveSource).toBe(false);
  });

  test("accepts only analysis bound to the immutable video, three roles, and caption hash", () => {
    const state = sealedState();
    expect(validateVideoTrustedAnalysis(state, analysis(), null)).toBeNull();
    expect(
      validateVideoTrustedAnalysis(state, { ...analysis(), canonicalVideoSha256: HASH_B }, null),
    ).toBe("lineage");
    expect(
      validateVideoTrustedAnalysis(
        state,
        { ...analysis(), probe: { ...analysis().probe, durationMs: 2_999 } },
        null,
      ),
    ).toBe("probe");
    expect(validateVideoTrustedAnalysis(state, analysis(), null)).toBeNull();
    expect(
      validateVideoTrustedAnalysis(
        state,
        { ...analysis(), probe: { ...analysis().probe, durationMs: 180_001 } },
        null,
      ),
    ).toBe("probe");
    expect(
      validateVideoTrustedAnalysis(
        state,
        {
          ...analysis(),
          safetyRequest: { ...analysis().safetyRequest, frameSha256s: [HASH_D, HASH_C, HASH_E] },
        },
        null,
      ),
    ).toBe("safety_binding");
  });

  test("publishes no-match, genuine inconclusive, and proved self-owned recordings", () => {
    const state = sealedState();
    const allowed: OriginalAudioVerification[] = [
      { status: "no_match", evidenceRef: "evidence-1", adapterRevision: "acr-v1" },
      { status: "inconclusive", evidenceRef: "evidence-2", adapterRevision: "acr-v1" },
      {
        status: "known_self_owned_recording",
        identifiedAssetId: "private-asset-1",
        ownerEvidenceRef: "owner-evidence-1",
        evidenceRef: "evidence-3",
        adapterRevision: "acr-v1",
      },
    ];
    for (const verification of allowed) {
      expect(decide(state, analysis(verification)).outcome).toEqual({ kind: "publish" });
    }
  });

  test("blocks every referenceable Pirate match even for the same account", () => {
    const decision = decide(
      sealedState(),
      analysis({
        status: "known_recording",
        identified: {
          kind: "pirate_song",
          assetId: "song-asset-1",
          referenceableSongPostId: "song-post-1",
          ownerRelation: "same_account",
        },
        evidenceRef: "acr-evidence-1",
        adapterRevision: "acr-v1",
      }),
    );
    expect(decision.outcome).toEqual({
      kind: "block",
      reasonCode: "known_recording_requires_song_reference",
      publicReason: "known_recording_requires_song_reference",
      songPostId: "song-post-1",
    });
  });

  test("holds external matches, exhaustion, and safety review without collapsing reasons", () => {
    const external = analysis({
      status: "known_recording",
      identified: { kind: "external", providerRef: "provider-recording-1" },
      evidenceRef: "acr-evidence-1",
      adapterRevision: "acr-v1",
    });
    expect(decide(sealedState(), external).outcome).toEqual({
      kind: "review",
      reasonCodes: ["soundtrack_known_recording"],
    });
    const exhausted = analysis(null);
    const both = {
      ...exhausted,
      mediaSafety: "review_required" as const,
    };
    expect(decide(sealedState(), both).outcome).toEqual({
      kind: "review",
      reasonCodes: ["media_review_required", "soundtrack_exhausted"],
    });
  });

  test("commits the original-sound identity from exact extracted evidence", () => {
    const initial = sealedState();
    const trusted = analysis();
    const decision = decide(initial, trusted);
    const ready = attachVideoDecision(initial, trusted, decision);
    const published = publishOriginalVideo(ready, "video-post-1");
    expect(published.state).toMatchObject({ status: "published", postId: "video-post-1" });
    expect(published.originalSound).toEqual({
      originalSoundId: "original-sound-video-operation-1",
      originVideoPostId: "video-post-1",
      originVideoRevision: 1,
      extractedAudioRef: "private://audio/video-operation-1",
      extractedAudioSha256: HASH_B,
      extractionPolicyRevision: "audio-extraction-v1",
      retentionPolicyRevision: 1,
    });
  });
});
