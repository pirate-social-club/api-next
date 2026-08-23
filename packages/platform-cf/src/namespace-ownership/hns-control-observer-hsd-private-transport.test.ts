import { describe, expect, test } from "bun:test";
import { HnsControlObserverHsdTransportError } from "@pirate/application/namespace-ownership";
import {
  type HnsControlObserverHsdPrivateCapability,
  type HnsControlObserverHsdPrivateRequest,
  makeHnsControlObserverHsdPrivateTransport,
} from "./hns-control-observer-hsd-private-transport.ts";

const encoder = new TextEncoder();
const driverReference = "hsd-json-rpc:regtest-primary";

function rpcBytes(
  method: "getblockchaininfo" | "getblockheader" | "getnameinfo" | "getnameresource",
  params: ReadonlyArray<unknown> = [],
): Uint8Array {
  return encoder.encode(JSON.stringify({ method, params }));
}

function exchange(
  capability: HnsControlObserverHsdPrivateCapability,
  overrides: Partial<{
    readonly driver_reference: string;
    readonly method: "getblockchaininfo" | "getblockheader" | "getnameinfo" | "getnameresource";
    readonly request_bytes: Uint8Array;
    readonly response_max_bytes: number;
    readonly signal: AbortSignal;
  }> = {},
) {
  const method = overrides.method ?? "getblockchaininfo";
  return makeHnsControlObserverHsdPrivateTransport({
    driver_reference: driverReference,
    capability,
  }).exchange({
    driver_reference: overrides.driver_reference ?? driverReference,
    method,
    request_bytes: overrides.request_bytes ?? rpcBytes(method),
    response_max_bytes: overrides.response_max_bytes ?? 1_048_576,
    signal: overrides.signal ?? new AbortController().signal,
  });
}

