import { Context, Data, type Effect } from "effect";

/**
 * The DATA pinning boundary deliberately knows about bytes, not storage
 * locations. In particular, callers cannot smuggle an R2 URL, reservation,
 * gateway, or provider path through this port.
 */
export const IPFS_PINNING_PORT_VERSION = "ipfs-pinning-v1" as const;

export const IPFS_PINNING_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const IPFS_PINNING_MAX_TIMEOUT_MS = 120_000;
export const IPFS_PINNING_MAX_CONVERGENCE_ATTEMPTS = 8;
export const IPFS_PINNING_MAX_CONVERGENCE_DELAY_MS = 5_000;
export const IPFS_PINNING_MAX_IDENTIFIER_BYTES = 128;
export const IPFS_PINNING_MAX_FILENAME_BYTES = 128;
export const IPFS_PINNING_MAX_CONTENT_TYPE_BYTES = 128;
export const IPFS_PINNING_MAX_SECRET_BYTES = 4_096;

/** A one-shot source. The adapter opens it exactly once for one pin attempt. */
export type IpfsPinningByteSource = Readonly<{
  readonly byte_length: number;
  readonly open: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type IpfsPinningInput = Readonly<{
  readonly version: typeof IPFS_PINNING_PORT_VERSION;
  readonly request_id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly source: IpfsPinningByteSource;
  readonly expected_byte_length: number;
  /** Lowercase hexadecimal SHA-256 of the raw file bytes. */
  readonly expected_sha256: string;
  readonly signal?: AbortSignal;
}>;

export type IpfsPinningLimits = Readonly<{
  readonly max_source_bytes: number;
  readonly max_response_bytes: number;
  readonly timeout_ms: number;
  readonly pin_convergence_attempts: number;
  readonly pin_convergence_delay_ms: number;
}>;

export type IpfsPinningInvalidReason =
  | "invalid_version"
  | "invalid_request_id"
  | "invalid_filename"
  | "invalid_content_type"
  | "invalid_source"
  | "invalid_expected_length"
  | "invalid_expected_sha256"
  | "invalid_signal"
  | "invalid_limits"
  | "invalid_credentials"
  | "invalid_transport";

export class IpfsPinningRequestInvalid extends Data.TaggedError("IpfsPinningRequestInvalid")<{
  readonly reason: IpfsPinningInvalidReason;
}> {}

export type IpfsPinningResult =
  | Readonly<{
      readonly status: "pinned";
      readonly outcome: "pinned";
      readonly cid: string;
      readonly byte_length: number;
      readonly sha256: string;
      readonly recursive: true;
    }>
  | Readonly<{
      readonly status: "disabled";
      readonly outcome: "disabled";
    }>
  | Readonly<{
      readonly status: "cancelled";
      readonly outcome: "cancelled";
    }>
  | Readonly<{
      readonly status: "timeout";
      readonly outcome: "retryable";
      readonly reason: "timeout";
    }>
  | Readonly<{
      readonly status: "retryable";
      readonly outcome: "retryable";
      readonly reason: "transport" | "provider_unavailable" | "throttled" | "pin_not_converged";
    }>
  | Readonly<{
      readonly status: "permanent";
      readonly outcome: "permanent";
      readonly reason: "unauthorized" | "provider_rejected" | "unsupported" | "configuration";
    }>
  | Readonly<{
      readonly status: "malformed";
      readonly outcome: "malformed";
      readonly reason:
        | "wrong_content_type"
        | "malformed_response"
        | "invalid_cid"
        | "oversized_response";
    }>
  | Readonly<{
      readonly status: "integrity_mismatch";
      readonly outcome: "integrity_mismatch";
      readonly reason: "cid" | "length" | "sha256";
    }>
  | Readonly<{
      readonly status: "not_found";
      readonly outcome: "not_found";
    }>;

export interface IpfsPinningAdapter {
  readonly pin: (
    input: IpfsPinningInput,
  ) => Effect.Effect<IpfsPinningResult, IpfsPinningRequestInvalid>;
}

/** Provider-neutral application port. Filebase is only one later driver. */
export class IpfsPinning extends Context.Service<IpfsPinning, IpfsPinningAdapter>()(
  "@pirate/application/data/IpfsPinning",
) {}

export type IpfsPinningService = IpfsPinningAdapter;
