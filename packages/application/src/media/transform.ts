import { Context, Data, type Effect, Schema } from "effect";

export const MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS = 60 * 60 * 1_000;
export const MEDIA_TRANSFORM_SAMPLE_TARGET_MS = 12_000;
export const MEDIA_TRANSFORM_SAMPLE_MAX_MS = 15_000;
export const MEDIA_TRANSFORM_SAMPLE_CHANNELS = 1;
export const MEDIA_TRANSFORM_SAMPLE_RATE_HZ = 44_100;
export const MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1 = "video-audio-adts-copy-v1" as const;

export type MediaTransformSampleVariant = "primary" | "alternate";

export type MediaTransformBinding = Readonly<{
  readonly operationId: string;
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly canonicalAudioSha256: string;
  readonly requestId: string;
}>;

type MediaTransformSource = Readonly<{
  /** Private, server-owned object key. URLs are deliberately unrepresentable. */
  readonly objectKey: string;
}>;

export type MediaTransformRuntimeFence = Readonly<{
  readonly submittedAtMs: number;
  readonly runtimeDeadlineMs: number;
}>;

/**
 * Caller-persisted provider-attempt state, keyed by binding.requestId.
 *
 * The caller creates and durably records the runtime fence before the first
 * provider effect. Exact logical-attempt replay must reuse that fence. The
 * adapter adds providerJobId only after Transloadit returns an assembly id;
 * adapter memory is never a durability mechanism.
 */
export type MediaTransformAttempt = Readonly<{
  readonly version: "media-transform-attempt-v1";
  readonly runtimeFence: MediaTransformRuntimeFence;
  readonly providerJobId?: string;
}>;

export type MediaTransformAcceptedAttempt = Readonly<{
  readonly version: "media-transform-attempt-v1";
  readonly runtimeFence: MediaTransformRuntimeFence;
  readonly providerJobId: string;
}>;

export type MediaTransformProbeInput = Readonly<{
  readonly version: "media-transform-probe-input-v1";
  readonly binding: MediaTransformBinding;
  readonly source: MediaTransformSource;
  readonly attempt: MediaTransformAttempt;
  readonly signal?: AbortSignal;
}>;

export type MediaTransformAudioSampleInput = Readonly<{
  readonly version: "media-transform-audio-sample-input-v1";
  readonly binding: MediaTransformBinding;
  readonly source: MediaTransformSource;
  readonly sourceDurationMs: number;
  readonly variant: MediaTransformSampleVariant;
  readonly attempt: MediaTransformAttempt;
  readonly signal?: AbortSignal;
}>;

export type MediaTransformCancelInput = Readonly<{
  readonly version: "media-transform-cancel-input-v1";
  readonly requestId: string;
  readonly providerJobId: string;
  readonly signal?: AbortSignal;
}>;

export type MediaTransformAttemptContext = Readonly<{
  readonly version: "media-transform-attempt-context-v1";
  readonly operationId: string;
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly canonicalAudioSha256: string;
  readonly requestId: string;
  readonly adapterRevision: string;
}>;

export type MediaTransformAudioTrack = Readonly<{
  readonly kind: "audio";
  readonly codec: "aac" | "flac" | "mp3" | "opus" | "pcm";
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitrateBps: number | null;
  readonly bitrateMode: "constant" | "variable" | "unknown";
}>;

export type MediaTransformProbe = Readonly<{
  readonly version: "media-transform-probe-v1";
  readonly durationMs: number;
  readonly container: "aac" | "flac" | "m4a" | "mp3" | "ogg" | "opus" | "wav" | "webm";
  readonly mimeType: string;
  readonly tracks: readonly [MediaTransformAudioTrack];
}>;

export type MediaTransformSampleArtifact = Readonly<{
  readonly version: "media-transform-sample-artifact-v1";
  readonly objectKey: string;
  readonly contentType: "audio/mpeg" | "audio/wav";
  readonly byteLength: number;
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly variant: MediaTransformSampleVariant;
  /** Integration must HEAD and bind the retained R2 object before ACR consumption. */
  readonly retainedObjectVerification: "required";
}>;

