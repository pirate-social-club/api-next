/** Pure Spec 013 phase-one original-audio video policy and state. */

export const VIDEO_INGEST_POLICY_V1 = Object.freeze({
  version: "video-ingest-policy-v1" as const,
  policyRevision: 1,
  containers: ["video/mp4", "video/quicktime"] as const,
  videoCodecs: ["h264"] as const,
  audioCodecs: ["aac"] as const,
  audioRequired: true as const,
  minDurationMs: 3_000,
  maxDurationMs: 180_000,
  maxOverSongMs: 3_000,
  maxBytes: 500 * 1024 * 1024,
  maxLongEdgePx: 1_920,
  maxFrameRateMillihertz: 60_000,
});

export const VIDEO_POSTER_POLICY_V1 = Object.freeze({
  version: "video-poster-policy-v1" as const,
  policyRevision: 1,
  roles: ["poster", "first", "midpoint"] as const,
  defaultPosterTimestampMs: 1_000,
  maxEdgePx: 1_024,
  maxBytesPerFrame: 512 * 1024,
  imageType: "image/jpeg" as const,
});

export const VIDEO_DERIVED_ARTIFACT_RETENTION_POLICY_V1 = Object.freeze({
  version: "video-derived-artifact-retention-policy-v1" as const,
  policyRevision: 1,
  publishedOriginalSound: "retained_source_video_lifecycle" as const,
  unpublishedTerminal: "follow_source_disposition" as const,
  extractedAudioMayOutliveSource: false as const,
});

export type ContentRating = "general" | "adult_18";
export type OriginalAudioVerification =
  | Readonly<{
      status: "no_match" | "inconclusive";
      evidenceRef: string;
      adapterRevision: string;
    }>
  | Readonly<{
      status: "known_self_owned_recording";
      identifiedAssetId: string;
      ownerEvidenceRef: string;
      evidenceRef: string;
      adapterRevision: string;
    }>
  | Readonly<{
      status: "known_recording";
      identified:
        | Readonly<{
            kind: "pirate_song";
            assetId: string;
            referenceableSongPostId: string | null;
            ownerRelation: "same_account" | "different_account" | "indeterminate";
          }>
        | Readonly<{ kind: "external"; providerRef: string }>;
      evidenceRef: string;
      adapterRevision: string;
    }>;

export type VideoFrameRole = "poster" | "first" | "midpoint";
export type VideoExtractedFrame = Readonly<{
  role: VideoFrameRole;
  requestedTimestampMs: number | null;
  timestampMs: number;
  sha256: string;
  artifactRef: string;
}>;

export type VideoTrustedAnalysis = Readonly<{
  version: "video-trusted-analysis-v1";
  operationId: string;
  videoRevision: number;
  analysisRevision: number;
  finalizedVideoRef: string;
  canonicalVideoSha256: string;
  byteLength: number;
  mediaType: "video/mp4" | "video/quicktime";
  probe: Readonly<{
    evidenceRef: string;
    ingestPolicyRevision: number;
    durationMs: number;
    width: number;
    height: number;
    frameRateMillihertz: number;
    videoCodec: "h264" | "hevc";
    audioCodec: "aac";
    hasAudio: true;
  }>;
  audio: Readonly<{
    intent: "original_audio";
    soundtrack:
      | Readonly<{
          extractedAudioRef: string;
          extractedAudioSha256: string;
          verification: OriginalAudioVerification;
          policyRevision: string;
        }>
      | Readonly<{
          extractedAudioRef: string;
          extractedAudioSha256: string;
          verification: null;
          exhaustion: "acr_exhausted" | "acr_skipped";
          evidenceRef: string;
          policyRevision: string;
        }>;
  }>;
  frames: Readonly<{
    posterPolicyRevision: number;
    evidenceRef: string;
    adapterRevision: string;
    extracted: readonly [VideoExtractedFrame, VideoExtractedFrame, VideoExtractedFrame];
  }>;
  safetyRequest: Readonly<{
    requestId: string;
    frameSha256s: readonly string[];
    captionSha256: string | null;
    evidenceRef: string;
    minorSafetyEvidenceRef: string | null;
  }>;
  mediaSafety: "allow" | "review_required" | "blocked";
  captionSafety: "not_applicable" | "allow" | "review_required" | "blocked";
  automatedRating: ContentRating;
  safetyPolicyRevision: string;
  adapterRevisions: Readonly<{
    probe: string;
    acr: string;
    frames: string;
    safety: string;
  }>;
}>;

