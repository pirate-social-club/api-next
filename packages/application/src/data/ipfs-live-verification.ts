import { Effect } from "effect";
import type { IpfsPinningInput, IpfsPinningResult, IpfsPinningService } from "./ipfs-pinning";

export const IPFS_GATEWAY_VERIFICATION_VERSION = "ipfs-gateway-verification-v1" as const;

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
      provider_id: "ipfs.io";
    }>
  | Readonly<{
      status: "retryable";
      reason: "timeout" | "cancelled" | "transport" | "unavailable" | "not_found";
    }>
  | Readonly<{
      status: "rejected";
      reason: "invalid_input" | "redirect" | "oversized" | "cid" | "length" | "sha256";
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
      return { status: "gateway_failed", gateway: verification } as const;
    }
    if (
      verification.cid !== pin.cid ||
      verification.byte_length !== pin.byte_length ||
      verification.sha256 !== pin.sha256 ||
      verification.provider_id !== "ipfs.io"
    ) {
      return {
        status: "gateway_failed",
        gateway: {
          status: "rejected",
          reason:
            verification.cid !== pin.cid
              ? "cid"
              : verification.byte_length !== pin.byte_length
                ? "length"
                : "sha256",
        },
      } as const;
    }
    return { status: "verified", pin } as const;
  });
