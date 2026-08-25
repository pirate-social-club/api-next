import type { Effect } from "effect";

export const ELEVENLABS_ASR_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text" as const;
export const ELEVENLABS_ASR_HARD_MAX_AUDIO_BYTES = 64 * 1_024 * 1_024;
export const ELEVENLABS_ASR_HARD_MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;
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

export type ElevenLabsAsrEvidenceSink = (
  evidence: ElevenLabsAsrAttemptEvidence,
) => void | PromiseLike<void> | Effect.Effect<void, unknown>;

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
  readonly evidence_sink?: ElevenLabsAsrEvidenceSink;
  readonly random_bytes?: ElevenLabsAsrRandomBytes;
}>;

export type ElevenLabsAsrOptions = DisabledOptions | EnabledElevenLabsAsrOptions;
