import { NotFound, type VideoPostSubmissionV1 } from "@pirate/contracts";
import { Effect } from "effect";
import type {
  OriginalAudioVerification,
  VideoExtractedFrame,
  VideoTrustedAnalysis,
} from "../../../domain/src/video-submission.ts";
import {
  VIDEO_INGEST_POLICY_V1,
  VIDEO_POSTER_POLICY_V1,
} from "../../../domain/src/video-submission.ts";
import { mediaSha256Bytes } from "../media/submission-service.ts";
import type {
  MediaTransformAttempt,
  MediaTransformVideoBinding,
  MediaTransformVideoCapabilities,
} from "../media/transform.ts";
import { MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1 } from "../media/transform.ts";
import {
  acceptTrustedVideoAnalysis,
  recordVideoProcessingFailure,
  type VideoPublicationCommitServices,
} from "./publication.ts";

export type VideoAnalysisSource = Readonly<{
  operationId: string;
  videoRevision: number;
  immutableRef: string;
  canonicalSha256: string;
  byteLength: number;
  mediaType: "video/mp4" | "video/quicktime";
}>;

export type VideoProbeFact = VideoTrustedAnalysis["probe"];

export type VideoSoundtrackFact =
  | Readonly<{
      verification: OriginalAudioVerification;
      evidenceRef: string;
      adapterRevision: string;
    }>
  | Readonly<{
      verification: null;
      exhaustion: "acr_exhausted" | "acr_skipped";
      evidenceRef: string;
      adapterRevision: string;
    }>;

export type VideoSafetyFact = Readonly<{
  requestId: string;
  evidenceRef: string;
  minorSafetyEvidenceRef: string | null;
  mediaSafety: "allow" | "review_required" | "blocked";
  captionSafety: "not_applicable" | "allow" | "review_required" | "blocked";
  automatedRating: "general" | "adult_18";
  policyRevision: string;
  adapterRevision: string;
}>;

export type VideoFrameExtractionResult =
  | Readonly<{
      outcome: "ready";
      evidenceRef: string;
      adapterRevision: string;
      frames: readonly [VideoExtractedFrame, VideoExtractedFrame, VideoExtractedFrame];
    }>
  | Readonly<{
      outcome: "failed";
      reasonCode: "poster_undecodable" | "poster_timestamp_out_of_range" | "transform_failed";
      evidenceRef: string;
    }>;

/** Non-transform providers return only trusted server facts. Media transforms use MediaTransform. */
export type VideoAnalysisProviders = Readonly<{
  hash: (
    source: VideoAnalysisSource,
  ) => Promise<Readonly<{ canonicalSha256: string; byteLength: number; evidenceRef: string }>>;
  identifySoundtrack: (
    input: Readonly<{
      operationId: string;
      extractedAudioRef: string;
      extractedAudioSha256: string;
    }>,
  ) => Promise<VideoSoundtrackFact>;
  moderate: (
    input: Readonly<{
      operationId: string;
      caption: string | null;
      captionSha256: string | null;
      frames: readonly [VideoExtractedFrame, VideoExtractedFrame, VideoExtractedFrame];
    }>,
  ) => Promise<VideoSafetyFact>;
}>;

export type VideoTransformCapability = "audio" | "frames" | "probe";

export type VideoTransformAttemptStore = Readonly<{
  loadOrCreate: (
    input: Readonly<{
      submissionId: string;
      binding: MediaTransformVideoBinding;
      capability: VideoTransformCapability;
      initialAttempt: MediaTransformAttempt;
    }>,
  ) => Promise<MediaTransformAttempt>;
  advance: (
    input: Readonly<{
      submissionId: string;
      binding: MediaTransformVideoBinding;
      capability: VideoTransformCapability;
      attempt: MediaTransformAttempt;
    }>,
  ) => Promise<MediaTransformAttempt>;
}>;

export class VideoAnalysisPending extends Error {
  readonly retryAfterSeconds = 2;
}

export class VideoAnalysisRetryable extends Error {
  constructor(
    readonly failureCode: "probe_failed" | "transform_failed",
    readonly evidenceRef: string,
  ) {
    super(failureCode);
  }
}

export type VideoAnalysisRuntimeServices = VideoPublicationCommitServices &
  Readonly<{
    analysisProviders: VideoAnalysisProviders;
    transform: MediaTransformVideoCapabilities;
    transformAttempts: VideoTransformAttemptStore;
  }>;

const encoder = new TextEncoder();
const VIDEO_TRANSFORM_RUNTIME_MS = 30 * 60 * 1_000;

