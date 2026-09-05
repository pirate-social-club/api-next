import { AuthError, BadRequest, NamespaceUnavailable, NotFound } from "@pirate/contracts";
import { CloudflareAccessJwtFailure } from "@pirate/platform-cf/cloudflare-access-jwt";
import {
  HNS_DIAGNOSTIC_ID_HEADER,
  HnsAuthorityDiagnostic,
  isHnsDiagnosticId,
  makeHnsAuthorityDiagnostic,
  withHnsAuthoritySpan,
} from "@pirate/platform-cf/hns-authority-diagnostics";
import { CF_ACCESS_ASSERTION_HEADER } from "@pirate/platform-cf/hns-community-app-api";
import {
  decodeHnsSolidHandleHostAuthorityRequestV1,
  encodeHnsSolidHandleHostAuthorityResponseV1,
  HNS_SOLID_HANDLE_HOST_AUTHORITY_MAX_BYTES,
  HnsHandleHostApiWireFailure,
  resolveHnsSolidHandleHostAuthorityV1,
} from "@pirate/platform-cf/hns-handle-host-api";
import { Effect } from "effect";
import type { HnsHandleHostApiComposition } from "./hns-handle-host-api-composition.ts";

type RequestHeaders = Readonly<{ get: (name: string) => string | null }>;
type HnsHandleHostTransportRequest = Readonly<{
  method: string;
  url: string;
  headers: RequestHeaders;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
  clone: () => HnsHandleHostTransportRequest;
}>;

const invalidRequest = (): BadRequest => new BadRequest({ message: "Invalid HNS request" });
const authenticationFailed = (): AuthError => new AuthError({ message: "Authentication failed" });
const authorityUnavailable = (): NotFound =>
  new NotFound({ message: "HNS host authority unavailable" });
const infrastructureUnavailable = (): NamespaceUnavailable =>
  new NamespaceUnavailable({ message: "HNS host authority unavailable" });

async function readBoundedRequestBody(
  request: HnsHandleHostTransportRequest,
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
  request: HnsHandleHostTransportRequest,
  composition: Extract<HnsHandleHostApiComposition, { readonly enabled: true }>,
): Promise<void> {
  if (new URL(request.url).origin !== composition.protected_origin) throw authenticationFailed();
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

export async function resolveHnsSolidHandleHostAuthorityRequest(
  request: HnsHandleHostTransportRequest,
  composition: Extract<HnsHandleHostApiComposition, { readonly enabled: true }>,
): Promise<Uint8Array> {
  if (
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.get("accept") !== "application/json"
  ) {
    throw invalidRequest();
  }
  await authenticateAccess(request, composition);
  const diagnosticId = request.headers.get(HNS_DIAGNOSTIC_ID_HEADER);
  if (diagnosticId !== null && !isHnsDiagnosticId(diagnosticId)) throw invalidRequest();
  const bytes = await readBoundedRequestBody(
    request.clone(),
    HNS_SOLID_HANDLE_HOST_AUTHORITY_MAX_BYTES,
  );
  let decoded: ReturnType<typeof decodeHnsSolidHandleHostAuthorityRequestV1>;
  try {
    decoded = decodeHnsSolidHandleHostAuthorityRequestV1(bytes);
  } catch (error) {
    if (error instanceof HnsHandleHostApiWireFailure) throw invalidRequest();
    throw error;
  }
  const lookup = Effect.suspend(() => composition.authority_source.resolve(decoded[1])).pipe(
    Effect.mapError(() => infrastructureUnavailable()),
    Effect.catchDefect(() => Effect.fail(infrastructureUnavailable())),
    Effect.flatMap((state) =>
      Effect.try({
        try: () => {
          if (state !== null && state.variant !== "handle_persona_v1") throw authorityUnavailable();
          return encodeHnsSolidHandleHostAuthorityResponseV1(
            resolveHnsSolidHandleHostAuthorityV1(decoded, state),
          );
        },
        catch: (error) =>
          error instanceof HnsHandleHostApiWireFailure ? authorityUnavailable() : error,
      }),
    ),
  );
  try {
    return await Effect.runPromise(
      withHnsAuthoritySpan("authority", lookup).pipe(
        Effect.provideService(HnsAuthorityDiagnostic, makeHnsAuthorityDiagnostic(diagnosticId)),
      ),
      { signal: request.signal },
    );
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason ?? error;
    throw error;
  }
}
