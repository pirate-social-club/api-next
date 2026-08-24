/** Shared types and memory-safety ceilings for the isolated alignment seam. */

export const ELEVENLABS_ALIGNMENT_ENDPOINT = "https://api.elevenlabs.io/v1/forced-alignment";
export const ELEVENLABS_ALIGNMENT_ADAPTER_REVISION = "elevenlabs-alignment-adapter-v1";
export const ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY =
  "pirate-elevenlabs-alignment-v1-fixed-boundary";

/*
 * These are implementation hard caps only. They are not ElevenLabs limits,
 * product policy, or accepted deployment values. Enabled composition must
 * inject the reviewed request limits below, each of which is bounded by these
 * caps. Keeping both concepts explicit prevents a provider guess becoming a
 * product contract.
 */
export const ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES = 100_000_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES = 4_000_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TIMEOUT_MS = 300_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_RESPONSE_BYTES = 5_000_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TIMINGS = 100_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TIMING_MS = 86_400_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_REQUEST_BYTES =
  ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES +
  ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES +
  8_192;

export type ElevenLabsAlignmentLimits = Readonly<{
  readonly max_audio_bytes: number;
  readonly max_transcript_bytes: number;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
  readonly max_timings: number;
  readonly max_timing_ms: number;
}>;

export type ElevenLabsAlignmentAudioRevision = Readonly<{
  readonly audio_revision: number;
  readonly canonical_audio_sha256: string;
  readonly bytes: Uint8Array;
  readonly mime_type: string;
  readonly filename?: string;
}>;

/** A private transcript selected by PostgreSQL authority. */
export type ElevenLabsAlignmentTranscriptArtifact = Readonly<{
  readonly artifact_ref: string;
  readonly operation_id: string;
  readonly audio_revision: number;
  readonly analysis_revision: number;
  readonly canonical_audio_sha256: string;
  readonly transcript: string;
}>;

export type ElevenLabsAlignmentInput = Readonly<{
  readonly request_id: string;
  readonly operation_id: string;
  readonly post_id: string;
  readonly audio: ElevenLabsAlignmentAudioRevision;
  readonly transcript: ElevenLabsAlignmentTranscriptArtifact;
  readonly signal?: AbortSignal;
}>;

export type ElevenLabsAlignmentTransportRequest = Readonly<{
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}>;

export type ElevenLabsAlignmentTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>> | Headers;
  readonly body: Uint8Array | ArrayBuffer | string;
}>;

export type ElevenLabsAlignmentTransport = (
  request: ElevenLabsAlignmentTransportRequest,
) => Promise<ElevenLabsAlignmentTransportResponse>;

export type ElevenLabsAlignmentContext = Readonly<{
  readonly operation_id: string;
  readonly post_id: string;
  readonly audio_revision: number;
  readonly analysis_revision: number;
  readonly canonical_audio_sha256: string;
  readonly transcript_artifact_ref: string;
  readonly adapter_revision: typeof ELEVENLABS_ALIGNMENT_ADAPTER_REVISION;
}>;

type AlignmentUnavailable = Readonly<{
  readonly status: "unavailable";
  readonly alignment: "unavailable";
  readonly context?: ElevenLabsAlignmentContext;
}>;

export type ElevenLabsAlignmentOutcome =
  | (AlignmentUnavailable & {
      readonly outcome: "disabled";
      readonly reason: "disabled";
    })
  | (AlignmentUnavailable & {
      readonly outcome: "no_speech";
      readonly reason: "no_speech";
      readonly context: ElevenLabsAlignmentContext;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "transcript_mismatch";
      readonly reason: "transcript_mismatch";
      readonly context: ElevenLabsAlignmentContext;
      readonly expected_text_length: number;
      readonly received_text_length: number;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "retryable";
      readonly reason: "rate_limited" | "provider_unavailable" | "transport";
      readonly context?: ElevenLabsAlignmentContext;
      readonly provider_status?: number;
      readonly retry_after_seconds?: number;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "timeout";
      readonly reason: "timeout";
      readonly context?: ElevenLabsAlignmentContext;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "cancelled";
      readonly reason: "cancelled";
      readonly context?: ElevenLabsAlignmentContext;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "permanent";
      readonly reason: "invalid_request" | "provider_rejected" | "configuration";
      readonly context?: ElevenLabsAlignmentContext;
      readonly provider_status?: number;
    })
  | (AlignmentUnavailable & {
      readonly outcome: "malformed";
      readonly reason: "malformed_response" | "invalid_timing" | "oversized_response";
      readonly context: ElevenLabsAlignmentContext;
    })
  | Readonly<{
      readonly status: "ready";
      readonly alignment: "ready";
      readonly outcome: "ready";
      readonly context: ElevenLabsAlignmentContext;
      readonly mode: "word" | "character";
      readonly timings: readonly ElevenLabsAlignmentTiming[];
    }>;

export type ElevenLabsAlignmentTiming = Readonly<{
  /** Position in the caller-owned transcript token stream; text never crosses this boundary. */
  readonly token_index: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly kind: "word" | "character" | "spacing";
}>;

export type ElevenLabsAlignmentValidatedInput = Readonly<{
  readonly input: ElevenLabsAlignmentInput;
  readonly context: ElevenLabsAlignmentContext;
}>;
