import { AuthError, BadRequest, NamespaceUnavailable, NotFound } from "@pirate/contracts";
import { CloudflareAccessJwtFailure } from "@pirate/platform-cf/cloudflare-access-jwt";
import {
  CF_ACCESS_ASSERTION_HEADER,
  decodeHnsSolidHostAuthorityRequestV2,
  encodeHnsSolidHostAuthorityResponseV2,
  HNS_SOLID_HOST_AUTHORITY_MAX_BYTES,
  HnsCommunityAppApiWireFailure,
  type HnsHostAuthorityStateV1,
  isHnsCommunityAppApiPath,
  isHnsCommunityAppPrivateHeaderName,
  resolveHnsSolidHostAuthorityV2,
} from "@pirate/platform-cf/hns-community-app-api";
import { HnsForwarderFailure } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import type { HnsCommunityAppApiComposition } from "./hns-community-app-api-composition.ts";

export const HNS_COMMUNITY_APP_API_MAX_BODY_BYTES = 1_048_576 as const;
const allowedMethods = new Set(["GET", "HEAD", "POST", "PATCH"]);
const unsafeMethods = new Set(["POST", "PATCH"]);

type RequestHeaders = Readonly<{
  get: (name: string) => string | null;
  entries: () => IterableIterator<[string, string]>;
}>;

type HnsCommunityAppTransportRequest = Readonly<{
  method: string;
  url: string;
  headers: RequestHeaders;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
  clone: () => HnsCommunityAppTransportRequest;
}>;

const invalidRequest = (): BadRequest => new BadRequest({ message: "Invalid HNS request" });
const authenticationFailed = (): AuthError => new AuthError({ message: "Authentication failed" });
const authorityUnavailable = (): NotFound =>
  new NotFound({ message: "HNS host authority unavailable" });
const infrastructureUnavailable = (): NamespaceUnavailable =>
  new NamespaceUnavailable({ message: "HNS host authority unavailable" });

export function hasReservedHnsCommunityAppHeader(headers: RequestHeaders): boolean {
  for (const [name] of headers.entries()) {
    if (isHnsCommunityAppPrivateHeaderName(name)) return true;
  }
  return false;
}

export function stripHnsCommunityAppPrivateHeaders(headers: Headers): Headers {
  const stripped = new Headers();
  for (const [name, value] of headers.entries()) {
    if (!isHnsCommunityAppPrivateHeaderName(name)) stripped.append(name, value);
  }
  return stripped;
}

async function readBoundedRequestBody(
  request: HnsCommunityAppTransportRequest,
  maximum: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw invalidRequest();
  }
  const body = request.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw invalidRequest();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function authenticateAccess(
  request: HnsCommunityAppTransportRequest,
  composition: Extract<HnsCommunityAppApiComposition, { readonly enabled: true }>,
): Promise<void> {
  if (new URL(request.url).origin !== composition.protected_origin) {
    throw authenticationFailed();
  }
  const assertion = request.headers.get(CF_ACCESS_ASSERTION_HEADER);
  if (assertion === null || assertion === "" || assertion.includes(",")) {
    throw authenticationFailed();
  }
  try {
    await composition.access_validator.verify(assertion, request.signal);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason ?? error;
    if (error instanceof CloudflareAccessJwtFailure) throw authenticationFailed();
    throw authenticationFailed();
  }
}

export type VerifiedHnsCommunityAppApiRequest = Readonly<{
  normalized_host: string;
  exact_origin: string;
}>;

export async function verifyHnsCommunityAppApiRequest(
  request: HnsCommunityAppTransportRequest,
  composition: Extract<HnsCommunityAppApiComposition, { readonly enabled: true }>,
): Promise<VerifiedHnsCommunityAppApiRequest> {
  const parsed = new URL(request.url);
  if (!isHnsCommunityAppApiPath(parsed.pathname) || !allowedMethods.has(request.method)) {
    throw invalidRequest();
  }
  await authenticateAccess(request, composition);
  const bodyBytes = await readBoundedRequestBody(
    request.clone(),
    HNS_COMMUNITY_APP_API_MAX_BODY_BYTES,
  );
  let verified: Awaited<ReturnType<typeof composition.forwarder_validator.verify>>;
  try {
    verified = await composition.forwarder_validator.verify({
      method: request.method,
      url: request.url,
      headers: new Headers([...request.headers.entries()]),
      body_bytes: bodyBytes,
    });
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason ?? error;
    if (error instanceof HnsForwarderFailure) {
      if (error.reason === "authority_unavailable") throw authorityUnavailable();
      throw invalidRequest();
    }
    throw infrastructureUnavailable();
  }
  if (verified.state.variant !== "community_app_v1") throw authorityUnavailable();
  const exactOrigin = `https://${verified.normalized_host}`;
  const origin = request.headers.get("origin");
  if (
    (unsafeMethods.has(request.method) && origin !== exactOrigin) ||
    (origin !== null && origin !== exactOrigin)
  ) {
    throw authenticationFailed();
  }
  return Object.freeze({ normalized_host: verified.normalized_host, exact_origin: exactOrigin });
}

export async function resolveHnsSolidHostAuthorityRequest(
  request: HnsCommunityAppTransportRequest,
  composition: Extract<HnsCommunityAppApiComposition, { readonly enabled: true }>,
): Promise<Uint8Array> {
  if (
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.get("accept") !== "application/json"
  ) {
    throw invalidRequest();
  }
  await authenticateAccess(request, composition);
  const bytes = await readBoundedRequestBody(request.clone(), HNS_SOLID_HOST_AUTHORITY_MAX_BYTES);
  let decoded: ReturnType<typeof decodeHnsSolidHostAuthorityRequestV2>;
  try {
    decoded = decodeHnsSolidHostAuthorityRequestV2(bytes);
  } catch (error) {
    if (error instanceof HnsCommunityAppApiWireFailure) throw invalidRequest();
    throw error;
  }
  let state: HnsHostAuthorityStateV1 | null;
  try {
    state = await Effect.runPromise(composition.authority_source.resolve(decoded[1]));
  } catch {
    throw infrastructureUnavailable();
  }
  if (state !== null && state.variant !== "community_app_v1") throw authorityUnavailable();
  try {
    return encodeHnsSolidHostAuthorityResponseV2(resolveHnsSolidHostAuthorityV2(decoded, state));
  } catch (error) {
    if (error instanceof HnsCommunityAppApiWireFailure) throw authorityUnavailable();
    throw error;
  }
}