type MediaTransformRetryableReason =
  | "cancelled"
  | "provider"
  | "throttled"
  | "timeout"
  | "transport";

export type MediaTransformRejectedReason =
  | "duration_exceeded"
  | "inconsistent_media_facts"
  | "job_not_found"
  | "no_audio_track"
  | "output_too_large"
  | "poster_timestamp_out_of_range"
  | "poster_undecodable"
  | "provider_rejected"
  | "runtime_exceeded"
  | "unauthorized"
  | "unsupported_codec"
  | "unsupported_container"
  | "video_track_present";

export type MediaTransformMalformedReason =
  | "duplicate_results"
  | "malformed_json"
  | "response_too_large"
  | "unsupported_shape"
  | "wrong_content_type";

type MediaTransformProgress =
  | Readonly<{
      readonly status: "submitted" | "processing";
      readonly attempt: MediaTransformAcceptedAttempt;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: "disabled";
      readonly attempt: MediaTransformAttempt;
    }>
  | Readonly<{
      readonly status: "retryable_failure";
      readonly reason: MediaTransformRetryableReason;
      readonly attempt: MediaTransformAttempt;
      readonly retryAfterMs?: number;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason: MediaTransformRejectedReason;
      readonly attempt: MediaTransformAttempt;
    }>
  | Readonly<{
      readonly status: "malformed_response";
      readonly reason: MediaTransformMalformedReason;
      readonly attempt: MediaTransformAttempt;
    }>;

export type MediaTransformProbeOutcome =
  | Readonly<{
      readonly status: "completed";
      readonly attempt: MediaTransformAcceptedAttempt;
      readonly context: MediaTransformAttemptContext;
      readonly probe: MediaTransformProbe;
    }>
  | (MediaTransformProgress & Readonly<{ readonly context?: MediaTransformAttemptContext }>);

export type MediaTransformAudioSampleOutcome =
  | Readonly<{
      readonly status: "completed";
      readonly attempt: MediaTransformAcceptedAttempt;
      readonly context: MediaTransformAttemptContext;
      readonly artifact: MediaTransformSampleArtifact;
    }>
  | (MediaTransformProgress & Readonly<{ readonly context?: MediaTransformAttemptContext }>);

export type MediaTransformVideoBinding = Readonly<{
  readonly operationId: string;
  readonly videoRevision: number;
  readonly analysisRevision: number;
  readonly canonicalVideoSha256: string;
  readonly requestId: string;
}>;

export type MediaTransformVideoSource = Readonly<{
  /** Private, server-owned object key. URLs are deliberately unrepresentable. */
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: "video/mp4" | "video/quicktime";
}>;

export type MediaTransformVideoAttemptContext = Readonly<{
  readonly version: "media-transform-video-attempt-context-v1";
  readonly operationId: string;
  readonly videoRevision: number;
  readonly analysisRevision: number;
  readonly canonicalVideoSha256: string;
  readonly requestId: string;
  readonly adapterRevision: string;
}>;

export type MediaTransformVideoProbeInput = Readonly<{
  readonly version: "media-transform-video-probe-input-v1";
  readonly binding: MediaTransformVideoBinding;
  readonly source: MediaTransformVideoSource;
  readonly attempt: MediaTransformAttempt;
  readonly signal?: AbortSignal;
}>;

export type MediaTransformVideoAudioInput = Readonly<{
  readonly version: "media-transform-video-audio-input-v1";
  readonly binding: MediaTransformVideoBinding;
  readonly source: MediaTransformVideoSource;
  readonly extractionPolicyVersion: typeof MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1;
  readonly attempt: MediaTransformAttempt;
  readonly signal?: AbortSignal;
}>;

export type MediaTransformVideoFramesInput = Readonly<{
  readonly version: "media-transform-video-frames-input-v1";
  readonly binding: MediaTransformVideoBinding;
  readonly source: MediaTransformVideoSource;
  readonly sourceDurationMs: number;
  readonly posterTimestampMs: number;
  readonly posterPolicy: Readonly<{
    readonly version: "video-poster-policy-v1";
    readonly policyRevision: number;
    readonly roles: readonly ["poster", "first", "midpoint"];
    readonly maxEdgePx: number;
    readonly maxBytesPerFrame: number;
    readonly imageType: "image/jpeg";
  }>;
  readonly attempt: MediaTransformAttempt;
  readonly signal?: AbortSignal;
}>;

