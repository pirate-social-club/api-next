import { createConnection, type Socket } from "node:net";

export type HnsDnsTcpConnectInput = Readonly<{
  readonly host: string;
  readonly port: 53;
  readonly family: 4 | 6;
  readonly signal: AbortSignal;
}>;

export type HnsDnsTcpConnector = Readonly<{
  readonly connect: (input: HnsDnsTcpConnectInput) => Promise<Socket>;
}>;

export type HnsDnsTcpExchangeInput = Readonly<{
  readonly connector: HnsDnsTcpConnector;
  readonly host: string;
  readonly family: 4 | 6;
  readonly request_bytes: Uint8Array;
  readonly response_max_bytes: number;
  readonly timeout_ms: number;
  readonly signal: AbortSignal;
}>;

export type HnsObserverDriverExchangeFailure =
  | "timeout"
  | "upstream_protocol_error"
  | "upstream_unavailable"
  | "aborted";

export class HnsObserverDriverExchangeError extends Error {
  readonly name = "HnsObserverDriverExchangeError";

  constructor(readonly outcome: HnsObserverDriverExchangeFailure) {
    super(outcome);
  }
}

function failed(outcome: HnsObserverDriverExchangeFailure): HnsObserverDriverExchangeError {
  return new HnsObserverDriverExchangeError(outcome);
}

function frameRequest(requestBytes: Uint8Array): Uint8Array {
  if (requestBytes.byteLength === 0 || requestBytes.byteLength > 65_535) {
    throw failed("upstream_protocol_error");
  }
  const framed = new Uint8Array(requestBytes.byteLength + 2);
  framed[0] = requestBytes.byteLength >>> 8;
  framed[1] = requestBytes.byteLength & 0xff;
  framed.set(requestBytes, 2);
  return framed;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = () => reject(failed("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function connectBound(
  connector: HnsDnsTcpConnector,
  input: HnsDnsTcpConnectInput,
): Promise<Socket> {
  const connection = connector.connect(input);
  void connection.then(
    (lateSocket) => {
      if (input.signal.aborted) lateSocket.destroy();
    },
    () => undefined,
  );
  return await Promise.race([connection, abortPromise(input.signal)]);
}

async function writeOneRequest(
  socket: Socket,
  framed: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw failed("aborted");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error === null || error === undefined) resolve();
      else reject(error);
    };
    const abort = () => {
      socket.destroy();
      finish(failed("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.write(framed, finish);
    if (signal.aborted) abort();
  });
}

async function readOneResponse(
  socket: Socket,
  responseMaxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    let prefix = new Uint8Array(2);
    let prefixBytes = 0;
    let expectedBytes: number | undefined;
    const retained = new Uint8Array(responseMaxBytes + 1);
    let retainedBytes = 0;
    let payloadBytes = 0;
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.off("data", data);
      socket.off("error", error);
      socket.off("end", ended);
      socket.off("close", closed);
    };
    const settleError = (outcome: HnsObserverDriverExchangeFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(failed(outcome));
    };
    const settleResponse = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      resolve(retained.slice(0, retainedBytes));
    };
    const abort = () => settleError("aborted");
    const error = () => settleError("upstream_unavailable");
    const ended = () => settleError("upstream_protocol_error");
    const closed = () => settleError("upstream_protocol_error");
    const data = (chunk: Buffer) => {
      let offset = 0;
      if (expectedBytes === undefined) {
        while (prefixBytes < 2 && offset < chunk.byteLength) {
          prefix[prefixBytes] = chunk[offset] ?? 0;
          prefixBytes += 1;
          offset += 1;
        }
        if (prefixBytes < 2) return;
        expectedBytes = ((prefix[0] ?? 0) << 8) | (prefix[1] ?? 0);
        prefix = new Uint8Array();
        if (expectedBytes === 0) {
          settleError("upstream_protocol_error");
          return;
        }
      }

      const available = chunk.byteLength - offset;
      payloadBytes += available;
      if (payloadBytes > expectedBytes) {
        settleError("upstream_protocol_error");
        return;
      }
      const retain = Math.min(available, retained.byteLength - retainedBytes);
      if (retain > 0) {
        retained.set(chunk.subarray(offset, offset + retain), retainedBytes);
        retainedBytes += retain;
      }
      if (expectedBytes > responseMaxBytes && retainedBytes === responseMaxBytes + 1) {
        settleResponse();
        return;
      }
      if (payloadBytes === expectedBytes) settleResponse();
    };

    signal.addEventListener("abort", abort, { once: true });
    socket.on("data", data);
    socket.once("error", error);
    socket.once("end", ended);
    socket.once("close", closed);
    if (signal.aborted) abort();
  });
}

export async function exchangeDirectHnsDnsTcp(input: HnsDnsTcpExchangeInput): Promise<Uint8Array> {
  if (
    input.signal.aborted ||
    !Number.isSafeInteger(input.response_max_bytes) ||
    input.response_max_bytes <= 0 ||
    input.response_max_bytes > 65_535 ||
    !Number.isSafeInteger(input.timeout_ms) ||
    input.timeout_ms <= 0
  ) {
    throw failed(input.signal.aborted ? "aborted" : "upstream_protocol_error");
  }
  const framed = frameRequest(input.request_bytes);
  const deadline = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, input.timeout_ms);
  const abort = () => deadline.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  let socket: Socket | undefined;
  try {
    socket = await connectBound(input.connector, {
      host: input.host,
      port: 53,
      family: input.family,
      signal: deadline.signal,
    });
    if (deadline.signal.aborted) throw failed(input.signal.aborted ? "aborted" : "timeout");
    await writeOneRequest(socket, framed, deadline.signal);
    return await readOneResponse(socket, input.response_max_bytes, deadline.signal);
  } catch (error) {
    socket?.destroy();
    if (error instanceof HnsObserverDriverExchangeError) {
      if (error.outcome === "aborted") {
        throw failed(
          input.signal.aborted ? "aborted" : timedOut ? "timeout" : "upstream_unavailable",
        );
      }
      throw error;
    }
    throw failed(input.signal.aborted ? "aborted" : timedOut ? "timeout" : "upstream_unavailable");
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abort);
  }
}

export function makeNodeHnsDnsTcpConnector(input: {
  readonly local_address: string;
}): HnsDnsTcpConnector {
  return {
    connect: async (request) =>
      await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({
          host: request.host,
          port: request.port,
          family: request.family,
          localAddress: input.local_address,
          signal: request.signal,
        });
        const connected = () => {
          socket.off("error", failedConnection);
          resolve(socket);
        };
        const failedConnection = (error: Error) => {
          socket.off("connect", connected);
          reject(error);
        };
        socket.once("connect", connected);
        socket.once("error", failedConnection);
      }),
  };
}
