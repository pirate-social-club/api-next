/** Shared types and memory-safety ceilings for the isolated alignment seam. */

export const ELEVENLABS_ALIGNMENT_ENDPOINT = "https://api.elevenlabs.io/v1/forced-alignment";
export const ELEVENLABS_ALIGNMENT_ADAPTER_REVISION =
  "elevenlabs-alignment-adapter-v2-provider-quantization";
export const ELEVENLABS_ALIGNMENT_MULTIPART_BOUNDARY_PREFIX = "pirate-elevenlabs-alignment-";
export const ELEVENLABS_ALIGNMENT_BOUNDARY_RANDOM_BYTES = 18;

/*
 * These are implementation hard caps only. They are not ElevenLabs limits,
 * product policy, or accepted deployment values. Enabled composition must
 * inject the reviewed request limits below, each of which is bounded by these
 * caps. The request body is replayable and chunked, so the audio cap does not
 * allocate a second audio copy; the remaining caps keep response, transcript,
 * and framing memory bounded below a Workers isolate's memory ceiling.
 * Keeping both concepts explicit prevents a provider guess becoming a product
 * contract.
 */
export const ELEVENLABS_ALIGNMENT_HARD_MAX_AUDIO_BYTES = 100_000_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TRANSCRIPT_BYTES = 4_000_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TIMEOUT_MS = 300_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_RESPONSE_BYTES = 5_000_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TIMINGS = 100_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_TIMING_MS = 86_400_000;
export const ELEVENLABS_ALIGNMENT_HARD_MAX_API_KEY_BYTES = 4_096;
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

/**
 * One-pass audio owned by the caller. The adapter opens it once per request,
 * passes the cancellation signal through, and never copies the audio.
 */
export type ElevenLabsAlignmentAudioSource = Readonly<{
  readonly byteLength: number;
  readonly open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type ElevenLabsAlignmentRandomBytes = (length: number) => Uint8Array;

export type ElevenLabsAlignmentAudioRevision = Readonly<{
  readonly audio_revision: number;
  readonly canonical_audio_sha256: string;
  readonly source: ElevenLabsAlignmentAudioSource;
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
  readonly body: ElevenLabsAlignmentRequestBody;
  readonly signal: AbortSignal;
}>;

/** Replayable multipart chunks; no complete multipart buffer is retained. */
export type ElevenLabsAlignmentRequestBody = Readonly<{
  readonly byteLength: number;
  readonly contentType: string;
  readonly open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type ElevenLabsAlignmentResponseBody = Readonly<{
  readonly open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
  /** Bounded cancellation/discard of an unused or interrupted provider body. */
  readonly cancel: (reason?: unknown) => void | PromiseLike<void>;
}>;

export type ElevenLabsAlignmentTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>> | Headers;
  readonly body: ElevenLabsAlignmentResponseBody;
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
  readonly text_length: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly kind: "word" | "character" | "spacing";
}>;

export type ElevenLabsAlignmentValidatedInput = Readonly<{
  readonly input: ElevenLabsAlignmentInput;
  readonly context: ElevenLabsAlignmentContext;
}>;
