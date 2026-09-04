import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  attachImmutableVideo,
  createOriginalVideoSubmission,
  type VideoExtractedFrame,
  type VideoSubmissionState,
} from "../../../domain/src/video-submission.ts";
import type {
  MediaTransformVideoAttemptContext,
  MediaTransformVideoCapabilities,
} from "../media/transform.ts";
import type { PersonaRecord } from "../use-cases/personas.ts";
import {
  runOriginalVideoAnalysis,
  VideoAnalysisPending,
  VideoAnalysisRetryable,
  type VideoAnalysisProviders,
  type VideoAnalysisRuntimeServices,
  type VideoTransformAttemptStore,
} from "./analysis.ts";
import type { VideoPublicationStore, VideoSubmissionRecord } from "./publication.ts";

const HASHES = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));
const actor = "video-analysis-account";
const personaId = "video-analysis-persona";
const persona: PersonaRecord = {
  persona_id: personaId,
  object: "persona",
  status: "active",
  profile: {
    persona_id: personaId,
    object: "persona_profile",
    revision: 1,
    display_name: "Video Analysis Fixture",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: null,
  },
  wallet_set: { evm: null },
  created_at: "2026-09-04T00:00:00.000Z",
  retired_at: null,
};

const publicPersona = {
  persona_id: personaId,
  object: "persona" as const,
  display_name: persona.profile.display_name,
  avatar_ref: null,
  primary_public_handle: null,
};

function analysisState(): VideoSubmissionState {
  return {
    ...attachImmutableVideo(
      createOriginalVideoSubmission({
        submissionId: "video-analysis-submission",
        operationId: "video-analysis-operation",
        communityId: "video-analysis-community",
        actorAccountId: actor,
        authorPersonaId: personaId,
        reservationId: "video-analysis-reservation",
        caption: "  A\r\ncaption  ",
        authorDeclaredRating: "general",
      }),
      {
        videoRevision: 1,
        immutableRef: "media://immutable/video-analysis-operation/video/1",
        canonicalSha256: HASHES[0] as string,
        contentType: "video/mp4",
        sizeBytes: 1_024,
      },
    ),
    posterTimestampMs: 1_500,
  };
}

const frames = (): readonly [VideoExtractedFrame, VideoExtractedFrame, VideoExtractedFrame] => [
  {
    role: "poster",
    requestedTimestampMs: 1_500,
    timestampMs: 1_500,
    sha256: HASHES[2] as string,
    artifactRef: "media://derived/video-analysis-operation/poster",
  },
  {
    role: "first",
    requestedTimestampMs: null,
    timestampMs: 0,
    sha256: HASHES[3] as string,
    artifactRef: "media://derived/video-analysis-operation/first",
  },
  {
    role: "midpoint",
    requestedTimestampMs: null,
    timestampMs: 5_000,
    sha256: HASHES[4] as string,
    artifactRef: "media://derived/video-analysis-operation/midpoint",
  },
];

function providers(overrides: Partial<VideoAnalysisProviders> = {}): VideoAnalysisProviders {
  return {
    hash: async (source) => ({
      canonicalSha256: source.canonicalSha256,
      byteLength: source.byteLength,
      evidenceRef: "hash:fixture",
    }),
    identifySoundtrack: async () => ({
      verification: { status: "no_match", evidenceRef: "acr:no-match", adapterRevision: "acr-v1" },
      evidenceRef: "acr:no-match",
      adapterRevision: "acr-v1",
    }),
    moderate: async ({ caption, captionSha256 }) => ({
      requestId: "safety:fixture",
      evidenceRef: `safety:${captionSha256}`,
      minorSafetyEvidenceRef: "minor-safety:fixture",
      mediaSafety: "allow",
      captionSafety: caption === null ? "not_applicable" : "allow",
      automatedRating: "general",
      policyRevision: "safety-v1",
      adapterRevision: "safety-adapter-v1",
    }),
    ...overrides,
  };
}