async function videoTransformBinding(
  source: VideoAnalysisSource,
  analysisRevision: number,
  capability: "probe" | "audio" | "frames",
): Promise<MediaTransformVideoBinding> {
  const digest = await mediaSha256Bytes(
    encoder.encode(
      [
        source.operationId,
        source.videoRevision,
        analysisRevision,
        source.canonicalSha256,
        capability,
      ].join("\n"),
    ),
  );
  return {
    operationId: source.operationId,
    videoRevision: source.videoRevision,
    analysisRevision,
    canonicalVideoSha256: source.canonicalSha256,
    requestId: `video-${capability}-${digest.slice(0, 32)}`,
  };
}

function videoTransformAttempt(updatedAt: string): MediaTransformAttempt {
  const submittedAtMs = Date.parse(updatedAt);
  if (!Number.isSafeInteger(submittedAtMs) || submittedAtMs < 0) {
    throw new TypeError("video transform requires a durable submission timestamp");
  }
  return {
    version: "media-transform-attempt-v1",
    runtimeFence: {
      submittedAtMs,
      runtimeDeadlineMs: submittedAtMs + VIDEO_TRANSFORM_RUNTIME_MS,
    },
  };
}

async function runTransform<T extends Readonly<{ status: string; attempt: MediaTransformAttempt }>>(
  input: Readonly<{
    submissionId: string;
    binding: MediaTransformVideoBinding;
    capability: VideoTransformCapability;
    initialAttempt: MediaTransformAttempt;
    execute: (attempt: MediaTransformAttempt) => Promise<T>;
  }>,
  services: VideoAnalysisRuntimeServices,
): Promise<T> {
  const attempt = await services.transformAttempts.loadOrCreate(input);
  const outcome = await input.execute(attempt);
  if (outcome.attempt.providerJobId !== undefined) {
    await services.transformAttempts.advance({
      submissionId: input.submissionId,
      binding: input.binding,
      capability: input.capability,
      attempt: outcome.attempt,
    });
  }
  if (outcome.status === "submitted" || outcome.status === "processing") {
    throw new VideoAnalysisPending();
  }
  return outcome;
}

function rethrowDeferred(error: unknown): void {
  if (error instanceof VideoAnalysisPending || error instanceof VideoAnalysisRetryable) {
    throw error;
  }
}

export async function canonicalVideoCaptionSha256(caption: string | null): Promise<string | null> {
  if (caption === null) return null;
  return mediaSha256Bytes(
    encoder.encode(caption.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim()),
  );
}

async function fail(
  input: Readonly<{
    submissionId: string;
    operationId: string;
    failureCode:
      | "probe_failed"
      | "hash_failed"
      | "transform_failed"
      | "poster_undecodable"
      | "poster_timestamp_out_of_range";
    evidenceRef: string;
  }>,
  services: VideoAnalysisRuntimeServices,
): Promise<VideoPostSubmissionV1> {
  return recordVideoProcessingFailure(input, services);
}