export type MediaTransformVideoProbe = Readonly<{
  readonly evidenceRef: string;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRateMillihertz: number;
  readonly videoCodec: "h264" | "hevc";
  readonly audioCodec: "aac";
  readonly hasAudio: true;
}>;

export type MediaTransformVideoAudioArtifact = Readonly<{
  readonly artifactRef: string;
  readonly canonicalSha256: string;
  readonly sourceSha256: string;
  readonly videoRevision: number;
  readonly mediaType: "audio/aac";
  readonly policyRevision: string;
  readonly adapterRevision: string;
}>;

export type MediaTransformVideoFrame = Readonly<{
  readonly role: "poster" | "first" | "midpoint";
  readonly requestedTimestampMs: number | null;
  readonly timestampMs: number;
  readonly sha256: string;
  readonly artifactRef: string;
}>;

type MediaTransformVideoFrames = Readonly<{
  readonly evidenceRef: string;
  readonly adapterRevision: string;
  readonly sourceSha256: string;
  readonly videoRevision: number;
  readonly posterPolicyRevision: number;
  readonly frames: readonly [
    MediaTransformVideoFrame,
    MediaTransformVideoFrame,
    MediaTransformVideoFrame,
  ];
}>;

type MediaTransformVideoProgress = MediaTransformProgress &
  Readonly<{ readonly context?: MediaTransformVideoAttemptContext }>;

export type MediaTransformVideoProbeOutcome =
  | Readonly<{
      readonly status: "completed";
      readonly attempt: MediaTransformAttempt;
      readonly context: MediaTransformVideoAttemptContext;
      readonly probe: MediaTransformVideoProbe;
    }>
  | MediaTransformVideoProgress;

export type MediaTransformVideoAudioOutcome =
  | Readonly<{
      readonly status: "completed";
      readonly attempt: MediaTransformAttempt;
      readonly context: MediaTransformVideoAttemptContext;
      readonly artifact: MediaTransformVideoAudioArtifact;
    }>
  | MediaTransformVideoProgress;

export type MediaTransformVideoFramesOutcome =
  | Readonly<{
      readonly status: "completed";
      readonly attempt: MediaTransformAttempt;
      readonly context: MediaTransformVideoAttemptContext;
      readonly extraction: MediaTransformVideoFrames;
    }>
  | MediaTransformVideoProgress;

export type MediaTransformCancelOutcome =
  | Readonly<{ readonly status: "cancellation_accepted"; readonly providerJobId: string }>
  | Readonly<{ readonly status: "unavailable"; readonly reason: "disabled" }>
  | Readonly<{
      readonly status: "retryable_failure";
      readonly reason: MediaTransformRetryableReason;
      readonly providerJobId: string;
      readonly retryAfterMs?: number;
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason: "job_not_found" | "provider_rejected" | "unauthorized";
      readonly providerJobId: string;
    }>;

export type MediaTransformInvalidReason =
  | "invalid_adapter_revision"
  | "invalid_binding"
  | "invalid_clock"
  | "invalid_credentials"
  | "invalid_input_version"
  | "invalid_job_id"
  | "invalid_limits"
  | "invalid_request_id"
  | "invalid_runtime_fence"
  | "invalid_signal"
  | "invalid_source"
  | "invalid_source_duration"
  | "invalid_template"
  | "invalid_transport"
  | "invalid_variant"
  | "invalid_video_binding"
  | "invalid_video_policy"
  | "invalid_video_source"
  | "invalid_video_timestamp";

export class MediaTransformRequestInvalid extends Data.TaggedError("MediaTransformRequestInvalid")<{
  readonly reason: MediaTransformInvalidReason;
}> {}

