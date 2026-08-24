import { HnsObserverDriverExchangeError } from "./dns-tcp.ts";

export type HnsObserverDriverHsdExchangeResult = Readonly<{
  readonly status: number;
  readonly content_type: string | null;
  readonly response_bytes: Uint8Array;
}>;

export type HnsObserverDriverHsdCapability = Readonly<{
  readonly exchange: (input: {
    readonly request_bytes: Uint8Array;
    readonly response_max_bytes: number;
    readonly timeout_ms: number;
    readonly signal: AbortSignal;
  }) => Promise<HnsObserverDriverHsdExchangeResult>;
}>;

export type HnsObserverDriverHttpFetch = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

async function readBounded(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let rejectAbort: ((reason: HnsObserverDriverExchangeError) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new HnsObserverDriverExchangeError("aborted"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (retained <= maximumBytes) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (part.done) break;
      const remaining = maximumBytes + 1 - retained;
      const chunk = part.value.slice(0, remaining);
      chunks.push(chunk);
      retained += chunk.byteLength;
      if (part.value.byteLength > remaining || retained > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may still own the reader while an abort is settling.
    }
  }
  const result = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function makeHnsObserverDriverHsdHttpCapability(input: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly fetcher: HnsObserverDriverHttpFetch;
}): HnsObserverDriverHsdCapability {
  if (!validEndpoint(input.endpoint) || input.authorization.length === 0) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const endpoint = input.endpoint;
  const authorization = input.authorization;
  return {
    exchange: async (request) => {
      const deadline = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        deadline.abort();
      }, request.timeout_ms);
      const abort = () => deadline.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      let responsePromise: Promise<Response> | undefined;
      try {
        if (request.signal.aborted) throw new HnsObserverDriverExchangeError("aborted");
        responsePromise = input.fetcher(
          new Request(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: authorization,
            },
            body: request.request_bytes,
            redirect: "manual",
            signal: deadline.signal,
          }),
        );
        const response = await Promise.race([
          responsePromise,
          new Promise<never>((_resolve, reject) => {
            deadline.signal.addEventListener(
              "abort",
              () => reject(new HnsObserverDriverExchangeError("aborted")),
              { once: true },
            );
          }),
        ]);
        void responsePromise.then(
          (lateResponse) => {
            if (deadline.signal.aborted) void lateResponse.body?.cancel().catch(() => undefined);
          },
          () => undefined,
        );
        const responseBytes = await readBounded(
          response,
          request.response_max_bytes,
          deadline.signal,
        );
        return {
          status: response.status,
          content_type: response.headers.get("content-type"),
          response_bytes: responseBytes,
        };
      } catch (error) {
        if (error instanceof HnsObserverDriverExchangeError && error.outcome !== "aborted") {
          throw error;
        }
        throw new HnsObserverDriverExchangeError(
          request.signal.aborted ? "aborted" : timedOut ? "timeout" : "upstream_unavailable",
        );
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
      }
    },
  };
}
