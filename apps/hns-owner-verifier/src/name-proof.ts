import {
  decodeStrictHnsJsonBytes,
  encodeHnsRootImportNameProofResultV1,
  HNS_PRIVATE_DRIVER_HSD_NAME_PROOF_METHOD,
  HNS_ROOT_IMPORT_NAME_PROOF_MESSAGE_MAX_BYTES,
  HnsRootImportNameSignature,
} from "@pirate/application/namespace-ownership";
import { validCommunityRouteRoot } from "@pirate/domain";
import type { HnsControlObserverHsdPrivateCapability } from "@pirate/platform-cf/namespace-ownership-hns-control-observer-hsd-private-transport";
import { Option, Predicate, Schema } from "effect";

const RESPONSE_MAX_BYTES = 1_024;
const encoder = new TextEncoder();
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const exactParseOptions = { onExcessProperty: "error" } as const;

const HnsNameProofRequest = Schema.Struct({
  root_import_session_id: Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.trim() === value && encoder.encode(value).byteLength <= 256
        ? undefined
        : "Expected a bounded root-import session id",
    ),
  ),
  root_label: Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      validCommunityRouteRoot("hns", value) ? undefined : "Expected a canonical HNS root",
    ),
  ),
  message: Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      encoder.encode(value).byteLength <= HNS_ROOT_IMPORT_NAME_PROOF_MESSAGE_MAX_BYTES
        ? undefined
        : "Expected a bounded HNS name-proof message",
    ),
  ),
  signature: HnsRootImportNameSignature,
});
export type HnsNameProofRequest = Schema.Schema.Type<typeof HnsNameProofRequest>;

export class HnsNameProofRuntimeError extends Error {
  readonly name = "HnsNameProofRuntimeError";

  constructor(readonly reason: "invalid_request" | "unavailable" | "invalid_response") {
    super(reason);
  }
}

export type HnsNameProofRuntime = Readonly<{
  readonly verify: (input: HnsNameProofRequest, signal: AbortSignal) => Promise<Uint8Array>;
}>;

export function decodeHnsNameProofRequest(input: unknown): HnsNameProofRequest | null {
  const decoded = Schema.decodeUnknownOption(HnsNameProofRequest, exactParseOptions)(input);
  return Option.isSome(decoded) ? decoded.value : null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted || response.body === null) {
    throw new HnsNameProofRuntimeError("unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= RESPONSE_MAX_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = RESPONSE_MAX_BYTES + 1 - total;
      chunks.push(part.value.slice(0, remaining));
      total += Math.min(part.value.byteLength, remaining);
      if (part.value.byteLength > remaining || total > RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted || total === 0 || total > RESPONSE_MAX_BYTES) {
    throw new HnsNameProofRuntimeError(signal.aborted ? "unavailable" : "invalid_response");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exactRpcResult(bytes: Uint8Array): boolean {
  const payload =
    bytes[bytes.byteLength - 1] === 0x0a ? bytes.subarray(0, bytes.byteLength - 1) : bytes;
  const decoded = decodeStrictHnsJsonBytes(payload, RESPONSE_MAX_BYTES);
  if (!Predicate.isObject(decoded) || Array.isArray(decoded)) {
    throw new HnsNameProofRuntimeError("invalid_response");
  }
  const keys = Object.keys(decoded);
  if (
    keys.length !== 3 ||
    keys[0] !== "result" ||
    keys[1] !== "error" ||
    keys[2] !== "id" ||
    decoded.id !== null ||
    decoded.error !== null ||
    typeof decoded.result !== "boolean"
  ) {
    throw new HnsNameProofRuntimeError("invalid_response");
  }
  return decoded.result;
}

export function makeHnsNameProofRuntime(input: {
  readonly capability: HnsControlObserverHsdPrivateCapability;
}): HnsNameProofRuntime {
  return {
    verify: async (request, signal) => {
      if (signal.aborted) throw new HnsNameProofRuntimeError("unavailable");
      const requestBytes = encoder.encode(
        JSON.stringify({
          method: HNS_PRIVATE_DRIVER_HSD_NAME_PROOF_METHOD,
          params: [request.root_label, request.signature, request.message, true],
        }),
      );
      let response: Response;
      try {
        response = await input.capability.exchange({
          method: "POST",
          headers: [
            ["Content-Type", "application/json"],
            ["Accept", "application/json"],
          ],
          body: requestBytes,
          response_max_bytes: RESPONSE_MAX_BYTES,
          redirect: "manual",
          signal,
        });
      } catch {
        throw new HnsNameProofRuntimeError("unavailable");
      }
      if (
        response.status !== 200 ||
        response.headers.get("content-type") === null ||
        !jsonContentTypePattern.test(response.headers.get("content-type") ?? "")
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsNameProofRuntimeError(
          response.status >= 500 ? "unavailable" : "invalid_response",
        );
      }
      const responseBytes = await readBounded(response, signal);
      let verified: boolean;
      try {
        verified = exactRpcResult(responseBytes);
      } catch (error) {
        if (error instanceof HnsNameProofRuntimeError) throw error;
        throw new HnsNameProofRuntimeError("invalid_response");
      }
      const [messageSha256, signatureSha256] = await Promise.all([
        sha256(request.message),
        sha256(request.signature),
      ]);
      return encodeHnsRootImportNameProofResultV1({
        version: "pirate-hns-root-import-name-proof-result-v1",
        root_label: request.root_label,
        message_sha256: messageSha256,
        signature_sha256: signatureSha256,
        safe: true,
        verified,
      });
    },
  };
}