export type VideoReviewReason =
  | "media_review_required"
  | "caption_review_required"
  | "safety_adapter_unavailable"
  | "soundtrack_known_recording"
  | "soundtrack_exhausted"
  | "soundtrack_skipped";

export type VideoPublicationDecision = Readonly<{
  version: "video-publication-decision-v1";
  operationId: string;
  creationRevision: number;
  videoRevision: number;
  acceptedAnalysisRevision: number;
  authorization: Readonly<{ intent: "original_audio" }>;
  outcome:
    | Readonly<{ kind: "publish" }>
    | Readonly<{ kind: "review"; reasonCodes: readonly VideoReviewReason[] }>
    | Readonly<{
        kind: "block";
        reasonCode:
          | "known_recording_requires_song_reference"
          | "policy_violation"
          | "rights_violation";
        publicReason: string;
        songPostId?: string;
      }>;
  effectiveContentRating: ContentRating;
  decidedAt: string;
}>;

export type ImmutableVideo = Readonly<{
  videoRevision: number;
  immutableRef: string;
  canonicalSha256: string;
  contentType: "video/mp4" | "video/quicktime";
  sizeBytes: number;
}>;

export type OriginalSoundReference = Readonly<{
  originalSoundId: string;
  originVideoPostId: string;
  originVideoRevision: number;
  extractedAudioRef: string;
  extractedAudioSha256: string;
  extractionPolicyRevision: string;
  retentionPolicyRevision: number;
}>;

export type VideoSubmissionStatus =
  | "processing"
  | "manual_review"
  | "published"
  | "blocked"
  | "processing_failed"
  | "abandoned";
export type VideoSubmissionPhase =
  | "reserve"
  | "awaiting_upload"
  | "finalize"
  | "analysis"
  | "decision"
  | "publish"
  | null;

export type VideoSubmissionState = Readonly<{
  submissionId: string;
  operationId: string;
  communityId: string;
  actorAccountId: string;
  authorPersonaId: string;
  reservationId: string;
  intent: "original_audio";
  caption: string | null;
  authorDeclaredRating: ContentRating;
  creationRevision: number;
  videoRevision: number;
  analysisRevision: number;
  retryCount: number;
  status: VideoSubmissionStatus;
  phase: VideoSubmissionPhase;
  video: ImmutableVideo | null;
  analysis: VideoTrustedAnalysis | null;
  decision: VideoPublicationDecision | null;
  reviewReasons: readonly VideoReviewReason[];
  approvedHolds: readonly ("safety" | "soundtrack")[];
  failureCode:
    | "poster_undecodable"
    | "poster_timestamp_out_of_range"
    | "probe_failed"
    | "hash_failed"
    | "transform_failed"
    | "publication_failed"
    | "upload_seal_conflict"
    | null;
  postId: string | null;
}>;

