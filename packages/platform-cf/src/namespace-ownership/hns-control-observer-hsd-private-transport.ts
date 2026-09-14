import {
  HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES,
  HNS_CONTROL_OBSERVER_HSD_METHODS,
  HnsControlObserverHsdTransportError,
  type HnsControlObserverHsdTransportPort,
} from "@pirate/application/namespace-ownership";
import { validCommunityRouteRoot } from "@pirate/domain";
import {
  exchangeBound,
  type HnsControlObserverHsdPrivateCapability,
  hsdTransportFailure,
  readBoundedResponse,
} from "./hsd-bounded-exchange.ts";

export type {
  HnsControlObserverHsdPrivateCapability,
  HnsControlObserverHsdPrivateRequest,
} from "./hsd-bounded-exchange.ts";

const HSD_RESPONSE_MAX_BYTES = 1_048_576;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hsdMethods = new Set<string>(HNS_CONTROL_OBSERVER_HSD_METHODS);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const driverReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function canonicalDriverRequest(method: string, bytes: Uint8Array): boolean {
  if (
    !hsdMethods.has(method) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES
  ) {
    return false;
  }
  try {
    const text = decoder.decode(bytes);
    const decoded = JSON.parse(text) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const record = decoded as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2 ||
      keys[0] !== "method" ||
      keys[1] !== "params" ||
      record.method !== method ||
      !Array.isArray(record.params)
    ) {
      return false;
    }
    const params = record.params;
    const exactParameters =
      method === "getblockchaininfo"
        ? params.length === 0
        : method === "getblockheader"
          ? params.length === 2 &&
            typeof params[0] === "string" &&
            sha256Pattern.test(params[0]) &&
            params[1] === true
          : params.length === 2 &&
            typeof params[0] === "string" &&
            validCommunityRouteRoot("hns", params[0]) &&
            params[1] === false;
    return (
      exactParameters &&
      JSON.stringify(decoded) === text &&
      encoder.encode(text).byteLength === bytes.byteLength
    );
  } catch {
    return false;
  }
}

/**
 * Private HSD adapter. The injected capability closes over endpoint selection
 * and authentication; the caller can select neither. This module deliberately
 * does not choose a service-binding, Tunnel, URL, credential, Worker binding,
 * environment variable, route, or runtime assembly.
 */
export function makeHnsControlObserverHsdPrivateTransport(input: {
  readonly driver_reference: string;
  readonly capability: HnsControlObserverHsdPrivateCapability;
}): HnsControlObserverHsdTransportPort {
  const pinnedDriverReference = driverReferencePattern.test(input.driver_reference);
  return {
    exchange: async (request) => {
      if (request.signal.aborted) throw hsdTransportFailure("aborted");
      if (
        !pinnedDriverReference ||
        request.driver_reference !== input.driver_reference ||
        !canonicalDriverRequest(request.method, request.request_bytes) ||
        !Number.isSafeInteger(request.response_max_bytes) ||
        request.response_max_bytes < 1 ||
        request.response_max_bytes > HSD_RESPONSE_MAX_BYTES
      ) {
        throw hsdTransportFailure("transport_error");
      }

      try {
        const response = await exchangeBound(
          input.capability,
          {
            method: "POST",
            headers: [
              ["Content-Type", "application/json"],
              ["Accept", "application/json"],
            ],
            body: new Uint8Array(request.request_bytes),
            response_max_bytes: request.response_max_bytes,
            redirect: "manual",
            signal: request.signal,
          },
          request.signal,
        );
        const responseBytes = await readBoundedResponse(
          response,
          request.response_max_bytes,
          request.signal,
        );
        if (request.signal.aborted) throw hsdTransportFailure("aborted");
        return {
          status: response.status,
          content_type: response.headers.get("content-type"),
          response_bytes: responseBytes,
        };
      } catch (error) {
        if (error instanceof HnsControlObserverHsdTransportError) throw error;
        throw hsdTransportFailure(request.signal.aborted ? "aborted" : "transport_error");
      }
    },
  };
}
