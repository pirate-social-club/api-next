import {
  decodeHnsPrivateDriverAuthoritativeAxfrResponseV1,
  decodeHnsPrivateDriverErrorV1,
  decodeHnsPrivateDriverUpstreamContentType,
  encodeHnsPrivateDriverRequestV1,
  HNS_PRIVATE_DRIVER_AXFR_PATH,
  HNS_PRIVATE_DRIVER_AXFR_RESPONSE_MAX_BYTES,
  HNS_PRIVATE_DRIVER_DNS_PATH,
  HNS_PRIVATE_DRIVER_ERROR_MAX_BYTES,
  HNS_PRIVATE_DRIVER_HSD_PATH,
  HNS_PRIVATE_DRIVER_ORIGIN,
  HNS_PRIVATE_DRIVER_PROTOCOL,
  HNS_PRIVATE_DRIVER_PROTOCOL_HEADER,
  HNS_PRIVATE_DRIVER_TIMEOUT_MAX_MS,
  HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER,
  HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER,
  HnsAuthoritativeDnsTransportErrorV1,
  type HnsAuthoritativeDnsTransportPortV1,
  HnsControlObserverHsdTransportError,
  HnsPrivateDriverAuthoritativeAxfrTransportErrorV1,
  type HnsPrivateDriverAuthoritativeAxfrTransportPortV1,
} from "@pirate/application/namespace-ownership";
import type { HnsControlObserverHsdPrivateCapability } from "./hns-control-observer-hsd-private-transport.ts";

export type HnsPrivateDriverBinding = Readonly<{
  readonly fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
}>;

const successProtocolHeaders = new Set([HNS_PRIVATE_DRIVER_PROTOCOL_HEADER.toLowerCase()]);
const hsdSuccessProtocolHeaders = new Set([
  ...successProtocolHeaders,
  HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER.toLowerCase(),
  HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER.toLowerCase(),
]);

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= HNS_PRIVATE_DRIVER_TIMEOUT_MAX_MS;
}

