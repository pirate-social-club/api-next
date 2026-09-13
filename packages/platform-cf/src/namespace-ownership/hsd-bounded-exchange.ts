import { HnsControlObserverHsdTransportError } from "@pirate/application/namespace-ownership";

/**
 * Shared HSD transport mechanics used by the private observer transport and
 * the provisioner's read-only incident calls: bounded response reads and
 * abort-aware exchange. Endpoint selection, authentication and result
 * semantics stay with each caller; only the bounded/abort machinery is shared.
 */

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

export function hsdTransportFailure(
  outcome: "transport_error" | "aborted",
): HnsControlObserverHsdTransportError {
  return new HnsControlObserverHsdTransportError(outcome);
}

export async function readBoundedResponse(
  response: Response,
  responseMaxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw hsdTransportFailure("aborted");
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
    rejectAbort?.(hsdTransportFailure("aborted"));
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
      throw hsdTransportFailure("aborted");
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

export async function exchangeBound(
  capability: HnsControlObserverHsdPrivateCapability,
  request: HnsControlObserverHsdPrivateRequest,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) throw hsdTransportFailure("aborted");
  let rejectAbort: ((reason: HnsControlObserverHsdTransportError) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(hsdTransportFailure("aborted"));
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
