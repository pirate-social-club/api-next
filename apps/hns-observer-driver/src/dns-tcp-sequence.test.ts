import { afterEach, describe, expect, test } from "bun:test";
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  exchangeDirectHnsDnsTcpSequence,
  type HnsDnsTcpConnector,
  HnsObserverDriverExchangeError,
} from "./dns-tcp.ts";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function connector(port: number): HnsDnsTcpConnector {
  return {
    connect: async (input) =>
      await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
        input.signal.addEventListener("abort", () => socket.destroy(), { once: true });
      }),
  };
}

function frame(bytes: Uint8Array): Uint8Array {
  return new Uint8Array([bytes.byteLength >>> 8, bytes.byteLength & 0xff, ...bytes]);
}

function exchange(
  port: number,
  overrides: Partial<Parameters<typeof exchangeDirectHnsDnsTcpSequence>[0]> = {},
) {
  return exchangeDirectHnsDnsTcpSequence({
    connector: connector(port),
    host: "127.0.0.1",
    family: 4,
    request_bytes: new Uint8Array([1, 2, 3]),
    response_message_max_bytes: 65_535,
    response_total_max_bytes: 1_048_576,
    response_max_messages: 64,
    is_complete: (message) => message[0] === 3,
    timeout_ms: 1_000,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe("bounded DNS-over-TCP message sequence acquisition", () => {
  test("retains exact messages across fragmented prefixes and coalesced frames", async () => {
    const requests: Uint8Array[] = [];
    const server = createServer((socket) => {
      socket.once("data", (request) => {
        requests.push(
          Uint8Array.from(typeof request === "string" ? Buffer.from(request) : request),
        );
        const first = frame(new Uint8Array([1, 10, 11]));
        const second = frame(new Uint8Array([2, 20]));
        const third = frame(new Uint8Array([3, 30, 31, 32]));
        socket.write(first.subarray(0, 1));
        socket.write(new Uint8Array([...first.subarray(1), ...second, ...third.subarray(0, 3)]));
        socket.write(third.subarray(3));
      });
    });
    const port = await listen(server);

    expect(await exchange(port)).toEqual([
      new Uint8Array([1, 10, 11]),
      new Uint8Array([2, 20]),
      new Uint8Array([3, 30, 31, 32]),
    ]);
    expect(requests).toEqual([new Uint8Array([0, 3, 1, 2, 3])]);
  });

  test("refuses EOF before the completion predicate accepts a message", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => socket.end(frame(new Uint8Array([1]))));
    });
    const port = await listen(server);

    await expect(exchange(port)).rejects.toMatchObject({
      outcome: "upstream_protocol_error",
    });
  });

  test("refuses zero-length, oversized, over-count, and over-total sequences", async () => {
    const cases = [
      {
        bytes: new Uint8Array([0, 0]),
        overrides: {},
      },
      {
        bytes: frame(new Uint8Array([1, 2, 3])),
        overrides: { response_message_max_bytes: 2, response_total_max_bytes: 2 },
      },
      {
        bytes: new Uint8Array([...frame(new Uint8Array([1])), ...frame(new Uint8Array([2]))]),
        overrides: { response_max_messages: 1 },
      },
      {
        bytes: new Uint8Array([...frame(new Uint8Array([1, 2])), ...frame(new Uint8Array([2, 3]))]),
        overrides: { response_message_max_bytes: 2, response_total_max_bytes: 3 },
      },
    ] as const;

    for (const current of cases) {
      const server = createServer((socket) => {
        socket.once("data", () => socket.write(current.bytes));
      });
      const port = await listen(server);
      await expect(
        exchange(port, {
          is_complete: () => false,
          ...current.overrides,
        }),
      ).rejects.toMatchObject({ outcome: "upstream_protocol_error" });
    }
  });

  test("refuses bytes following the message declared terminal", async () => {
    const server = createServer((socket) => {
      socket.once("data", () =>
        socket.write(
          new Uint8Array([...frame(new Uint8Array([3])), ...frame(new Uint8Array([4]))]),
        ),
      );
    });
    const port = await listen(server);

    await expect(exchange(port)).rejects.toMatchObject({ outcome: "upstream_protocol_error" });
  });

  test("maps an arbitrary throwing completion decoder to a protocol refusal", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => socket.write(frame(new Uint8Array([1]))));
    });
    const port = await listen(server);

    await expect(
      exchange(port, {
        is_complete: () => {
          throw new Error("malformed terminal message");
        },
      }),
    ).rejects.toMatchObject({ outcome: "upstream_protocol_error" });
  });

  test("preserves a typed authentication failure from the completion decoder", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => socket.write(frame(new Uint8Array([1]))));
    });
    const port = await listen(server);

    await expect(
      exchange(port, {
        is_complete: () => {
          throw new HnsObserverDriverExchangeError("authentication_failed");
        },
      }),
    ).rejects.toMatchObject({ outcome: "authentication_failed" });
  });

  test("enforces one deadline across connect, write, and the entire sequence", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => socket.write(frame(new Uint8Array([1]))));
    });
    const port = await listen(server);

    await expect(exchange(port, { timeout_ms: 10 })).rejects.toMatchObject({ outcome: "timeout" });
  });

  test("refuses a deadline beyond the bounded acquisition policy", async () => {
    await expect(exchange(1, { timeout_ms: 12_001 })).rejects.toMatchObject({
      outcome: "upstream_protocol_error",
    });
  });
});
