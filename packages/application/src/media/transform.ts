import { Context, Data, type Effect } from "effect";

export const MEDIA_TRANSFORM_MAX_AUDIO_DURATION_MS = 60 * 60 * 1_000;
export const MEDIA_TRANSFORM_SAMPLE_TARGET_MS = 12_000;
export const MEDIA_TRANSFORM_SAMPLE_MAX_MS = 15_000;
export const MEDIA_TRANSFORM_SAMPLE_CHANNELS = 1;
export const MEDIA_TRANSFORM_SAMPLE_RATE_HZ = 44_100;

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
  | "invalid_variant";

export class MediaTransformRequestInvalid extends Data.TaggedError("MediaTransformRequestInvalid")<{
  readonly reason: MediaTransformInvalidReason;
}> {}

export interface MediaTransformService {
  readonly probe: (
    input: MediaTransformProbeInput,
  ) => Effect.Effect<MediaTransformProbeOutcome, MediaTransformRequestInvalid>;
  readonly extractAudioSample: (
    input: MediaTransformAudioSampleInput,
  ) => Effect.Effect<MediaTransformAudioSampleOutcome, MediaTransformRequestInvalid>;
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