/** Runs the blocking phase-one pipeline once, then hands one closed bundle to the decision fence. */
export async function runOriginalVideoAnalysis(
  input: Readonly<{ submissionId: string; operationId: string }>,
  services: VideoAnalysisRuntimeServices,
): Promise<VideoPostSubmissionV1> {
  const record = await services.store.getSubmissionByOperation(input);
  if (record === null) throw new NotFound({ message: "Video submission not found" });
  const video = record.state.video;
  if (record.state.status !== "processing" || record.state.phase !== "analysis" || video === null) {
    if (record.state.analysis === null) {
      throw new NotFound({ message: "Video analysis is not available" });
    }
    return acceptTrustedVideoAnalysis(
      {
        submissionId: input.submissionId,
        analysis: record.state.analysis,
      },
      services,
    );
  }
  const state = record.state;
  const source: VideoAnalysisSource = {
    operationId: state.operationId,
    videoRevision: state.videoRevision,
    immutableRef: video.immutableRef,
    canonicalSha256: video.canonicalSha256,
    byteLength: video.sizeBytes,
    mediaType: video.contentType,
  };
  const transformSource = {
    objectKey: source.immutableRef,
    sha256: source.canonicalSha256,
    byteLength: source.byteLength,
    mediaType: source.mediaType,
  } as const;
  const analysisRevision = state.analysisRevision + 1;
  const transformAttempt = videoTransformAttempt(record.updatedAt);

  let hash: Awaited<ReturnType<VideoAnalysisProviders["hash"]>>;
  try {
    hash = await services.analysisProviders.hash(source);
  } catch {
    return fail(
      { ...input, failureCode: "hash_failed", evidenceRef: "video-hash:failed" },
      services,
    );
  }
  if (hash.canonicalSha256 !== source.canonicalSha256 || hash.byteLength !== source.byteLength) {
    return fail({ ...input, failureCode: "hash_failed", evidenceRef: hash.evidenceRef }, services);
  }

  let probe: VideoProbeFact;
  let probeAdapterRevision: string;
  try {
    const transformBinding = await videoTransformBinding(source, analysisRevision, "probe");
    const outcome = await runTransform(
      {
        submissionId: state.submissionId,
        binding: transformBinding,
        capability: "probe",
        initialAttempt: transformAttempt,
        execute: (attempt) =>
          Effect.runPromise(
            services.transform.probe({
              version: "media-transform-video-probe-input-v1",
              binding: transformBinding,
              source: transformSource,
              attempt,
            }),
          ),
      },
      services,
    );
    if (outcome.status === "retryable_failure") {
      throw new VideoAnalysisRetryable("probe_failed", "video-probe:provider-retryable");
    }
    if (outcome.status !== "completed") throw new Error("video probe did not complete");
    probe = {
      ...outcome.probe,
      ingestPolicyRevision: VIDEO_INGEST_POLICY_V1.policyRevision,
    };
    probeAdapterRevision = outcome.context.adapterRevision;
  } catch (error) {
    rethrowDeferred(error);
    return fail(
      { ...input, failureCode: "probe_failed", evidenceRef: "video-probe:failed" },
      services,
    );
  }
  if (
    probe.ingestPolicyRevision !== VIDEO_INGEST_POLICY_V1.policyRevision ||
    probe.durationMs < VIDEO_INGEST_POLICY_V1.minDurationMs ||
    probe.durationMs > VIDEO_INGEST_POLICY_V1.maxDurationMs ||
    Math.max(probe.width, probe.height) > VIDEO_INGEST_POLICY_V1.maxLongEdgePx ||
    probe.frameRateMillihertz > VIDEO_INGEST_POLICY_V1.maxFrameRateMillihertz ||
    probe.videoCodec !== "h264" ||
    probe.audioCodec !== "aac" ||
    probe.hasAudio !== true
  ) {
    return fail(
      { ...input, failureCode: "probe_failed", evidenceRef: probe.evidenceRef },
      services,
    );
  }

  let soundtrack: Readonly<{
    artifactRef: string;
    canonicalSha256: string;
    policyRevision: string;
    adapterRevision: string;
  }>;
  try {
    const transformBinding = await videoTransformBinding(source, analysisRevision, "audio");
    const outcome = await runTransform(
      {
        submissionId: state.submissionId,
        binding: transformBinding,
        capability: "audio",
        initialAttempt: transformAttempt,
        execute: (attempt) =>
          Effect.runPromise(
            services.transform.extractVideoAudio({
              version: "media-transform-video-audio-input-v1",
              binding: transformBinding,
              source: transformSource,
              extractionPolicyVersion: MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
              attempt,
            }),
          ),
      },
      services,
    );
    if (outcome.status === "retryable_failure") {
      throw new VideoAnalysisRetryable("transform_failed", "video-soundtrack:provider-retryable");
    }
    if (
      outcome.status !== "completed" ||
      outcome.artifact.sourceSha256 !== source.canonicalSha256 ||
      outcome.artifact.videoRevision !== source.videoRevision
    ) {
      throw new Error("video audio extraction did not complete");
    }
    soundtrack = outcome.artifact;
  } catch (error) {
    rethrowDeferred(error);
    return fail(
      { ...input, failureCode: "transform_failed", evidenceRef: "video-soundtrack:failed" },
      services,
    );
  }
  let identified: VideoSoundtrackFact;
  try {
    identified = await services.analysisProviders.identifySoundtrack({
      operationId: state.operationId,
      extractedAudioRef: soundtrack.artifactRef,
      extractedAudioSha256: soundtrack.canonicalSha256,
    });
  } catch {
    identified = {
      verification: null,
      exhaustion: "acr_exhausted",
      evidenceRef: "video-acr:exhausted",
      adapterRevision: "acr-unavailable",
    };
  }

  const posterTimestampMs =
    state.posterTimestampMs ?? VIDEO_POSTER_POLICY_V1.defaultPosterTimestampMs;
  let extracted: VideoFrameExtractionResult;
  try {
    const transformBinding = await videoTransformBinding(source, analysisRevision, "frames");
    const outcome = await runTransform(
      {
        submissionId: state.submissionId,
        binding: transformBinding,
        capability: "frames",
        initialAttempt: transformAttempt,
        execute: (attempt) =>
          Effect.runPromise(
            services.transform.extractVideoFrames({
              version: "media-transform-video-frames-input-v1",
              binding: transformBinding,
              source: transformSource,
              sourceDurationMs: probe.durationMs,
              sourceDimensions: { width: probe.width, height: probe.height },
              posterTimestampMs,
              posterPolicy: VIDEO_POSTER_POLICY_V1,
              attempt,
            }),
          ),
      },
      services,
    );
    if (outcome.status === "retryable_failure") {
      throw new VideoAnalysisRetryable("transform_failed", "video-frames:provider-retryable");
    }
    extracted =
      outcome.status === "completed" &&
      outcome.extraction.sourceSha256 === source.canonicalSha256 &&
      outcome.extraction.videoRevision === source.videoRevision &&
      outcome.extraction.posterPolicyRevision === VIDEO_POSTER_POLICY_V1.policyRevision
        ? {
            outcome: "ready",
            evidenceRef: outcome.extraction.evidenceRef,
            adapterRevision: outcome.extraction.adapterRevision,
            frames: outcome.extraction.frames,
          }
        : outcome.status === "rejected" &&
            (outcome.reason === "poster_undecodable" ||
              outcome.reason === "poster_timestamp_out_of_range")
          ? {
              outcome: "failed",
              reasonCode: outcome.reason,
              evidenceRef: `video-frames:${source.canonicalSha256}:${outcome.reason}`,
            }
          : {
              outcome: "failed",
              reasonCode: "transform_failed",
              evidenceRef: `video-frames:${source.canonicalSha256}:failed`,
            };
  } catch (error) {
    rethrowDeferred(error);
    return fail(
      { ...input, failureCode: "transform_failed", evidenceRef: "video-frames:failed" },
      services,
    );
  }
  if (extracted.outcome === "failed") {
    return fail(
      { ...input, failureCode: extracted.reasonCode, evidenceRef: extracted.evidenceRef },
      services,
    );
  }
  const captionSha256 = await canonicalVideoCaptionSha256(state.caption);
  let safety: VideoSafetyFact;
  try {
    safety = await services.analysisProviders.moderate({
      operationId: state.operationId,
      caption: state.caption,
      captionSha256,
      frames: extracted.frames,
    });
  } catch {
    safety = {
      requestId: `video-safety-${state.operationId}-r${state.creationRevision}`,
      evidenceRef: "video-safety:adapter-unavailable",
      minorSafetyEvidenceRef: null,
      mediaSafety: "review_required",
      captionSafety: state.caption === null ? "not_applicable" : "review_required",
      automatedRating: state.authorDeclaredRating,
      policyRevision: "video-safety-v1",
      adapterRevision: "safety-unavailable",
    };
  }

  const analysis: VideoTrustedAnalysis = {
    version: "video-trusted-analysis-v1",
    operationId: state.operationId,
    videoRevision: state.videoRevision,
    analysisRevision,
    finalizedVideoRef: video.immutableRef,
    canonicalVideoSha256: hash.canonicalSha256,
    byteLength: hash.byteLength,
    mediaType: video.contentType,
    probe,
    audio: {
      intent: "original_audio",
      soundtrack:
        identified.verification === null
          ? {
              extractedAudioRef: soundtrack.artifactRef,
              extractedAudioSha256: soundtrack.canonicalSha256,
              verification: null,
              exhaustion: identified.exhaustion,
              evidenceRef: identified.evidenceRef,
              policyRevision: soundtrack.policyRevision,
            }
          : {
              extractedAudioRef: soundtrack.artifactRef,
              extractedAudioSha256: soundtrack.canonicalSha256,
              verification: identified.verification,
              policyRevision: soundtrack.policyRevision,
            },
    },
    frames: {
      posterPolicyRevision: VIDEO_POSTER_POLICY_V1.policyRevision,
      evidenceRef: extracted.evidenceRef,
      adapterRevision: extracted.adapterRevision,
      extracted: extracted.frames,
    },
    safetyRequest: {
      requestId: safety.requestId,
      frameSha256s: extracted.frames.map(({ sha256 }) => sha256),
      captionSha256,
      evidenceRef: safety.evidenceRef,
      minorSafetyEvidenceRef: safety.minorSafetyEvidenceRef,
    },
    mediaSafety: safety.mediaSafety,
    captionSafety: safety.captionSafety,
    automatedRating: safety.automatedRating,
    safetyPolicyRevision: safety.policyRevision,
    adapterRevisions: {
      probe: probeAdapterRevision,
      acr: identified.adapterRevision,
      frames: extracted.adapterRevision,
      safety: safety.adapterRevision,
    },
  };
  return acceptTrustedVideoAnalysis({ submissionId: state.submissionId, analysis }, services);
}
