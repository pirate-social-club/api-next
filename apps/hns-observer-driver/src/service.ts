import { isIP } from "node:net";
import {
  decodeHnsPrivateDriverRequestV1,
  encodeHnsPrivateDriverAuthoritativeAxfrResponseV1,
  encodeHnsPrivateDriverErrorV1,
  encodeHnsPrivateDriverUpstreamContentType,
  HNS_PRIVATE_DRIVER_AXFR_PATH,
  HNS_PRIVATE_DRIVER_DNS_PATH,
  HNS_PRIVATE_DRIVER_HSD_PATH,
  HNS_PRIVATE_DRIVER_PROTOCOL,
  HNS_PRIVATE_DRIVER_PROTOCOL_HEADER,
  HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES,
  HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER,
  HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER,
  type HnsPrivateDriverErrorCodeV1,
  hnsPrivateDriverErrorStatus,
} from "@pirate/application/namespace-ownership";
import {
  exchangeDirectHnsDnsTcp,
  type HnsDnsTcpConnector,
  HnsObserverDriverExchangeError,
} from "./dns-tcp.ts";
import { exchangeDirectHnsDnsTsigAxfrV1, type HnsDnsTsigCredentialV1 } from "./dns-tsig-axfr.ts";
import type { HnsObserverDriverHsdCapability } from "./hsd-http.ts";

export type HnsObserverDriverDnsView = Readonly<{
  readonly view_id: string;
  readonly vantage_reference: string;
  readonly connector: HnsDnsTcpConnector;
}>;

export type HnsObserverDriverAxfrTarget = Readonly<{
  readonly view_id: string;
  readonly credential_reference: string;
  readonly root_label: string;
  readonly authority_nameserver: string;
  readonly authority_address_family: "GLUE4" | "GLUE6";
  readonly authority_address: string;
  readonly credential: HnsDnsTsigCredentialV1;
  readonly fudge_seconds: number;
}>;

export type HnsObserverDriverService = Readonly<{
  readonly fetch: (request: Request) => Promise<Response>;
}>;

const viewIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const vantageReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function protocolHeaders(contentType: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    [HNS_PRIVATE_DRIVER_PROTOCOL_HEADER]: HNS_PRIVATE_DRIVER_PROTOCOL,
  });
}

function errorResponse(error: HnsPrivateDriverErrorCodeV1, status?: number): Response {
  return new Response(encodeHnsPrivateDriverErrorV1(error), {
    status: status ?? hnsPrivateDriverErrorStatus(error),
    headers: protocolHeaders("application/json"),
  });
}

function validRequestHeaders(headers: Headers, accept: string): boolean {
  if (
    headers.get("content-type") !== "application/json" ||
    headers.get("accept") !== accept ||
    headers.get(HNS_PRIVATE_DRIVER_PROTOCOL_HEADER) !== HNS_PRIVATE_DRIVER_PROTOCOL
  ) {
    return false;
  }
  const owned = [...headers.keys()].filter((name) => name.toLowerCase().startsWith("pirate-hns-"));
  return (
    owned.length === 1 &&
    owned[0]?.toLowerCase() === HNS_PRIVATE_DRIVER_PROTOCOL_HEADER.toLowerCase()
  );
}

