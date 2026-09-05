import type {
  OriginalAudioVerification,
  VideoExtractedFrame,
} from "../../../domain/src/video-submission.ts";
import { mediaSha256Bytes } from "../media/submission-service.ts";
import type {
  MediaTransformAttempt,
  MediaTransformVideoBinding,
  MediaTransformVideoCapabilities,
} from "../media/transform.ts";
import type { VideoPublicationCommitServices } from "./publication.ts";

export type VideoAnalysisSource = Readonly<{
  operationId: string;
  videoRevision: number;
  immutableRef: string;
  canonicalSha256: string;
  byteLength: number;
  mediaType: "video/mp4" | "video/quicktime";
}>;

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

export type VideoAnalysisRuntimeServices = VideoPublicationCommitServices &
  Readonly<{
    analysisProviders: VideoAnalysisProviders;
    transform: MediaTransformVideoCapabilities;
    transformAttempts: VideoTransformAttemptStore;
  }>;

const encoder = new TextEncoder();

export async function videoTransformBinding(
  source: VideoAnalysisSource,
  analysisRevision: number,
  creationRevision: number,
  capability: "probe" | "audio" | "frames",
): Promise<MediaTransformVideoBinding> {
  const digest = await mediaSha256Bytes(
    encoder.encode(
      [
        source.operationId,
        source.videoRevision,
        creationRevision,
        analysisRevision,
        source.canonicalSha256,
        capability,
      ].join("\n"),
    ),
  );
  return {
    operationId: source.operationId,
    videoRevision: source.videoRevision,
    creationRevision,
    analysisRevision,
    canonicalVideoSha256: source.canonicalSha256,
    requestId: `video-${capability}-${digest.slice(0, 32)}`,
  };
}

export async function canonicalVideoCaptionSha256(caption: string | null): Promise<string | null> {
  if (caption === null) return null;
  return mediaSha256Bytes(
    encoder.encode(caption.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim()),
  );
}