const MEDIA_TRANSFORM_DANCE_SEGMENT_MIN_MS = 6_000;
const MEDIA_TRANSFORM_DANCE_SEGMENT_MAX_MS = 30_000;
const MEDIA_TRANSFORM_DANCE_MAX_ATTEMPTS = 3;

const DanceTransformIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
      ? undefined
      : "Expected a bounded canonical identifier",
  ),
);

const DanceTransformObjectKey = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 2_048 &&
    value.trim() === value &&
    !value.includes("\u0000") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
      ? undefined
      : "Expected a private server-owned object reference",
  ),
);

const DanceTransformSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const DanceTransformPositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const DanceTransformNonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const DanceTransformSignedInteger = Schema.Int.check(
  Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const DanceTransformBasisPoints = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 10_000 }),
);
const DanceTransformAttemptNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MEDIA_TRANSFORM_DANCE_MAX_ATTEMPTS }),
);

/**
 * Persisted identity for one bounded Dance transform attempt. The application
 * computes inputDigest before invoking a driver; an adapter cannot choose or
 * default any field in this binding.
 */
export const MediaTransformDanceBinding = Schema.Struct({
  version: Schema.Literal("media-transform-dance-binding-v1"),
  operationId: DanceTransformIdentifier,
  requestId: DanceTransformIdentifier,
  choreographyId: DanceTransformIdentifier,
  choreographyRevision: DanceTransformPositiveInteger,
  attemptNumber: DanceTransformAttemptNumber,
  inputDigest: DanceTransformSha256,
  adapterRevision: DanceTransformIdentifier,
});
export type MediaTransformDanceBinding = Schema.Schema.Type<typeof MediaTransformDanceBinding>;

const MediaTransformCanonicalAudioSource = Schema.Struct({
  objectKey: DanceTransformObjectKey,
  sha256: DanceTransformSha256,
  durationMs: DanceTransformPositiveInteger,
  audioRevision: DanceTransformPositiveInteger,
});

const MediaTransformReferenceVideoSource = Schema.Struct({
  objectKey: DanceTransformObjectKey,
  sha256: DanceTransformSha256,
  durationMs: DanceTransformPositiveInteger,
});

const MediaTransformCanonicalSegmentProfile = Schema.Struct({
  sampleRateHz: Schema.Int.check(Schema.isBetween({ minimum: 8_000, maximum: 192_000 })),
  channels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  codec: Schema.Literals(["flac", "pcm_s16le", "pcm_s24le", "wav"]),
});

export const MediaTransformCanonicalAudioSegmentInput = Schema.Struct({
  version: Schema.Literal("media-transform-canonical-audio-segment-input-v1"),
  binding: MediaTransformDanceBinding,
  canonicalAudio: MediaTransformCanonicalAudioSource,
  startMs: DanceTransformNonNegativeInteger,
  endMs: DanceTransformPositiveInteger,
  extractionPolicyVersion: DanceTransformIdentifier,
  outputProfile: MediaTransformCanonicalSegmentProfile,
}).check(
  Schema.makeFilter(({ canonicalAudio, startMs, endMs }) => {
    const durationMs = endMs - startMs;
    return endMs <= canonicalAudio.durationMs &&
      durationMs >= MEDIA_TRANSFORM_DANCE_SEGMENT_MIN_MS &&
      durationMs <= MEDIA_TRANSFORM_DANCE_SEGMENT_MAX_MS
      ? undefined
      : "Expected a valid half-open Dance segment inside the canonical audio";
  }),
);
export type MediaTransformCanonicalAudioSegmentInput = Schema.Schema.Type<
  typeof MediaTransformCanonicalAudioSegmentInput
>;

const MediaTransformCanonicalAudioSegmentArtifact = Schema.Struct({
  objectKey: DanceTransformObjectKey,
  sha256: DanceTransformSha256,
  sourceSha256: DanceTransformSha256,
  startMs: DanceTransformNonNegativeInteger,
  endMs: DanceTransformPositiveInteger,
  durationMs: DanceTransformPositiveInteger,
  extractionPolicyVersion: DanceTransformIdentifier,
  transformRevision: DanceTransformIdentifier,
  mediaFacts: Schema.Struct({
    durationMs: DanceTransformPositiveInteger,
    sampleRateHz: Schema.Int.check(Schema.isBetween({ minimum: 8_000, maximum: 192_000 })),
    channels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
    sampleCount: DanceTransformPositiveInteger,
    codec: Schema.Literals(["flac", "pcm_s16le", "pcm_s24le", "wav"]),
    tempoPreserved: Schema.Literal(true),
    timelineStretched: Schema.Literal(false),
  }),
  resultDigest: DanceTransformSha256,
});

