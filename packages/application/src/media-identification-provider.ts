import { Context, type Effect } from "effect";

/**
 * The immutable media identity that a provider attempt is fenced to.  The
 * sample is produced by the server's transform stage; callers cannot ask this
 * port to read an R2 object or to choose an extraction window.
 */
export type MediaIdentificationRequest = Readonly<{
  readonly version: "media-identification-request-v1";
  readonly operationId: string;
  readonly audioRevision: number;
  readonly analysisRevision: number;
  readonly canonicalAudioSha256: string;
  readonly requestId: string;
  /** Optional caller cancellation; it never becomes provider evidence. */
  readonly signal?: AbortSignal;
  readonly sample: Readonly<{
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  }>;
}>;

/**
 * Provider identifiers and scores are private evidence.  They are returned
 * to the processor for durable evidence storage, but are not a public posting
 * or rights-clearance result.
 */
export type MediaIdentificationMatchEvidence = Readonly<{
  readonly version: "media-identification-match-evidence-v1";
  readonly provider: "acrcloud";
  readonly matchKind: "music" | "custom";
  readonly providerMatchId: string;
  readonly title: string | null;
  readonly artists: readonly string[];
  readonly score: number | null;
}>;

export type MediaIdentificationRetryableReason =
  | "transport"
  | "provider"
  | "timeout"
  | "cancelled"
  | "throttled";

export type MediaIdentificationPermanentReason =
  | "provider_rejected"
  | "sample_too_large"
  | "unsupported_sample"
  | "unauthorized";

export type MediaIdentificationMalformedReason =
  | "wrong_content_type"
  | "response_too_large"
  | "malformed_json"
  | "unsupported_shape"
  | "duplicate_candidates";

/**
 * Closed provider-neutral outcomes used by the media decision fence.  A
 * retained match is identification evidence only: it never means ownership,
 * licensing, authorship, or publication permission.
 */
export type MediaIdentificationOutcome =
  | Readonly<{
      readonly outcome: "retained_reference_match";
      readonly evidence: MediaIdentificationMatchEvidence;
    }>
  | Readonly<{
      readonly outcome: "no_match";
    }>
  | Readonly<{
      readonly outcome: "inconclusive_fingerprint";
    }>
  | Readonly<{
      readonly outcome: "retryable_failure";
      readonly reason: MediaIdentificationRetryableReason;
    }>
  | Readonly<{
      readonly outcome: "permanent_provider_rejection";
      readonly reason: MediaIdentificationPermanentReason;
    }>
  | Readonly<{
      readonly outcome: "malformed_or_unsupported_response";
      readonly reason: MediaIdentificationMalformedReason;
    }>;

export interface MediaIdentificationProviderService {
  readonly identify: (
    input: MediaIdentificationRequest,
  ) => Effect.Effect<MediaIdentificationOutcome>;
}

/**
 * Application-owned identification port.  Concrete provider modules belong
 * to platform-cf and are injected by a later processor composition.
 */
export class MediaIdentificationProvider extends Context.Service<
  MediaIdentificationProvider,
  MediaIdentificationProviderService
>()("@pirate/application/media-identification-provider") {}

export const identifyMedia = (
  provider: MediaIdentificationProviderService,
  input: MediaIdentificationRequest,
): Effect.Effect<MediaIdentificationOutcome> => provider.identify(input);
