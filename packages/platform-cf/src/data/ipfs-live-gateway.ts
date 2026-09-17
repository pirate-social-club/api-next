import type {
  IpfsGatewayVerificationInput,
  IpfsGatewayVerificationResult,
  IpfsGatewayVerifier,
} from "@pirate/application/data/ipfs-live-verification";
import { FILEBASE_GATEWAY_PROVIDER_ID } from "@pirate/application/data/ipfs-live-verification";
import { Effect } from "effect";
import { isValidFilebaseCid } from "./filebase-ipfs-pinning";

/**
 * The registration gate retrieves pinned artifacts through the Filebase
 * dedicated gateway. This verifies availability and integrity inside one
 * provider; it is not independent replication and must never be described or
 * persisted as such. The packaged origin is validated at module load so a
 * configuration drift cannot redirect verification to another provider, and
 * there is no fallback origin.
 */
export const FILEBASE_GATEWAY_ORIGIN = "https://highseas.myfilebase.com" as const;
export const FILEBASE_GATEWAY_TIMEOUT_MS = 120_000;
export const FILEBASE_GATEWAY_MAX_BYTES = 64 * 1024 * 1024;
export const FILEBASE_GATEWAY_TOKEN_HEADER = "x-filebase-gateway-token" as const;

const PACKAGED_GATEWAY_ORIGIN = (() => {
  const url = new URL(FILEBASE_GATEWAY_ORIGIN);
  if (url.protocol !== "https:" || url.origin !== FILEBASE_GATEWAY_ORIGIN) {
    throw new Error("invalid Filebase gateway origin");
  }
  return url.origin;
})();

type DigestWritable = WritableStream<ArrayBuffer | ArrayBufferView> & {
  readonly digest: Promise<ArrayBuffer>;
};

type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FilebaseGatewayVerifierOptions = Readonly<{
  fetch?: GatewayFetch;
  timeout_ms?: number;
  max_bytes?: number;
  /** Optional dedicated-gateway token, sent only as the documented header. */
  gateway_token?: string;
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

export const makeFilebaseGatewayVerifier = (
  options: FilebaseGatewayVerifierOptions = {},
): IpfsGatewayVerifier => {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeout_ms ?? FILEBASE_GATEWAY_TIMEOUT_MS;
  const maxBytes = options.max_bytes ?? FILEBASE_GATEWAY_MAX_BYTES;
  const token = options.gateway_token?.trim();

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
            `${PACKAGED_GATEWAY_ORIGIN}/ipfs/${encodeURIComponent(input.cid)}`,
            {
              method: "GET",
              redirect: "manual",
              signal: controller.signal,
              ...(token === undefined || token.length === 0
                ? {}
                : { headers: { [FILEBASE_GATEWAY_TOKEN_HEADER]: token } }),
            },
          );
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel("redirect_rejected");
            return { status: "rejected", reason: "redirect", http_status: response.status };
          }
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel("gateway_unauthorized");
            return { status: "rejected", reason: "unauthorized", http_status: response.status };
          }
          if (response.status === 404) {
            await response.body?.cancel("not_found");
            return { status: "retryable", reason: "not_found", http_status: 404 };
          }
          if (response.status < 200 || response.status >= 300) {
            await response.body?.cancel("gateway_unavailable");
            return { status: "retryable", reason: "unavailable", http_status: response.status };
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
            provider_id: FILEBASE_GATEWAY_PROVIDER_ID,
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