function transformContext(
  binding: Parameters<MediaTransformVideoCapabilities["probe"]>[0]["binding"],
): MediaTransformVideoAttemptContext {
  return {
    version: "media-transform-video-attempt-context-v1",
    ...binding,
    adapterRevision: "media-transform-fixture-v1",
  };
}

function transform(
  overrides: Partial<MediaTransformVideoCapabilities> = {},
): MediaTransformVideoCapabilities {
  return {
    probe: (input) =>
      Effect.succeed({
        status: "completed",
        attempt: input.attempt,
        context: transformContext(input.binding),
        probe: {
          evidenceRef: "probe:fixture",
          durationMs: 10_000,
          width: 1_080,
          height: 1_920,
          frameRateMillihertz: 30_000,
          videoCodec: "h264",
          audioCodec: "aac",
          hasAudio: true,
        },
      }),
    extractVideoAudio: (input) =>
      Effect.succeed({
        status: "completed",
        attempt: input.attempt,
        context: transformContext(input.binding),
        artifact: {
          artifactRef: "media://derived/video-analysis-operation/audio",
          canonicalSha256: HASHES[1] as string,
          sourceSha256: input.source.sha256,
          videoRevision: input.binding.videoRevision,
          mediaType: "audio/mp4",
          policyRevision: input.extractionPolicyVersion,
          adapterRevision: "extract-audio-fixture",
        },
      }),
    extractVideoFrames: (input) =>
      Effect.succeed({
        status: "completed",
        attempt: input.attempt,
        context: transformContext(input.binding),
        extraction: {
          evidenceRef: "frames:fixture",
          adapterRevision: "frames-v1",
          sourceSha256: input.source.sha256,
          videoRevision: input.binding.videoRevision,
          posterPolicyRevision: input.posterPolicy.policyRevision,
          frames: frames().map((frame, index) =>
            index === 0
              ? {
                  ...frame,
                  requestedTimestampMs: input.posterTimestampMs,
                  timestampMs: input.posterTimestampMs,
                }
              : frame,
          ) as [VideoExtractedFrame, VideoExtractedFrame, VideoExtractedFrame],
        },
      }),
    ...overrides,
  };
}

function services(input: {
  providers: VideoAnalysisProviders;
  transform?: MediaTransformVideoCapabilities;
  transformAttempts?: VideoTransformAttemptStore;
  onDecision?: (state: VideoSubmissionState) => void;
  onFailure?: (code: string) => void;
}): VideoAnalysisRuntimeServices {
  const initial: VideoSubmissionRecord = {
    state: analysisState(),
    authorPersona: publicPersona,
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused video analysis store method");
  };
  const store: VideoPublicationStore = {
    replayReservation: unused,
    createReservation: unused,
    getReservationForAuthor: unused,
    getReservationForAccount: unused,
    renewParts: unused,
    createSubmission: unused,
    getSubmissionForAccount: unused,
    getSubmissionByOperation: async () => initial,
    getSubmissionForModerator: unused,
    replayCommand: unused,
    beginFinalize: unused,
    recordMultipartCompleted: unused,
    abandonInvalidManifest: unused,
    finalizeSealed: unused,
    abandonExpectationMismatch: unused,
    commitAnalysisDecision: async ({ nextState }) => {
      input.onDecision?.(nextState);
      return { ...initial, state: nextState };
    },
    recordProcessingFailure: async ({ failureCode }) => {
      input.onFailure?.(failureCode);
      return {
        ...initial,
        state: { ...initial.state, status: "processing_failed", phase: null, failureCode },
      };
    },
    publish: async ({ state }) => ({ ...initial, state }),
    retryPoster: unused,
    retryTechnical: unused,
    cancel: unused,
    moderate: unused,
  };
  return {
    store,
    nowIso: () => "2026-09-04T00:01:00.000Z",
    randomUuid: () => "00000000-0000-4000-8000-000000000001",
    analysisProviders: input.providers,
    transform: input.transform ?? transform(),
    transformAttempts: input.transformAttempts ?? {
      loadOrCreate: async ({ initialAttempt }) => initialAttempt,
      advance: async ({ attempt }) => attempt,
    },
  };
}