describe("HNS control-observer private HSD transport", () => {
  test("posts exact canonical RPC bytes through the closed private capability", async () => {
    const calls: HnsControlObserverHsdPrivateRequest[] = [];
    const responseBytes = encoder.encode('{"result":{"chain":"regtest"},"error":null,"id":null}');
    const result = await exchange({
      exchange: async (request) => {
        calls.push(request);
        return new Response(responseBytes, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
    ]);
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect([...(calls[0]?.body ?? [])]).toEqual([...rpcBytes("getblockchaininfo")]);
    expect(result).toEqual({
      status: 200,
      content_type: "application/json; charset=utf-8",
      response_bytes: responseBytes,
    });
    expect(result.response_bytes).not.toBe(responseBytes);
  });

  test("fails locally for an unpinned driver, malformed RPC bytes, or invalid bound", async () => {
    let calls = 0;
    const capability = {
      exchange: async () => {
        calls += 1;
        return new Response("not reached");
      },
    };
    const invalid = [
      { driver_reference: "hsd-json-rpc:other" },
      { request_bytes: encoder.encode('{"params":[],"method":"getblockchaininfo"}') },
      { request_bytes: encoder.encode('{"method":"getblockchaininfo","params":[1]}') },
      {
        method: "getblockheader" as const,
        request_bytes: rpcBytes("getblockheader", []),
      },
      {
        method: "getblockheader" as const,
        request_bytes: rpcBytes("getblockheader", ["a".repeat(64), false]),
      },
      {
        method: "getblockheader" as const,
        request_bytes: rpcBytes("getblockheader", ["A".repeat(64), true]),
      },
      {
        method: "getnameinfo" as const,
        request_bytes: rpcBytes("getnameinfo", []),
      },
      {
        method: "getnameinfo" as const,
        request_bytes: rpcBytes("getnameinfo", ["Jazleeuw", false]),
      },
      {
        method: "getnameresource" as const,
        request_bytes: rpcBytes("getnameresource", ["jazleeuw", true]),
      },
      { request_bytes: encoder.encode('{"method":"getblockchaininfo","params":[]} ') },
      { response_max_bytes: 0 },
      { response_max_bytes: 1_048_577 },
    ];
    for (const overrides of invalid) {
      await expect(exchange(capability, overrides)).rejects.toMatchObject({
        name: "HnsControlObserverHsdTransportError",
        outcome: "transport_error",
      });
    }
    expect(calls).toBe(0);

    const invalidPinned = makeHnsControlObserverHsdPrivateTransport({
      driver_reference: "not-a-driver-reference",
      capability,
    });
    await expect(
      invalidPinned.exchange({
        driver_reference: "not-a-driver-reference",
        method: "getblockchaininfo",
        request_bytes: rpcBytes("getblockchaininfo"),
        response_max_bytes: 1_048_576,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ outcome: "transport_error" });
    expect(calls).toBe(0);
  });

  test("accepts only the five source-closed RPC parameter families", async () => {
    let calls = 0;
    const capability = {
      exchange: async () => {
        calls += 1;
        return new Response('{"result":{},"error":null,"id":null}', {
          headers: { "content-type": "application/json" },
        });
      },
    };
    await exchange(capability);
    await exchange(capability, {
      method: "getblockheader",
      request_bytes: rpcBytes("getblockheader", ["a".repeat(64), true]),
    });
    await exchange(capability, {
      method: "getblockheader",
      request_bytes: rpcBytes("getblockheader", ["b".repeat(64), true]),
    });
    await exchange(capability, {
      method: "getnameinfo",
      request_bytes: rpcBytes("getnameinfo", ["tame_impala", false]),
    });
    await exchange(capability, {
      method: "getnameresource",
      request_bytes: rpcBytes("getnameresource", ["xn--mnchen-3ya", false]),
    });
    expect(calls).toBe(5);
  });

  test("retains one over-bound byte and cancels the response stream", async () => {
    let cancelled = false;
    const result = await exchange(
      {
        exchange: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 503, headers: { "content-type": "text/plain" } },
          ),
      },
      { response_max_bytes: 4 },
    );
    expect(result).toEqual({
      status: 503,
      content_type: "text/plain",
      response_bytes: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(cancelled).toBe(true);
  });

  test("maps capability and stream failures without retry or global-fetch fallback", async () => {
    let calls = 0;
    await expect(
      exchange({
        exchange: async () => {
          calls += 1;
          throw new Error("private capability unavailable");
        },
      }),
    ).rejects.toMatchObject({ outcome: "transport_error" });
    expect(calls).toBe(1);

    await expect(
      exchange({
        exchange: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("driver stream failed"));
              },
            }),
          ),
      }),
    ).rejects.toMatchObject({ outcome: "transport_error" });
  });

  test("rejects before fetch when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      exchange(
        {
          exchange: async () => {
            calls += 1;
            return new Response("not reached");
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toEqual(new HnsControlObserverHsdTransportError("aborted"));
    expect(calls).toBe(0);
  });

  test("aborts a response read promptly and retains no late bytes", async () => {
    const controller = new AbortController();
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const result = exchange(
      {
        exchange: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(streamController) {
                markReadStarted?.();
                await new Promise<void>((resolve) => {
                  releaseRead = resolve;
                });
                try {
                  streamController.enqueue(new Uint8Array([9, 9, 9]));
                  streamController.close();
                } catch {
                  // Cancellation won the race; no late byte becomes authority.
                }
              },
            }),
          ),
      },
      { signal: controller.signal },
    );
    await readStarted;
    controller.abort();
    await expect(result).rejects.toMatchObject({ outcome: "aborted" });
    releaseRead?.();
  });

  test("aborts promptly while a private exchange ignores its signal", async () => {
    const controller = new AbortController();
    let finishFetch: ((response: Response) => void) | undefined;
    const result = exchange(
      {
        exchange: () =>
          new Promise<Response>((resolve) => {
            finishFetch = resolve;
          }),
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ outcome: "aborted" });
    finishFetch?.(new Response("late"));
  });
});