const SHA256 = /^[0-9a-f]{64}$/u;
const present = (value: string): boolean => value.length > 0 && value.trim() === value;
const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export function validateVideoTrustedAnalysis(
  state: Pick<
    VideoSubmissionState,
    "operationId" | "videoRevision" | "video" | "caption" | "analysisRevision"
  >,
  analysis: VideoTrustedAnalysis,
  canonicalCaptionSha256: string | null,
): string | null {
  const video = state.video;
  if (
    analysis.version !== "video-trusted-analysis-v1" ||
    video === null ||
    analysis.operationId !== state.operationId ||
    analysis.videoRevision !== state.videoRevision ||
    analysis.analysisRevision !== state.analysisRevision + 1 ||
    analysis.finalizedVideoRef !== video.immutableRef ||
    analysis.canonicalVideoSha256 !== video.canonicalSha256 ||
    analysis.byteLength !== video.sizeBytes ||
    analysis.mediaType !== video.contentType
  )
    return "lineage";
  const probe = analysis.probe;
  if (
    probe.ingestPolicyRevision !== VIDEO_INGEST_POLICY_V1.policyRevision ||
    !present(probe.evidenceRef) ||
    probe.durationMs < VIDEO_INGEST_POLICY_V1.minDurationMs ||
    probe.durationMs > VIDEO_INGEST_POLICY_V1.maxDurationMs ||
    !positiveInteger(probe.width) ||
    !positiveInteger(probe.height) ||
    Math.max(probe.width, probe.height) > VIDEO_INGEST_POLICY_V1.maxLongEdgePx ||
    !positiveInteger(probe.frameRateMillihertz) ||
    probe.frameRateMillihertz > VIDEO_INGEST_POLICY_V1.maxFrameRateMillihertz ||
    probe.videoCodec !== "h264" ||
    probe.audioCodec !== "aac" ||
    probe.hasAudio !== true
  )
    return "probe";
  const soundtrack = analysis.audio.soundtrack;
  if (
    analysis.audio.intent !== "original_audio" ||
    !present(soundtrack.extractedAudioRef) ||
    !SHA256.test(soundtrack.extractedAudioSha256) ||
    !present(soundtrack.policyRevision)
  )
    return "soundtrack";
  const frames = analysis.frames.extracted;
  const roles: readonly VideoFrameRole[] = ["poster", "first", "midpoint"];
  if (
    analysis.frames.posterPolicyRevision !== VIDEO_POSTER_POLICY_V1.policyRevision ||
    frames.length !== roles.length ||
    frames.some(
      (frame, index) =>
        frame.role !== roles[index] ||
        !Number.isSafeInteger(frame.timestampMs) ||
        frame.timestampMs < 0 ||
        frame.timestampMs >= probe.durationMs ||
        !SHA256.test(frame.sha256) ||
        !present(frame.artifactRef),
    )
  )
    return "frames";
  if (
    analysis.safetyRequest.frameSha256s.length !== roles.length ||
    analysis.safetyRequest.frameSha256s.some((hash, index) => hash !== frames[index]?.sha256) ||
    analysis.safetyRequest.captionSha256 !== canonicalCaptionSha256 ||
    (state.caption === null && analysis.captionSafety !== "not_applicable") ||
    (state.caption !== null && analysis.captionSafety === "not_applicable")
  )
    return "safety_binding";
  return null;
}

const ratingMax = (left: ContentRating, right: ContentRating): ContentRating =>
  left === "adult_18" || right === "adult_18" ? "adult_18" : "general";

export function decideOriginalAudioVideo(
  input: Readonly<{
    state: VideoSubmissionState;
    analysis: VideoTrustedAnalysis;
    canonicalCaptionSha256: string | null;
    decidedAt: string;
  }>,
): VideoPublicationDecision {
  const invalid = validateVideoTrustedAnalysis(
    input.state,
    input.analysis,
    input.canonicalCaptionSha256,
  );
  if (invalid !== null) throw new Error(`invalid video analysis: ${invalid}`);
  const common = {
    version: "video-publication-decision-v1" as const,
    operationId: input.state.operationId,
    creationRevision: input.state.creationRevision,
    videoRevision: input.state.videoRevision,
    acceptedAnalysisRevision: input.analysis.analysisRevision,
    authorization: { intent: "original_audio" as const },
    effectiveContentRating: ratingMax(
      input.state.authorDeclaredRating,
      input.analysis.automatedRating,
    ),
    decidedAt: input.decidedAt,
  };
  if (input.analysis.mediaSafety === "blocked" || input.analysis.captionSafety === "blocked") {
    return {
      ...common,
      outcome: { kind: "block", reasonCode: "policy_violation", publicReason: "policy_violation" },
    };
  }
  const soundtrack = input.analysis.audio.soundtrack;
  if (soundtrack.verification?.status === "known_recording") {
    const identified = soundtrack.verification.identified;
    if (identified.kind === "pirate_song" && identified.referenceableSongPostId !== null) {
      return {
        ...common,
        outcome: {
          kind: "block",
          reasonCode: "known_recording_requires_song_reference",
          publicReason: "known_recording_requires_song_reference",
          songPostId: identified.referenceableSongPostId,
        },
      };
    }
  }
  const reasons = new Set<VideoReviewReason>();
  if (input.analysis.mediaSafety === "review_required") reasons.add("media_review_required");
  if (input.analysis.captionSafety === "review_required") reasons.add("caption_review_required");
  if (soundtrack.verification === null) {
    reasons.add(
      soundtrack.exhaustion === "acr_exhausted" ? "soundtrack_exhausted" : "soundtrack_skipped",
    );
  } else if (soundtrack.verification.status === "known_recording") {
    reasons.add("soundtrack_known_recording");
  }
  return reasons.size === 0
    ? { ...common, outcome: { kind: "publish" } }
    : { ...common, outcome: { kind: "review", reasonCodes: [...reasons] } };
}