describe("original-video trusted analysis runtime", () => {
  test("persists provider progress and defers without recording a technical failure", async () => {
    let advanced = 0;
    let failures = 0;
    const pendingTransform = transform({
      probe: (input) =>
        Effect.succeed({
          status: "submitted",
          attempt: {
            ...input.attempt,
            providerJobId: "b".repeat(32),
            providerJobPhase: "allocated",
          },
        }),
    });
    const runtime = services({
      providers: providers(),
      transform: pendingTransform,
      transformAttempts: {
        loadOrCreate: async ({ initialAttempt }) => initialAttempt,
        advance: async ({ attempt }) => {
          advanced += 1;
          return attempt;
        },
      },
      onFailure: () => failures++,
    });

    await expect(
      runOriginalVideoAnalysis(
        { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
        runtime,
      ),
    ).rejects.toBeInstanceOf(VideoAnalysisPending);
    expect(advanced).toBe(1);
    expect(failures).toBe(0);
  });

  test("leaves a retryable provider failure to the bounded outbox retry policy", async () => {
    let failures = 0;
    const retryableTransform = transform({
      probe: (input) =>
        Effect.succeed({
          status: "retryable_failure",
          reason: "transport",
          attempt: input.attempt,
        }),
    });

    await expect(
      runOriginalVideoAnalysis(
        { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
        services({
          providers: providers(),
          transform: retryableTransform,
          onFailure: () => failures++,
        }),
      ),
    ).rejects.toBeInstanceOf(VideoAnalysisRetryable);
    expect(failures).toBe(0);
  });

  test("uses the persisted poster timestamp and publishes one closed trusted bundle", async () => {
    const decisions: VideoSubmissionState[] = [];
    const result = await runOriginalVideoAnalysis(
      { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
      services({ providers: providers(), onDecision: (state) => decisions.push(state) }),
    );
    expect(result.status).toBe("published");
    expect(decisions[0]?.analysis?.frames.extracted[0]).toMatchObject({
      requestedTimestampMs: 1_500,
      timestampMs: 1_500,
    });
    expect(decisions[0]?.analysis?.safetyRequest.captionSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("routes ACR exhaustion and safety adapter absence to review, never implicit allow", async () => {
    const decisions: VideoSubmissionState[] = [];
    const result = await runOriginalVideoAnalysis(
      { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
      services({
        providers: providers({
          identifySoundtrack: async () => {
            throw new Error("provider exhausted");
          },
          moderate: async () => {
            throw new Error("safety unavailable");
          },
        }),
        onDecision: (state) => decisions.push(state),
      }),
    );
    expect(result.status).toBe("manual_review");
    expect(decisions[0]?.reviewReasons).toContain("soundtrack_exhausted");
    expect(decisions[0]?.reviewReasons).toContain("safety_adapter_unavailable");
  });

  test("records poster extraction responsibility without discarding the sealed revision", async () => {
    const failures: string[] = [];
    const result = await runOriginalVideoAnalysis(
      { submissionId: "video-analysis-submission", operationId: "video-analysis-operation" },
      services({
        providers: providers(),
        transform: transform({
          extractVideoFrames: (input) =>
            Effect.succeed({
              status: "rejected",
              reason: "poster_timestamp_out_of_range",
              attempt: input.attempt,
            }),
        }),
        onFailure: (code) => failures.push(code),
      }),
    );
    expect(result).toMatchObject({
      status: "processing_failed",
      reason_code: "poster_timestamp_out_of_range",
      video_revision: 1,
    });
    expect(failures).toEqual(["poster_timestamp_out_of_range"]);
  });
});
