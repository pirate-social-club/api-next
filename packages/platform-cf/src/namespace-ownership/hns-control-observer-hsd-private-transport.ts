import {
  HNS_CONTROL_OBSERVER_DRIVER_REQUEST_MAX_BYTES,
  HNS_CONTROL_OBSERVER_HSD_METHODS,
  HnsControlObserverHsdTransportError,
  type HnsControlObserverHsdTransportPort,
} from "@pirate/application/namespace-ownership";
import { validCommunityRouteRoot } from "@pirate/domain";

const HSD_RESPONSE_MAX_BYTES = 1_048_576;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const hsdMethods = new Set<string>(HNS_CONTROL_OBSERVER_HSD_METHODS);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const driverReferencePattern = /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export type HnsControlObserverHsdPrivateRequest = Readonly<{
  readonly method: "POST";
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
  readonly response_max_bytes: number;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}>;

export type HnsControlObserverHsdPrivateCapability = Readonly<{
  /** Endpoint selection and authentication are closed over by this capability. */
  readonly exchange: (request: HnsControlObserverHsdPrivateRequest) => Promise<Response>;
}>;

function failed(outcome: "transport_error" | "aborted"): HnsControlObserverHsdTransportError {
  return new HnsControlObserverHsdTransportError(outcome);
}

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

async function readBoundedResponse(
  response: Response,
  responseMaxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw failed("aborted");
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const retainedLimit = responseMaxBytes + 1;
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let rejectAbort: ((reason: HnsControlObserverHsdTransportError) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(failed("aborted"));
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    while (retained < retainedLimit) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (part.done) break;
      const remaining = retainedLimit - retained;
      const chunk = part.value.slice(0, remaining);
      chunks.push(chunk);
      retained += chunk.byteLength;
      if (part.value.byteLength > remaining || retained === retainedLimit) {
        try {
          await reader.cancel();
        } catch {
          // The retained over-bound marker remains authoritative if the driver
          // closes its stream while cancellation is in flight.
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof HnsControlObserverHsdTransportError || signal.aborted) {
      throw failed("aborted");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      // An aborted read may still own the lock while cancellation settles.
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

async function exchangeBound(
  capability: HnsControlObserverHsdPrivateCapability,
  request: HnsControlObserverHsdPrivateRequest,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw failed("aborted");
  let rejectAbort: ((reason: HnsControlObserverHsdTransportError) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(failed("aborted"));
  signal.addEventListener("abort", abort, { once: true });
  let exchangePromise: Promise<Response>;
  try {
    exchangePromise = capability.exchange(request);
  } catch (error) {
    signal.removeEventListener("abort", abort);
    throw error;
  }
  void exchangePromise.then(
    (response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => undefined);
    },
    () => undefined,
  );
  try {
    return await Promise.race([exchangePromise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", abort);
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
      if (request.signal.aborted) throw failed("aborted");
      if (
        !pinnedDriverReference ||
        request.driver_reference !== input.driver_reference ||
        !canonicalDriverRequest(request.method, request.request_bytes) ||
        !Number.isSafeInteger(request.response_max_bytes) ||
        request.response_max_bytes < 1 ||
        request.response_max_bytes > HSD_RESPONSE_MAX_BYTES
      ) {
        throw failed("transport_error");
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
        if (request.signal.aborted) throw failed("aborted");
        return {
          status: response.status,
          content_type: response.headers.get("content-type"),
          response_bytes: responseBytes,
        };
      } catch (error) {
        if (error instanceof HnsControlObserverHsdTransportError) throw error;
        throw failed(request.signal.aborted ? "aborted" : "transport_error");
      }
    },
  };
}
