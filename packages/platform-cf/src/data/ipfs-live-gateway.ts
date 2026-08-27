import type {
  IpfsGatewayVerificationInput,
  IpfsGatewayVerificationResult,
  IpfsGatewayVerifier,
} from "@pirate/application/data/ipfs-live-verification";
import { Effect } from "effect";
import { isValidFilebaseCid } from "./filebase-ipfs-pinning";

export const IPFS_IO_GATEWAY_ORIGIN = "https://ipfs.io" as const;
export const IPFS_IO_GATEWAY_TIMEOUT_MS = 120_000;
export const IPFS_IO_GATEWAY_MAX_BYTES = 64 * 1024 * 1024;

type DigestWritable = WritableStream<ArrayBuffer | ArrayBufferView> & {
  readonly digest: Promise<ArrayBuffer>;
};

type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type IpfsIoGatewayVerifierOptions = Readonly<{
  fetch?: GatewayFetch;
  timeout_ms?: number;
  max_bytes?: number;
}>;

const digestStream = (): DigestWritable => {
  const Constructor = (
    crypto as Crypto & {
      DigestStream: new (algorithm: "SHA-256") => DigestWritable;
    }
  ).DigestStream;
  return new Constructor("SHA-256");
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const validInput = (input: IpfsGatewayVerificationInput, maxBytes: number): boolean =>
  input.version === "ipfs-gateway-verification-v1" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.request_id) &&
  isValidFilebaseCid(input.cid) &&
  Number.isSafeInteger(input.expected_byte_length) &&
  input.expected_byte_length > 0 &&
  input.expected_byte_length <= maxBytes &&
  /^[0-9a-f]{64}$/u.test(input.expected_sha256) &&
  (input.signal === undefined || input.signal instanceof AbortSignal);

export const makeIpfsIoGatewayVerifier = (
  options: IpfsIoGatewayVerifierOptions = {},
): IpfsGatewayVerifier => {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeout_ms ?? IPFS_IO_GATEWAY_TIMEOUT_MS;
  const maxBytes = options.max_bytes ?? IPFS_IO_GATEWAY_MAX_BYTES;

  return {
    verify: (input) =>
      Effect.promise(async (): Promise<IpfsGatewayVerificationResult> => {
        if (!validInput(input, maxBytes)) return { status: "rejected", reason: "invalid_input" };
        const controller = new AbortController();
        const onAbort = () => controller.abort("cancelled");
        input.signal?.addEventListener("abort", onAbort, { once: true });
        const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
        try {
          const response = await transport(
            `${IPFS_IO_GATEWAY_ORIGIN}/ipfs/${encodeURIComponent(input.cid)}`,
            { method: "GET", redirect: "manual", signal: controller.signal },
          );
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel("redirect_rejected");
            return { status: "rejected", reason: "redirect" };
          }
          if (response.status === 404) {
            await response.body?.cancel("not_found");
            return { status: "retryable", reason: "not_found" };
          }
          if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel("gateway_unavailable");
            return { status: "retryable", reason: "unavailable" };
          }
          if (response.body === null) return { status: "retryable", reason: "transport" };

          const digest = digestStream();
          const writer = digest.getWriter();
          const reader = response.body.getReader();
          let byteLength = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              byteLength += part.value.byteLength;
              if (byteLength > maxBytes || byteLength > input.expected_byte_length) {
                await reader.cancel("oversized");
                await writer.abort("oversized");
                void digest.digest.catch(() => undefined);
                return { status: "rejected", reason: "oversized" };
              }
              await writer.write(part.value);
            }
            await writer.close();
          } finally {
            reader.releaseLock();
          }
          if (byteLength !== input.expected_byte_length) {
            return { status: "rejected", reason: "length" };
          }
          const sha256 = hex(await digest.digest);
          if (sha256 !== input.expected_sha256) {
            return { status: "rejected", reason: "sha256" };
          }
          return {
            status: "verified",
            cid: input.cid,
            byte_length: byteLength,
            sha256,
            provider_id: "ipfs.io",
          };
        } catch {
          if (controller.signal.aborted) {
            return {
              status: "retryable",
              reason: controller.signal.reason === "timeout" ? "timeout" : "cancelled",
            };
          }
          return { status: "retryable", reason: "transport" };
        } finally {
          clearTimeout(timeout);
          input.signal?.removeEventListener("abort", onAbort);
        }
      }),
  };
};
