import { Effect } from "effect";
import type { IpfsPinningInput, IpfsPinningResult, IpfsPinningService } from "./ipfs-pinning";

export const IPFS_GATEWAY_VERIFICATION_VERSION = "ipfs-gateway-verification-v1" as const;

/** The single retrieval provider for registration: the Filebase dedicated
 * gateway. This is integrity verification within one provider, not independent
 * replication, and it must never be persisted as an independent provider. */
export const FILEBASE_GATEWAY_PROVIDER_ID = "filebase-gateway" as const;

export type IpfsGatewayVerificationInput = Readonly<{
  version: typeof IPFS_GATEWAY_VERIFICATION_VERSION;
  request_id: string;
  cid: string;
  expected_byte_length: number;
  expected_sha256: string;
  signal?: AbortSignal;
}>;

export type IpfsGatewayVerificationResult =
  | Readonly<{
      status: "verified";
      cid: string;
      byte_length: number;
      sha256: string;
      provider_id: typeof FILEBASE_GATEWAY_PROVIDER_ID;
    }>
  | Readonly<{
      status: "retryable";
      reason: "timeout" | "cancelled" | "transport" | "unavailable" | "not_found";
      http_status?: number;
    }>
  | Readonly<{
      status: "rejected";
      reason:
        | "invalid_input"
        | "redirect"
        | "unauthorized"
        | "provider"
        | "oversized"
        | "cid"
        | "length"
        | "sha256";
      http_status?: number;
    }>;

export interface IpfsGatewayVerifier {
  readonly verify: (
    input: IpfsGatewayVerificationInput,
  ) => Effect.Effect<IpfsGatewayVerificationResult>;
}

export type IpfsLiveVerificationResult =
  | Readonly<{ status: "verified"; pin: Extract<IpfsPinningResult, { status: "pinned" }> }>
  | Readonly<{ status: "pin_failed"; pin: Exclude<IpfsPinningResult, { status: "pinned" }> }>
  | Readonly<{
      status: "gateway_failed";
      pin: Extract<IpfsPinningResult, { status: "pinned" }>;
      gateway: Exclude<IpfsGatewayVerificationResult, { status: "verified" }>;
    }>;

export const pinAndVerifyIpfsArtifact = (
  pinning: IpfsPinningService,
  gateway: IpfsGatewayVerifier,
  input: IpfsPinningInput,
): Effect.Effect<IpfsLiveVerificationResult, unknown> =>
  Effect.gen(function* () {
    const pin = yield* pinning.pin(input);
    if (pin.status !== "pinned") return { status: "pin_failed", pin } as const;
    const verification = yield* gateway.verify({
      version: IPFS_GATEWAY_VERIFICATION_VERSION,
      request_id: input.request_id,
      cid: pin.cid,
      expected_byte_length: input.expected_byte_length,
      expected_sha256: input.expected_sha256,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (verification.status !== "verified") {
      return { status: "gateway_failed", pin, gateway: verification } as const;
    }
    if (
      verification.cid !== pin.cid ||
      verification.byte_length !== pin.byte_length ||
      verification.sha256 !== pin.sha256 ||
      verification.provider_id !== FILEBASE_GATEWAY_PROVIDER_ID
    ) {
      return {
        status: "gateway_failed",
        pin,
        gateway: {
          status: "rejected",
          reason:
            verification.cid !== pin.cid
              ? "cid"
              : verification.byte_length !== pin.byte_length
                ? "length"
                : verification.sha256 !== pin.sha256
                  ? "sha256"
                  : "provider",
        },
      } as const;
    }
    return { status: "verified", pin } as const;
  });