const MediaTransformDanceRetryableFailure = Schema.Struct({
  status: Schema.Literal("retryable_failure"),
  binding: MediaTransformDanceBinding,
  reason: Schema.Literals(["cancelled", "provider", "throttled", "timeout", "transport"]),
  retryAfterMs: Schema.optional(DanceTransformPositiveInteger),
});

const MediaTransformDanceUnavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.Literal("disabled"),
  binding: MediaTransformDanceBinding,
});

const MediaTransformCanonicalAudioSegmentRejected = Schema.Struct({
  status: Schema.Literal("rejected"),
  binding: MediaTransformDanceBinding,
  reason: Schema.Literals([
    "source_hash_mismatch",
    "invalid_bounds",
    "decode_failed",
    "unsupported_media",
    "output_hash_mismatch",
    "time_stretch_detected",
    "non_deterministic_output",
  ]),
  evidenceRef: DanceTransformObjectKey,
  resultDigest: DanceTransformSha256,
});

export const MediaTransformCanonicalAudioSegmentOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    binding: MediaTransformDanceBinding,
    artifact: MediaTransformCanonicalAudioSegmentArtifact,
  }),
  MediaTransformDanceRetryableFailure,
  MediaTransformDanceUnavailable,
  MediaTransformCanonicalAudioSegmentRejected,
]);
export type MediaTransformCanonicalAudioSegmentOutcome = Schema.Schema.Type<
  typeof MediaTransformCanonicalAudioSegmentOutcome
>;

export const MediaTransformVideoSongAlignmentInput = Schema.Struct({
  version: Schema.Literal("media-transform-video-song-alignment-input-v1"),
  binding: MediaTransformDanceBinding,
  video: MediaTransformReferenceVideoSource,
  songAudio: MediaTransformCanonicalAudioSource,
  requestedStartMs: DanceTransformNonNegativeInteger,
  requestedEndMs: DanceTransformPositiveInteger,
  alignmentPolicyVersion: DanceTransformIdentifier,
  limits: Schema.Struct({
    maximumAbsoluteOffsetMs: DanceTransformNonNegativeInteger,
    maximumAbsoluteDriftMs: DanceTransformNonNegativeInteger,
    maximumAbsoluteSlopeDeltaPpm: DanceTransformNonNegativeInteger,
    minimumOverallConfidenceBps: DanceTransformBasisPoints,
    minimumCoverageBps: DanceTransformBasisPoints,
    minimumSoundtrackMatchBps: DanceTransformBasisPoints,
  }),
}).check(
  Schema.makeFilter(({ songAudio, requestedStartMs, requestedEndMs }) => {
    const durationMs = requestedEndMs - requestedStartMs;
    return requestedEndMs <= songAudio.durationMs &&
      durationMs >= MEDIA_TRANSFORM_DANCE_SEGMENT_MIN_MS &&
      durationMs <= MEDIA_TRANSFORM_DANCE_SEGMENT_MAX_MS
      ? undefined
      : "Expected a valid half-open Dance interval inside the canonical song audio";
  }),
);
export type MediaTransformVideoSongAlignmentInput = Schema.Schema.Type<
  typeof MediaTransformVideoSongAlignmentInput
>;

