import type { Effect } from "effect";

export const ELEVENLABS_ASR_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text" as const;
export const ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES = 64 * 1_024 * 1_024;
export const ELEVENLABS_ASR_HARD_MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;
/**
 * A 60-minute transcript at an intentionally generous 400 words/minute is
 * fewer than 48,000 alternating word/spacing entries. The byte ceiling remains
 * the first hostile-response bound; this cap limits decoded collection work.
 */
export const ELEVENLABS_ASR_HARD_MAX_PROVIDER_ENTRIES = 50_000;
export const ELEVENLABS_ASR_HARD_MAX_TIMEOUT_MS = 120_000;
export const ELEVENLABS_ASR_HARD_MAX_API_KEY_BYTES = 4_096;
export const ELEVENLABS_ASR_HARD_MAX_MODEL_BYTES = 256;
export const ELEVENLABS_ASR_HARD_MAX_MULTIPART_BYTES = ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES + 16_384;

export type ElevenLabsAsrLimits = Readonly<{
  readonly max_audio_bytes: number;
  readonly max_response_bytes: number;
  readonly timeout_ms: number;
}>;

export type ElevenLabsAsrAudioSource = Readonly<{
  readonly byteLength: number;
  readonly mime_type: string;
  readonly filename?: string;
  readonly open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type ElevenLabsAsrAudioResolver = (
  audioArtifactRef: string,
  signal: AbortSignal,
) =>
  | ElevenLabsAsrAudioSource
  | PromiseLike<ElevenLabsAsrAudioSource>
  | Effect.Effect<ElevenLabsAsrAudioSource, unknown>;

export type ElevenLabsAsrRequestBody = Readonly<{
  readonly byteLength: number;
  readonly contentType: string;
  readonly open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type ElevenLabsAsrTransportRequest = Readonly<{
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ElevenLabsAsrRequestBody;
  readonly signal: AbortSignal;
  readonly redirect: "error";
}>;

export type ElevenLabsAsrResponseBody = Readonly<{
  readonly open: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
  readonly cancel: (reason?: unknown) => void | PromiseLike<void>;
}>;

export type ElevenLabsAsrTransportResponse = Readonly<{
  readonly status: number;
  readonly headers: Headers | Readonly<Record<string, string>>;
  readonly body: ElevenLabsAsrResponseBody;
}>;

export type ElevenLabsAsrTransportResult =
  | ElevenLabsAsrTransportResponse
  | PromiseLike<ElevenLabsAsrTransportResponse>
  | Effect.Effect<ElevenLabsAsrTransportResponse, unknown>;

export type ElevenLabsAsrTransport = (
  request: ElevenLabsAsrTransportRequest,
) => ElevenLabsAsrTransportResult;

export type ElevenLabsAsrAttemptEvidence = Readonly<{
  readonly version: "elevenlabs-asr-attempt-evidence-v1";
  readonly provider: "elevenlabs";
  readonly endpoint: typeof ELEVENLABS_ASR_ENDPOINT;
  readonly attempt_id: string;
  readonly requested_model: string;
  readonly model_revision: string;
  readonly adapter_revision: string;
  readonly retention: "provider_logging" | "zero_retention";
  readonly outcome:
    | "transcript"
    | "no_speech"
    | "timeout"
    | "rate_limited"
    | "provider_unavailable"
    | "cancelled"
    | "malformed_response"
    | "permanent_rejection"
    | "unparseable_result"
    | "out_of_policy"
    | "ambiguous_result"
    | "exhausted";
  readonly provider_status?: number;
}>;

export type ElevenLabsAsrEvidenceReceipt = Readonly<{
  readonly version: "elevenlabs-asr-evidence-receipt-v1";
  readonly evidence: ElevenLabsAsrAttemptEvidence;
}>;

/**
 * A prepared candidate is non-authoritative and may be durably staged. `settle` performs an
 * awaited, attempt-scoped compare-and-set and returns the one committed
 * outcome. All handles for an attempt must observe the same committed receipt.
 * Its Effect may fail only after proving that it did not commit; interruption
 * completes only after its transaction is rolled back or a committed receipt
 * is discoverable by the next settlement. `discard` likewise completes only
 * after its transaction and other asynchronous work have quiesced.
 */
export type ElevenLabsAsrPreparedEvidence = Readonly<{
  readonly version: "elevenlabs-asr-prepared-evidence-v1";
  readonly evidence: ElevenLabsAsrAttemptEvidence;
  readonly settle: (
    desired: ElevenLabsAsrAttemptEvidence,
  ) => Effect.Effect<ElevenLabsAsrEvidenceReceipt, unknown>;
  readonly discard: () => Effect.Effect<void, unknown>;
}>;

/**
 * Preparing may durably stage evidence, but must not publish it. Interrupted
 * preparation completes only after rollback or cleanup, so a handle that was
 * never returned cannot later publish. Implementations must use an async
 * Effect cleanup/finalizer when durable I/O cancellation itself must be awaited.
 */
export type ElevenLabsAsrEvidenceSink = Readonly<{
  readonly prepare: (
    evidence: ElevenLabsAsrAttemptEvidence,
  ) => Effect.Effect<ElevenLabsAsrPreparedEvidence, unknown>;
}>;

export type ElevenLabsAsrRandomBytes = (length: number) => Uint8Array;

type DisabledOptions = Readonly<{
  readonly enabled?: false;
}>;

/** Production-owned decisions are all mandatory when a caller explicitly enables the adapter. */
export type EnabledElevenLabsAsrOptions = Readonly<{
  readonly enabled: true;
  readonly api_key: string;
  readonly model: string;
  readonly model_revision: string;
  readonly adapter_revision: string;
  readonly enable_logging: boolean;
  readonly limits: ElevenLabsAsrLimits;
  readonly resolve_audio: ElevenLabsAsrAudioResolver;
  readonly transport: ElevenLabsAsrTransport;
  readonly evidence_sink: ElevenLabsAsrEvidenceSink;
  readonly random_bytes?: ElevenLabsAsrRandomBytes;
}>;

export type ElevenLabsAsrOptions = DisabledOptions | EnabledElevenLabsAsrOptions;