function exactOwnedHeaders(headers: Headers, expected: ReadonlySet<string>): boolean {
  const actual = [...headers.keys()].filter((name) => name.toLowerCase().startsWith("pirate-hns-"));
  return (
    actual.length === expected.size && actual.every((name) => expected.has(name.toLowerCase()))
  );
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new DOMException("Aborted", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (total <= maximumBytes) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (part.done) break;
      const remaining = maximumBytes + 1 - total;
      const chunk = part.value.slice(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (part.value.byteLength > remaining || total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      // An aborted stream may retain the reader until cancellation settles.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function driverErrorOutcome(
  response: Response,
  signal: AbortSignal,
): Promise<"timeout" | "transport_error" | "aborted"> {
  if (signal.aborted) return "aborted";
  if (
    response.headers.get("content-type") !== "application/json" ||
    !exactOwnedHeaders(response.headers, successProtocolHeaders) ||
    response.headers.get(HNS_PRIVATE_DRIVER_PROTOCOL_HEADER) !== HNS_PRIVATE_DRIVER_PROTOCOL
  ) {
    await response.body?.cancel().catch(() => undefined);
    return "transport_error";
  }
  try {
    const bytes = await readBounded(response, HNS_PRIVATE_DRIVER_ERROR_MAX_BYTES, signal);
    if (bytes.byteLength > HNS_PRIVATE_DRIVER_ERROR_MAX_BYTES) return "transport_error";
    const decoded = decodeHnsPrivateDriverErrorV1(response.status, bytes);
    return decoded.error === "timeout" ? "timeout" : "transport_error";
  } catch {
    return signal.aborted ? "aborted" : "transport_error";
  }
}

function privateRequest(
  path: string,
  accept: string,
  body: Uint8Array,
  signal: AbortSignal,
): Request {
  return new Request(`${HNS_PRIVATE_DRIVER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      [HNS_PRIVATE_DRIVER_PROTOCOL_HEADER]: HNS_PRIVATE_DRIVER_PROTOCOL,
    },
    body,
    redirect: "manual",
    signal,
  });
}

async function fetchBound(
  binding: HnsPrivateDriverBinding,
  request: Request,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  let responsePromise: Promise<Response>;
  try {
    responsePromise = inputFetch(binding, request);
  } catch (error) {
    signal.removeEventListener("abort", abort);
    throw error;
  }
  void responsePromise.then(
    (response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => undefined);
    },
    () => undefined,
  );
  try {
    return await Promise.race([responsePromise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function inputFetch(binding: HnsPrivateDriverBinding, request: Request): Promise<Response> {
  return binding.fetch(request);
}

export function makeHnsControlObserverHsdPrivateDriverCapability(input: {
  readonly binding: HnsPrivateDriverBinding;
  readonly driver_reference: string;
  readonly timeout_ms: number;
}): HnsControlObserverHsdPrivateCapability {
  const timeoutValid = validTimeout(input.timeout_ms);
  return {
    exchange: async (request) => {
      if (
        request.signal.aborted ||
        !timeoutValid ||
        request.method !== "POST" ||
        request.redirect !== "manual" ||
        request.headers.length !== 2 ||
        request.headers[0]?.[0] !== "Content-Type" ||
        request.headers[0]?.[1] !== "application/json" ||
        request.headers[1]?.[0] !== "Accept" ||
        request.headers[1]?.[1] !== "application/json"
      ) {
        throw new HnsControlObserverHsdTransportError(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
      let response: Response;
      try {
        const body = encodeHnsPrivateDriverRequestV1({
          exchange_kind: "hsd_json_rpc",
          driver_reference: input.driver_reference,
          request_bytes: new Uint8Array(request.body),
          response_max_bytes: request.response_max_bytes,
          timeout_ms: input.timeout_ms,
        });
        response = await fetchBound(
          input.binding,
          privateRequest(
            HNS_PRIVATE_DRIVER_HSD_PATH,
            "application/octet-stream",
            body,
            request.signal,
          ),
          request.signal,
        );
      } catch {
        throw new HnsControlObserverHsdTransportError(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
      if (request.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsControlObserverHsdTransportError("aborted");
      }
      if (response.status !== 200) {
        throw new HnsControlObserverHsdTransportError(
          await driverErrorOutcome(response, request.signal),
        );
      }
      if (
        response.headers.get("content-type") !== "application/octet-stream" ||
        response.headers.get(HNS_PRIVATE_DRIVER_PROTOCOL_HEADER) !== HNS_PRIVATE_DRIVER_PROTOCOL ||
        !exactOwnedHeaders(response.headers, hsdSuccessProtocolHeaders)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsControlObserverHsdTransportError("transport_error");
      }
      const upstreamStatusText = response.headers.get(HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER);
      const upstreamContentTypeText = response.headers.get(
        HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER,
      );
      if (upstreamStatusText === null || !/^[2-5]\d\d$/u.test(upstreamStatusText)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsControlObserverHsdTransportError("transport_error");
      }
      let upstreamContentType: string | null;
      try {
        upstreamContentType = decodeHnsPrivateDriverUpstreamContentType(upstreamContentTypeText);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsControlObserverHsdTransportError("transport_error");
      }
      return new Response(response.body, {
        status: Number(upstreamStatusText),
        headers: upstreamContentType === null ? {} : { "Content-Type": upstreamContentType },
      });
    },
  };
}

export function makeHnsAuthoritativeDnsPrivateDriverTransport(input: {
  readonly binding: HnsPrivateDriverBinding;
  readonly driver_reference: string;
  readonly timeout_ms: number;
}): HnsAuthoritativeDnsTransportPortV1 {
  const timeoutValid = validTimeout(input.timeout_ms);
  return {
    exchange: async (request) => {
      if (
        request.signal.aborted ||
        !timeoutValid ||
        request.driver_reference !== input.driver_reference
      ) {
        throw new HnsAuthoritativeDnsTransportErrorV1(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
      let response: Response;
      try {
        const body = encodeHnsPrivateDriverRequestV1({
          exchange_kind: "authoritative_dns_tcp",
          driver_reference: input.driver_reference,
          view_id: request.view_id,
          query_kind: request.query_kind,
          root_label: request.root_label,
          chain_authority_digest: request.chain_authority_digest,
          authority_nameserver: request.authority_nameserver,
          authority_address_family: request.authority_address_family,
          authority_address: request.authority_address,
          request_bytes: new Uint8Array(request.request_bytes),
          response_max_bytes: request.response_max_bytes,
          timeout_ms: input.timeout_ms,
        });
        response = await fetchBound(
          input.binding,
          privateRequest(
            HNS_PRIVATE_DRIVER_DNS_PATH,
            "application/dns-message",
            body,
            request.signal,
          ),
          request.signal,
        );
      } catch {
        throw new HnsAuthoritativeDnsTransportErrorV1(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
      if (request.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsAuthoritativeDnsTransportErrorV1("aborted");
      }
      if (response.status !== 200) {
        throw new HnsAuthoritativeDnsTransportErrorV1(
          await driverErrorOutcome(response, request.signal),
        );
      }
      if (
        response.headers.get("content-type") !== "application/dns-message" ||
        response.headers.get(HNS_PRIVATE_DRIVER_PROTOCOL_HEADER) !== HNS_PRIVATE_DRIVER_PROTOCOL ||
        !exactOwnedHeaders(response.headers, successProtocolHeaders) ||
        response.headers.has(HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER) ||
        response.headers.has(HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsAuthoritativeDnsTransportErrorV1("transport_error");
      }
      try {
        const bytes = await readBounded(response, request.response_max_bytes, request.signal);
        if (bytes.byteLength === 0 || bytes.byteLength > request.response_max_bytes + 1) {
          throw new Error("invalid response length");
        }
        if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return bytes;
      } catch {
        throw new HnsAuthoritativeDnsTransportErrorV1(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
    },
  };
}

export function makeHnsAuthoritativeAxfrPrivateDriverTransport(input: {
  readonly binding: HnsPrivateDriverBinding;
  readonly driver_reference: string;
  readonly timeout_ms: number;
}): HnsPrivateDriverAuthoritativeAxfrTransportPortV1 {
  const timeoutValid = validTimeout(input.timeout_ms);
  return {
    exchange: async (request) => {
      if (
        request.signal.aborted ||
        !timeoutValid ||
        request.driver_reference !== input.driver_reference
      ) {
        throw new HnsPrivateDriverAuthoritativeAxfrTransportErrorV1(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
      let response: Response;
      try {
        const body = encodeHnsPrivateDriverRequestV1({
          exchange_kind: "authoritative_dns_tsig_axfr",
          driver_reference: input.driver_reference,
          view_id: request.view_id,
          credential_reference: request.credential_reference,
          root_label: request.root_label,
          authority_nameserver: request.authority_nameserver,
          authority_address_family: request.authority_address_family,
          authority_address: request.authority_address,
          response_message_max_bytes: request.response_message_max_bytes,
          response_total_max_bytes: request.response_total_max_bytes,
          response_max_messages: request.response_max_messages,
          timeout_ms: input.timeout_ms,
        });
        response = await fetchBound(
          input.binding,
          privateRequest(
            HNS_PRIVATE_DRIVER_AXFR_PATH,
            "application/octet-stream",
            body,
            request.signal,
          ),
          request.signal,
        );
      } catch {
        throw new HnsPrivateDriverAuthoritativeAxfrTransportErrorV1(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
      if (request.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsPrivateDriverAuthoritativeAxfrTransportErrorV1("aborted");
      }
      if (response.status !== 200) {
        throw new HnsPrivateDriverAuthoritativeAxfrTransportErrorV1(
          await driverErrorOutcome(response, request.signal),
        );
      }
      if (
        response.headers.get("content-type") !== "application/octet-stream" ||
        response.headers.get(HNS_PRIVATE_DRIVER_PROTOCOL_HEADER) !== HNS_PRIVATE_DRIVER_PROTOCOL ||
        !exactOwnedHeaders(response.headers, successProtocolHeaders) ||
        response.headers.has(HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER) ||
        response.headers.has(HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new HnsPrivateDriverAuthoritativeAxfrTransportErrorV1("transport_error");
      }
      try {
        const bytes = await readBounded(
          response,
          HNS_PRIVATE_DRIVER_AXFR_RESPONSE_MAX_BYTES,
          request.signal,
        );
        if (bytes.byteLength > HNS_PRIVATE_DRIVER_AXFR_RESPONSE_MAX_BYTES) {
          throw new Error("AXFR response exceeds its bound");
        }
        const decoded = decodeHnsPrivateDriverAuthoritativeAxfrResponseV1(bytes);
        if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return {
          request_bytes: Uint8Array.from(decoded.request_bytes),
          response_sequence_bytes: Uint8Array.from(decoded.response_sequence_bytes),
        };
      } catch {
        throw new HnsPrivateDriverAuthoritativeAxfrTransportErrorV1(
          request.signal.aborted ? "aborted" : "transport_error",
        );
      }
    },
  };
}