export function createOriginalVideoSubmission(
  input: Readonly<{
    submissionId: string;
    operationId: string;
    communityId: string;
    actorAccountId: string;
    authorPersonaId: string;
    reservationId: string;
    caption: string | null;
    authorDeclaredRating: ContentRating;
  }>,
): VideoSubmissionState {
  return {
    ...input,
    intent: "original_audio",
    creationRevision: 1,
    videoRevision: 0,
    analysisRevision: 0,
    retryCount: 0,
    status: "processing",
    phase: "awaiting_upload",
    video: null,
    analysis: null,
    decision: null,
    reviewReasons: [],
    approvedHolds: [],
    failureCode: null,
    postId: null,
  };
}

export function attachImmutableVideo(
  state: VideoSubmissionState,
  video: ImmutableVideo,
): VideoSubmissionState {
  if (
    state.status !== "processing" ||
    !["awaiting_upload", "finalize"].includes(state.phase ?? "") ||
    state.video !== null ||
    video.videoRevision !== 1 ||
    !SHA256.test(video.canonicalSha256) ||
    video.sizeBytes > VIDEO_INGEST_POLICY_V1.maxBytes
  )
    throw new Error("video finalization is not allowed");
  return { ...state, videoRevision: 1, video, phase: "analysis" };
}

export function attachVideoDecision(
  state: VideoSubmissionState,
  analysis: VideoTrustedAnalysis,
  decision: VideoPublicationDecision,
): VideoSubmissionState {
  if (
    state.status !== "processing" ||
    state.phase !== "analysis" ||
    decision.operationId !== state.operationId ||
    decision.videoRevision !== state.videoRevision ||
    decision.acceptedAnalysisRevision !== analysis.analysisRevision
  )
    throw new Error("video decision is not allowed");
  if (decision.outcome.kind === "publish") {
    return {
      ...state,
      analysisRevision: analysis.analysisRevision,
      analysis,
      decision,
      phase: "publish",
    };
  }
  if (decision.outcome.kind === "review") {
    return {
      ...state,
      analysisRevision: analysis.analysisRevision,
      analysis,
      decision,
      status: "manual_review",
      phase: null,
      reviewReasons: decision.outcome.reasonCodes,
    };
  }
  return {
    ...state,
    analysisRevision: analysis.analysisRevision,
    analysis,
    decision,
    status: "blocked",
    phase: null,
  };
}

export function publishOriginalVideo(
  state: VideoSubmissionState,
  postId: string,
): Readonly<{ state: VideoSubmissionState; originalSound: OriginalSoundReference }> {
  const soundtrack = state.analysis?.audio.soundtrack;
  if (
    state.status !== "processing" ||
    state.phase !== "publish" ||
    state.decision?.outcome.kind !== "publish" ||
    state.video === null ||
    soundtrack === undefined ||
    !present(postId)
  )
    throw new Error("video publication is not allowed");
  return {
    state: { ...state, status: "published", phase: null, postId },
    originalSound: {
      originalSoundId: `original-sound-${state.operationId}`,
      originVideoPostId: postId,
      originVideoRevision: state.videoRevision,
      extractedAudioRef: soundtrack.extractedAudioRef,
      extractedAudioSha256: soundtrack.extractedAudioSha256,
      extractionPolicyRevision: soundtrack.policyRevision,
      retentionPolicyRevision: VIDEO_DERIVED_ARTIFACT_RETENTION_POLICY_V1.policyRevision,
    },
  };
}
