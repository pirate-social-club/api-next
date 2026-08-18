import {
  canonicalizeSignedVerifierResponse,
  type SignedVerifierResponseUnsigned,
} from "@pirate/verifier-response-contract";
import { type ProofResult, type Query, type QueryResult, ZKPassport } from "@zkpassport/sdk";

export const ZKPASSPORT_SDK_VERSION = "0.14.2" as const;
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const DEFAULT_WRITING_DIRECTORY = "/tmp";
export const ZKPASSPORT_RESPONSE_PROTOCOL_VERSION = "zkpassport-v2" as const;

type JsonRecord = Record<string, unknown>;

export type ZkPassportVerifyRequest = Readonly<{
  readonly domain: string;
  readonly proofs: readonly ProofResult[];
  readonly originalQuery: Query;
  readonly queryResult: QueryResult;
  readonly validity?: number;
  readonly scope?: string;
  readonly devMode?: boolean;
  readonly proof_session_id: string;
  readonly request_hash: string;
  readonly protocol_version: typeof ZKPASSPORT_RESPONSE_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly expiry: string;
  readonly key_id: string;
}>;

export type ZkPassportVerifyResponse = Readonly<
  SignedVerifierResponseUnsigned & { readonly signature: string }
>;

export type ZkPassportSdkVerifier = Readonly<{
  readonly verify: (input: Parameters<ZKPassport["verify"]>[0]) => ReturnType<ZKPassport["verify"]>;
}>;

export type ZkPassportSdkFactory = (domain: string) => ZkPassportSdkVerifier;

export type ZkPassportVerifierEnv = Readonly<{
  readonly sharedSecret: string;
  readonly responseSigningSecret: string;
  readonly responseSigningKeyId: string;
  readonly maxBodyBytes?: number;
  readonly writingDirectory?: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalIsoInstant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function responseFromSdk(
  value: Awaited<ReturnType<ZKPassport["verify"]>>,
  input: ZkPassportVerifyRequest,
  secret: string,
): Promise<ZkPassportVerifyResponse> {
  const unsigned: SignedVerifierResponseUnsigned = {
    proof_session_id: input.proof_session_id,
    request_hash: input.request_hash,
    verdict: value.verified,
    unique_identifier: value.verified && value.uniqueIdentifier ? value.uniqueIdentifier : null,
    unique_identifier_type: value.verified && value.uniqueIdentifierType === 0 ? 0 : null,
    protocol_version: input.protocol_version,
    nonce: input.nonce,
    expiry: input.expiry,
    key_id: input.key_id,
  };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalizeSignedVerifierResponse(unsigned)),
  );
  return { ...unsigned, signature: base64UrlEncode(new Uint8Array(signature)) };
}

function decodeVerifyBody(value: unknown): ZkPassportVerifyRequest | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "domain",
    "proofs",
    "originalQuery",
    "queryResult",
    "validity",
    "scope",
    "devMode",
    "proof_session_id",
    "request_hash",
    "protocol_version",
    "nonce",
    "expiry",
    "key_id",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    typeof value.domain !== "string" ||
    value.domain.trim() !== value.domain ||
    value.domain.length === 0 ||
    !Array.isArray(value.proofs) ||
    value.proofs.length === 0 ||
    value.proofs.length > 64 ||
    !isRecord(value.originalQuery) ||
    !isRecord(value.queryResult) ||
    typeof value.proof_session_id !== "string" ||
    value.proof_session_id.trim() !== value.proof_session_id ||
    value.proof_session_id.length === 0 ||
    typeof value.request_hash !== "string" ||
    value.request_hash.trim() !== value.request_hash ||
    !/^[0-9a-f]{64}$/.test(value.request_hash) ||
    value.protocol_version !== ZKPASSPORT_RESPONSE_PROTOCOL_VERSION ||
    typeof value.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce) ||
    typeof value.expiry !== "string" ||
    value.expiry.trim() !== value.expiry ||
    value.expiry.length === 0 ||
    !canonicalIsoInstant(value.expiry) ||
    typeof value.key_id !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.key_id)
  )
    return undefined;
  if (
    value.validity !== undefined &&
    (typeof value.validity !== "number" ||
      !Number.isSafeInteger(value.validity) ||
      value.validity <= 0)
  )
    return undefined;
  if (
    value.scope !== undefined &&
    (typeof value.scope !== "string" || value.scope.trim() !== value.scope)
  )
    return undefined;
  if (value.devMode !== undefined && typeof value.devMode !== "boolean") return undefined;
  return {
    domain: value.domain,
    proofs: value.proofs as ProofResult[],
    originalQuery: value.originalQuery as Query,
    queryResult: value.queryResult as QueryResult,
    ...(typeof value.validity !== "number" ? {} : { validity: value.validity }),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(value.devMode === undefined ? {} : { devMode: value.devMode }),
    proof_session_id: value.proof_session_id,
    request_hash: value.request_hash,
    protocol_version: value.protocol_version,
    nonce: value.nonce,
    expiry: value.expiry,
    key_id: value.key_id,
  };
}