const MediaTransformVideoSongAlignment = Schema.Struct({
  videoSha256: DanceTransformSha256,
  songAudioSha256: DanceTransformSha256,
  requestedStartMs: DanceTransformNonNegativeInteger,
  requestedEndMs: DanceTransformPositiveInteger,
  referenceVideoScoredStartMs: DanceTransformNonNegativeInteger,
  referenceVideoScoredEndMs: DanceTransformPositiveInteger,
  detectedSongOffsetMs: DanceTransformSignedInteger,
  alignmentPolicyVersion: DanceTransformIdentifier,
  alignmentRevision: DanceTransformIdentifier,
  driftMetrics: Schema.Struct({
    maximumAbsoluteDriftMs: DanceTransformNonNegativeInteger,
    p95AbsoluteDriftMs: DanceTransformNonNegativeInteger,
    slopeDeltaPpm: DanceTransformSignedInteger,
  }),
  confidenceMetrics: Schema.Struct({
    overallBps: DanceTransformBasisPoints,
    coverageBps: DanceTransformBasisPoints,
    soundtrackMatchBps: DanceTransformBasisPoints,
  }),
  continuousMapping: Schema.Literal(true),
  timeStretchDetected: Schema.Literal(false),
  evidenceRef: DanceTransformObjectKey,
  resultDigest: DanceTransformSha256,
});

const MediaTransformVideoSongAlignmentRejected = Schema.Struct({
  status: Schema.Literal("rejected"),
  binding: MediaTransformDanceBinding,
  reason: Schema.Literals([
    "source_hash_mismatch",
    "wrong_song",
    "wrong_offset",
    "missing_soundtrack",
    "excessive_drift",
    "insufficient_confidence",
    "discontinuous_mapping",
    "non_finite_output",
    "time_stretch_detected",
    "decode_failed",
  ]),
  evidenceRef: DanceTransformObjectKey,
  resultDigest: DanceTransformSha256,
});

export const MediaTransformVideoSongAlignmentOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    binding: MediaTransformDanceBinding,
    alignment: MediaTransformVideoSongAlignment,
  }),
  MediaTransformDanceRetryableFailure,
  MediaTransformDanceUnavailable,
  MediaTransformVideoSongAlignmentRejected,
]);
export type MediaTransformVideoSongAlignmentOutcome = Schema.Schema.Type<
  typeof MediaTransformVideoSongAlignmentOutcome
>;

export type MediaTransformDanceResultInvalidReason =
  | "binding_mismatch"
  | "source_mismatch"
  | "interval_mismatch"
  | "policy_mismatch"
  | "timeline_mismatch"
  | "metrics_out_of_policy";

export class MediaTransformDanceResultInvalid extends Data.TaggedError(
  "MediaTransformDanceResultInvalid",
)<{
  readonly capability: "extractCanonicalAudioSegment" | "alignVideoSoundtrackToSong";
  readonly reason: MediaTransformDanceResultInvalidReason;
}> {}

export const decodeMediaTransformCanonicalAudioSegmentInput = (
  input: unknown,
): MediaTransformCanonicalAudioSegmentInput =>
  Schema.decodeUnknownSync(MediaTransformCanonicalAudioSegmentInput, {
    onExcessProperty: "error",
  })(input);

const decodeMediaTransformCanonicalAudioSegmentOutcome = (
  input: unknown,
): MediaTransformCanonicalAudioSegmentOutcome =>
  Schema.decodeUnknownSync(MediaTransformCanonicalAudioSegmentOutcome, {
    onExcessProperty: "error",
  })(input);

export const decodeMediaTransformVideoSongAlignmentInput = (
  input: unknown,
): MediaTransformVideoSongAlignmentInput =>
  Schema.decodeUnknownSync(MediaTransformVideoSongAlignmentInput, {
    onExcessProperty: "error",
  })(input);

const decodeMediaTransformVideoSongAlignmentOutcome = (
  input: unknown,
): MediaTransformVideoSongAlignmentOutcome =>
  Schema.decodeUnknownSync(MediaTransformVideoSongAlignmentOutcome, {
    onExcessProperty: "error",
  })(input);

function sameDanceBinding(
  left: MediaTransformDanceBinding,
  right: MediaTransformDanceBinding,
): boolean {
  return (
    left.version === right.version &&
    left.operationId === right.operationId &&
    left.requestId === right.requestId &&
    left.choreographyId === right.choreographyId &&
    left.choreographyRevision === right.choreographyRevision &&
    left.attemptNumber === right.attemptNumber &&
    left.inputDigest === right.inputDigest &&
    left.adapterRevision === right.adapterRevision
  );
}