async function readRequestBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  try {
    while (retained <= HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES + 1 - retained;
      const chunk = part.value.slice(0, remaining);
      chunks.push(chunk);
      retained += chunk.byteLength;
      if (part.value.byteLength > remaining || retained > HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled over-bound request may retain its reader briefly.
    }
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exchangeErrorResponse(error: unknown): Response {
  if (!(error instanceof HnsObserverDriverExchangeError)) return errorResponse("internal_error");
  if (error.outcome === "timeout") return errorResponse("timeout");
  if (error.outcome === "upstream_protocol_error" || error.outcome === "authentication_failed") {
    return errorResponse("upstream_protocol_error");
  }
  return errorResponse("upstream_unavailable");
}

export function makeHnsObserverDriverService(input: {
  readonly hsd_driver_reference: string;
  readonly dns_driver_reference: string;
  readonly axfr_driver_reference?: string;
  readonly hsd: HnsObserverDriverHsdCapability;
  readonly dns_views: ReadonlyArray<HnsObserverDriverDnsView>;
  readonly axfr_targets?: ReadonlyArray<HnsObserverDriverAxfrTarget>;
}): HnsObserverDriverService {
  if (input.dns_views.length !== 2) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const views = new Map<string, HnsObserverDriverDnsView>();
  const vantageReferences = new Set<string>();
  for (const view of input.dns_views) {
    if (
      !viewIdPattern.test(view.view_id) ||
      !vantageReferencePattern.test(view.vantage_reference) ||
      views.has(view.view_id) ||
      vantageReferences.has(view.vantage_reference)
    ) {
      throw new HnsObserverDriverExchangeError("upstream_protocol_error");
    }
    views.set(view.view_id, Object.freeze({ ...view }));
    vantageReferences.add(view.vantage_reference);
  }
  const configuredAxfrTargets = input.axfr_targets ?? [];
  if (
    (configuredAxfrTargets.length === 0) !== (input.axfr_driver_reference === undefined) ||
    (configuredAxfrTargets.length !== 0 && configuredAxfrTargets.length !== 2) ||
    (input.axfr_driver_reference !== undefined &&
      !vantageReferencePattern.test(input.axfr_driver_reference))
  ) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const axfrTargets = new Map<string, HnsObserverDriverAxfrTarget>();
  const credentialReferences = new Set<string>();
  for (const target of configuredAxfrTargets) {
    const addressFamily = isIP(target.authority_address);
    const expectedFamily =
      target.authority_address_family === "GLUE4"
        ? 4
        : target.authority_address_family === "GLUE6"
          ? 6
          : null;
    if (
      !viewIdPattern.test(target.view_id) ||
      !views.has(target.view_id) ||
      axfrTargets.has(target.view_id) ||
      !vantageReferencePattern.test(target.credential_reference) ||
      credentialReferences.has(target.credential_reference) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(target.root_label) ||
      !/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/u.test(
        target.authority_nameserver,
      ) ||
      expectedFamily === null ||
      addressFamily !== expectedFamily ||
      target.credential.algorithm !== "hmac-sha256" ||
      !/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/u.test(
        target.credential.key_name,
      ) ||
      !(target.credential.secret_bytes instanceof Uint8Array) ||
      target.credential.secret_bytes.byteLength < 16 ||
      target.credential.secret_bytes.byteLength > 512 ||
      !Number.isSafeInteger(target.fudge_seconds) ||
      target.fudge_seconds < 1 ||
      target.fudge_seconds > 3_600
    ) {
      throw new HnsObserverDriverExchangeError("upstream_protocol_error");
    }
    axfrTargets.set(
      target.view_id,
      Object.freeze({
        ...target,
        credential: Object.freeze({
          ...target.credential,
          secret_bytes: Uint8Array.from(target.credential.secret_bytes),
        }),
      }),
    );
    credentialReferences.add(target.credential_reference);
  }

  return {
    fetch: async (request) => {
      const url = new URL(request.url);
      const isHsd = url.pathname === HNS_PRIVATE_DRIVER_HSD_PATH;
      const isDns = url.pathname === HNS_PRIVATE_DRIVER_DNS_PATH;
      const isAxfr = url.pathname === HNS_PRIVATE_DRIVER_AXFR_PATH;
      if (!isHsd && !isDns && !isAxfr) return errorResponse("invalid_request", 404);
      if (request.method !== "POST") return errorResponse("invalid_request", 405);
      if (url.search !== "" || url.hash !== "") return errorResponse("invalid_request");
      if (
        !validRequestHeaders(
          request.headers,
          isHsd || isAxfr ? "application/octet-stream" : "application/dns-message",
        )
      ) {
        return errorResponse("invalid_request");
      }
      const declaredLength = request.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^\d+$/u.test(declaredLength) ||
          Number(declaredLength) > HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES)
      ) {
        return errorResponse("request_too_large");
      }

      let body: Uint8Array;
      try {
        body = await readRequestBody(request);
      } catch {
        return request.signal.aborted
          ? errorResponse("upstream_unavailable")
          : errorResponse("invalid_request");
      }
      if (body.byteLength > HNS_PRIVATE_DRIVER_REQUEST_MAX_BYTES) {
        return errorResponse("request_too_large");
      }

      let decoded: ReturnType<typeof decodeHnsPrivateDriverRequestV1>;
      try {
        decoded = decodeHnsPrivateDriverRequestV1(body);
      } catch {
        return errorResponse("invalid_request");
      }

      if (isHsd) {
        if (
          decoded.request.exchange_kind !== "hsd_json_rpc" ||
          decoded.request.driver_reference !== input.hsd_driver_reference ||
          !("request_bytes" in decoded)
        ) {
          return errorResponse("invalid_request");
        }
        try {
          const result = await input.hsd.exchange({
            request_bytes: decoded.request_bytes,
            response_max_bytes: decoded.request.response_max_bytes,
            timeout_ms: decoded.request.timeout_ms,
            signal: request.signal,
          });
          if (
            !Number.isSafeInteger(result.status) ||
            result.status < 200 ||
            result.status > 599 ||
            result.response_bytes.byteLength > decoded.request.response_max_bytes + 1
          ) {
            return errorResponse("upstream_protocol_error");
          }
          const headers = protocolHeaders("application/octet-stream");
          headers.set(HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER, String(result.status));
          headers.set(
            HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER,
            encodeHnsPrivateDriverUpstreamContentType(result.content_type),
          );
          return new Response(result.response_bytes, { headers });
        } catch (error) {
          return exchangeErrorResponse(error);
        }
      }

      if (isAxfr) {
        if (
          decoded.request.exchange_kind !== "authoritative_dns_tsig_axfr" ||
          decoded.request.driver_reference !== input.axfr_driver_reference
        ) {
          return errorResponse("invalid_request");
        }
        const target = axfrTargets.get(decoded.request.view_id);
        if (
          target === undefined ||
          target.credential_reference !== decoded.request.credential_reference ||
          target.root_label !== decoded.request.root_label ||
          target.authority_nameserver !== decoded.request.authority_nameserver ||
          target.authority_address_family !== decoded.request.authority_address_family ||
          target.authority_address !== decoded.request.authority_address
        ) {
          return errorResponse("invalid_request");
        }
        const view = views.get(target.view_id);
        if (view === undefined) return errorResponse("internal_error");
        try {
          const result = await exchangeDirectHnsDnsTsigAxfrV1({
            connector: view.connector,
            host: target.authority_address,
            family: target.authority_address_family === "GLUE4" ? 4 : 6,
            zone_name: target.root_label,
            credential: target.credential,
            fudge_seconds: target.fudge_seconds,
            response_message_max_bytes: decoded.request.response_message_max_bytes,
            response_total_max_bytes: decoded.request.response_total_max_bytes,
            response_max_messages: decoded.request.response_max_messages,
            timeout_ms: decoded.request.timeout_ms,
            signal: request.signal,
          });
          return new Response(
            encodeHnsPrivateDriverAuthoritativeAxfrResponseV1({
              request_bytes: result.request_bytes,
              response_sequence_bytes: result.response_sequence_bytes,
            }),
            { headers: protocolHeaders("application/octet-stream") },
          );
        } catch (error) {
          return exchangeErrorResponse(error);
        }
      }

      if (
        decoded.request.exchange_kind !== "authoritative_dns_tcp" ||
        decoded.request.driver_reference !== input.dns_driver_reference ||
        !("request_bytes" in decoded)
      ) {
        return errorResponse("invalid_request");
      }
      const view = views.get(decoded.request.view_id);
      const addressFamily = isIP(decoded.request.authority_address);
      const family = addressFamily === 4 ? 4 : addressFamily === 6 ? 6 : null;
      if (
        view === undefined ||
        family === null ||
        (decoded.request.authority_address_family === "GLUE4" ? family !== 4 : family !== 6)
      ) {
        return errorResponse("invalid_request");
      }
      try {
        const responseBytes = await exchangeDirectHnsDnsTcp({
          connector: view.connector,
          host: decoded.request.authority_address,
          family,
          request_bytes: decoded.request_bytes,
          response_max_bytes: decoded.request.response_max_bytes,
          timeout_ms: decoded.request.timeout_ms,
          signal: request.signal,
        });
        return new Response(responseBytes, {
          headers: protocolHeaders("application/dns-message"),
        });
      } catch (error) {
        return exchangeErrorResponse(error);
      }
    },
  };
}