async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array | undefined> {
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** SDK-only core. The factory is injectable for contract tests; production uses the pinned SDK. */
export async function verifyLocally(
  input: ZkPassportVerifyRequest,
  options: Readonly<{
    sdkFactory?: ZkPassportSdkFactory;
    writingDirectory?: string;
    responseSigningSecret: string;
  }>,
): Promise<ZkPassportVerifyResponse> {
  const sdk = (options.sdkFactory ?? ((domain) => new ZKPassport(domain)))(input.domain);
  const result = await sdk.verify({
    proofs: [...input.proofs],
    originalQuery: input.originalQuery,
    queryResult: input.queryResult,
    ...(input.validity === undefined ? {} : { validity: input.validity }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.devMode === undefined ? {} : { devMode: input.devMode }),
    writingDirectory: options.writingDirectory ?? DEFAULT_WRITING_DIRECTORY,
  });
  return responseFromSdk(result, input, options.responseSigningSecret);
}

export function validZkPassportVerifierEnv(env: ZkPassportVerifierEnv): boolean {
  return (
    env.sharedSecret.length > 0 &&
    env.responseSigningSecret.length > 0 &&
    env.sharedSecret.trim() === env.sharedSecret &&
    env.responseSigningSecret.trim() === env.responseSigningSecret &&
    /^[A-Za-z0-9._-]{1,128}$/.test(env.responseSigningKeyId) &&
    env.sharedSecret !== env.responseSigningSecret &&
    (env.maxBodyBytes === undefined ||
      (Number.isSafeInteger(env.maxBodyBytes) && env.maxBodyBytes > 0))
  );
}

export async function handleZkPassportVerifierRequest(
  request: Request,
  env: ZkPassportVerifierEnv,
  options: Readonly<{ sdkFactory?: ZkPassportSdkFactory }> = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (!validZkPassportVerifierEnv(env)) return jsonResponse({ code: "not_configured" }, 503);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      service: "zkpassport-verifier",
      sdk_version: ZKPASSPORT_SDK_VERSION,
    });
  }
  if (request.method !== "POST" || url.pathname !== "/verify")
    return jsonResponse({ code: "not_found" }, 404);
  if (!constantTimeEqual(bearerToken(request), env.sharedSecret)) {
    return jsonResponse({ code: "unauthorized" }, 401);
  }
  const maxBodyBytes = env.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return jsonResponse({ code: "payload_too_large" }, 413);
  }
  const bytes = await readBoundedBody(request, maxBodyBytes);
  if (bytes === undefined || bytes.length === 0)
    return jsonResponse({ code: "payload_too_large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return jsonResponse({ code: "invalid_request" }, 400);
  }
  const body = decodeVerifyBody(parsed);
  if (body === undefined) return jsonResponse({ code: "invalid_request" }, 400);
  if (body.key_id !== env.responseSigningKeyId)
    return jsonResponse({ code: "invalid_request" }, 400);
  try {
    const result = await verifyLocally(body, {
      ...(options.sdkFactory === undefined ? {} : { sdkFactory: options.sdkFactory }),
      writingDirectory: env.writingDirectory ?? DEFAULT_WRITING_DIRECTORY,
      responseSigningSecret: env.responseSigningSecret,
    });
    console.log(
      JSON.stringify({
        event: "zkpassport.verify.completed",
        service: "zkpassport-verifier",
        proof_count: body.proofs.length,
        verified: result.verdict,
        has_unique_identifier: result.unique_identifier !== null,
      }),
    );
    return jsonResponse(result);
  } catch {
    console.warn(
      JSON.stringify({
        event: "zkpassport.verify.failed",
        service: "zkpassport-verifier",
        proof_count: body.proofs.length,
      }),
    );
    return jsonResponse({ code: "verification_failed" }, 502);
  }
}