function invalidDanceResult(
  capability: "extractCanonicalAudioSegment" | "alignVideoSoundtrackToSong",
  reason: MediaTransformDanceResultInvalidReason,
): never {
  throw new MediaTransformDanceResultInvalid({ capability, reason });
}

/** Strictly decodes and binds a segment result to the exact prepared request. */
export function validateMediaTransformCanonicalAudioSegmentOutcome(
  input: MediaTransformCanonicalAudioSegmentInput,
  result: unknown,
): MediaTransformCanonicalAudioSegmentOutcome {
  const decoded = decodeMediaTransformCanonicalAudioSegmentOutcome(result);
  if (!sameDanceBinding(input.binding, decoded.binding)) {
    return invalidDanceResult("extractCanonicalAudioSegment", "binding_mismatch");
  }
  if (decoded.status !== "completed") return decoded;
  const artifact = decoded.artifact;
  if (artifact.sourceSha256 !== input.canonicalAudio.sha256) {
    return invalidDanceResult("extractCanonicalAudioSegment", "source_mismatch");
  }
  if (
    artifact.startMs !== input.startMs ||
    artifact.endMs !== input.endMs ||
    artifact.durationMs !== input.endMs - input.startMs ||
    artifact.mediaFacts.durationMs !== artifact.durationMs
  ) {
    return invalidDanceResult("extractCanonicalAudioSegment", "interval_mismatch");
  }
  if (artifact.extractionPolicyVersion !== input.extractionPolicyVersion) {
    return invalidDanceResult("extractCanonicalAudioSegment", "policy_mismatch");
  }
  if (
    artifact.mediaFacts.sampleRateHz !== input.outputProfile.sampleRateHz ||
    artifact.mediaFacts.channels !== input.outputProfile.channels ||
    artifact.mediaFacts.codec !== input.outputProfile.codec
  ) {
    return invalidDanceResult("extractCanonicalAudioSegment", "policy_mismatch");
  }
  return decoded;
}

/** Strictly decodes and binds an alignment result to both immutable sources. */
export function validateMediaTransformVideoSongAlignmentOutcome(
  input: MediaTransformVideoSongAlignmentInput,
  result: unknown,
): MediaTransformVideoSongAlignmentOutcome {
  const decoded = decodeMediaTransformVideoSongAlignmentOutcome(result);
  if (!sameDanceBinding(input.binding, decoded.binding)) {
    return invalidDanceResult("alignVideoSoundtrackToSong", "binding_mismatch");
  }
  if (decoded.status !== "completed") return decoded;
  const alignment = decoded.alignment;
  if (
    alignment.videoSha256 !== input.video.sha256 ||
    alignment.songAudioSha256 !== input.songAudio.sha256
  ) {
    return invalidDanceResult("alignVideoSoundtrackToSong", "source_mismatch");
  }
  if (
    alignment.requestedStartMs !== input.requestedStartMs ||
    alignment.requestedEndMs !== input.requestedEndMs
  ) {
    return invalidDanceResult("alignVideoSoundtrackToSong", "interval_mismatch");
  }
  if (alignment.alignmentPolicyVersion !== input.alignmentPolicyVersion) {
    return invalidDanceResult("alignVideoSoundtrackToSong", "policy_mismatch");
  }
  const requestedDurationMs = input.requestedEndMs - input.requestedStartMs;
  if (
    alignment.referenceVideoScoredEndMs - alignment.referenceVideoScoredStartMs !==
      requestedDurationMs ||
    alignment.referenceVideoScoredEndMs > input.video.durationMs ||
    alignment.referenceVideoScoredStartMs - input.requestedStartMs !==
      alignment.detectedSongOffsetMs
  ) {
    return invalidDanceResult("alignVideoSoundtrackToSong", "timeline_mismatch");
  }
  if (
    Math.abs(alignment.detectedSongOffsetMs) > input.limits.maximumAbsoluteOffsetMs ||
    alignment.driftMetrics.maximumAbsoluteDriftMs > input.limits.maximumAbsoluteDriftMs ||
    alignment.driftMetrics.p95AbsoluteDriftMs > alignment.driftMetrics.maximumAbsoluteDriftMs ||
    Math.abs(alignment.driftMetrics.slopeDeltaPpm) > input.limits.maximumAbsoluteSlopeDeltaPpm ||
    alignment.confidenceMetrics.overallBps < input.limits.minimumOverallConfidenceBps ||
    alignment.confidenceMetrics.coverageBps < input.limits.minimumCoverageBps ||
    alignment.confidenceMetrics.soundtrackMatchBps < input.limits.minimumSoundtrackMatchBps
  ) {
    return invalidDanceResult("alignVideoSoundtrackToSong", "metrics_out_of_policy");
  }
  return decoded;
}

