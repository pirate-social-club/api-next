import { NotFound, type VideoPostSubmissionV1 } from "@pirate/contracts";
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
import {
  acceptTrustedVideoAnalysis,
  recordVideoProcessingFailure,
  type VideoPublicationServices,
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

/** Provider ports return only trusted server facts; no client probe value crosses this boundary. */
export type VideoAnalysisProviders = Readonly<{
  probe: (source: VideoAnalysisSource) => Promise<VideoProbeFact>;
  hash: (
    source: VideoAnalysisSource,
  ) => Promise<Readonly<{ canonicalSha256: string; byteLength: number; evidenceRef: string }>>;
  extractSoundtrack: (source: VideoAnalysisSource) => Promise<
    Readonly<{
      artifactRef: string;
      canonicalSha256: string;
      policyRevision: string;
      adapterRevision: string;
    }>
  >;
  identifySoundtrack: (
    input: Readonly<{
      operationId: string;
      extractedAudioRef: string;
      extractedAudioSha256: string;
    }>,
  ) => Promise<VideoSoundtrackFact>;
  extractFrames: (
    input: Readonly<{
      source: VideoAnalysisSource;
      durationMs: number;
      posterTimestampMs: number;
    }>,
  ) => Promise<VideoFrameExtractionResult>;
  moderate: (
    input: Readonly<{
      operationId: string;
      caption: string | null;
      captionSha256: string | null;
      frames: readonly [VideoExtractedFrame, VideoExtractedFrame, VideoExtractedFrame];
    }>,
  ) => Promise<VideoSafetyFact>;
  revisions: Readonly<{ probe: string }>;
}>;

export type VideoAnalysisRuntimeServices = VideoPublicationServices &
  Readonly<{ analysisProviders: VideoAnalysisProviders }>;

const encoder = new TextEncoder();

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
  try {
    probe = await services.analysisProviders.probe(source);
  } catch {
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

  let soundtrack: Awaited<ReturnType<VideoAnalysisProviders["extractSoundtrack"]>>;
  try {
    soundtrack = await services.analysisProviders.extractSoundtrack(source);
  } catch {
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
    extracted = await services.analysisProviders.extractFrames({
      source,
      durationMs: probe.durationMs,
      posterTimestampMs,
    });
  } catch {
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
    analysisRevision: state.analysisRevision + 1,
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
      probe: services.analysisProviders.revisions.probe,
      acr: identified.adapterRevision,
      frames: extracted.adapterRevision,
      safety: safety.adapterRevision,
    },
  };
  return acceptTrustedVideoAnalysis({ submissionId: state.submissionId, analysis }, services);
}