export interface MediaTransformDanceReferenceService {
  readonly extractCanonicalAudioSegment: (
    input: MediaTransformCanonicalAudioSegmentInput,
  ) => Effect.Effect<
    MediaTransformCanonicalAudioSegmentOutcome,
    MediaTransformRequestInvalid | MediaTransformDanceResultInvalid
  >;
  readonly alignVideoSoundtrackToSong: (
    input: MediaTransformVideoSongAlignmentInput,
  ) => Effect.Effect<
    MediaTransformVideoSongAlignmentOutcome,
    MediaTransformRequestInvalid | MediaTransformDanceResultInvalid
  >;
}

/** Narrow view of MediaTransform for the video consumer; this is not a second port. */
export interface MediaTransformVideoCapabilities {
  readonly probe: (
    input: MediaTransformVideoProbeInput,
  ) => Effect.Effect<MediaTransformVideoProbeOutcome, MediaTransformRequestInvalid>;
  readonly extractVideoAudio: (
    input: MediaTransformVideoAudioInput,
  ) => Effect.Effect<MediaTransformVideoAudioOutcome, MediaTransformRequestInvalid>;
  readonly extractVideoFrames: (
    input: MediaTransformVideoFramesInput,
  ) => Effect.Effect<MediaTransformVideoFramesOutcome, MediaTransformRequestInvalid>;
}

type MediaTransformProbeCapability = {
  (
    input: MediaTransformProbeInput,
  ): Effect.Effect<MediaTransformProbeOutcome, MediaTransformRequestInvalid>;
  (
    input: MediaTransformVideoProbeInput,
  ): Effect.Effect<MediaTransformVideoProbeOutcome, MediaTransformRequestInvalid>;
};

export interface MediaTransformService extends MediaTransformDanceReferenceService {
  readonly probe: MediaTransformProbeCapability;
  readonly extractAudioSample: (
    input: MediaTransformAudioSampleInput,
  ) => Effect.Effect<MediaTransformAudioSampleOutcome, MediaTransformRequestInvalid>;
  readonly extractVideoAudio: MediaTransformVideoCapabilities["extractVideoAudio"];
  readonly extractVideoFrames: MediaTransformVideoCapabilities["extractVideoFrames"];
  /** Cancels provider execution only; it does not prove provider or retained-object erasure. */
  readonly cancelAssembly: (
    input: MediaTransformCancelInput,
  ) => Effect.Effect<MediaTransformCancelOutcome, MediaTransformRequestInvalid>;
}

/** Application-owned media transform port. Concrete providers stay in platform-cf. */
export class MediaTransform extends Context.Service<MediaTransform, MediaTransformService>()(
  "@pirate/application/media/transform",
) {}

export function mediaTransformSampleWindow(
  durationMs: number,
  variant: MediaTransformSampleVariant,
): Readonly<{ readonly offsetMs: number; readonly durationMs: number }> {
  const sampleDurationMs = Math.min(durationMs, MEDIA_TRANSFORM_SAMPLE_TARGET_MS);
  const availableMs = Math.max(0, durationMs - sampleDurationMs);
  const offsetMs = Math.floor(availableMs * (variant === "primary" ? 0.25 : 0.75));
  return Object.freeze({ offsetMs, durationMs: sampleDurationMs });
}
