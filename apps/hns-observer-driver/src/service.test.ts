import { describe, expect, test } from "bun:test";
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  buildHnsAuthoritativeDnsQueryV1,
  decodeHnsPrivateDriverErrorV1,
  encodeHnsPrivateDriverRequestV1,
  HNS_PRIVATE_DRIVER_DNS_PATH,
  HNS_PRIVATE_DRIVER_HSD_PATH,
  HNS_PRIVATE_DRIVER_ORIGIN,
  HNS_PRIVATE_DRIVER_PROTOCOL,
  HNS_PRIVATE_DRIVER_PROTOCOL_HEADER,
} from "@pirate/application/namespace-ownership";
import type { HnsDnsTcpConnector } from "./dns-tcp.ts";
import { makeHnsObserverDriverHsdHttpCapability } from "./hsd-http.ts";
import { makeHnsObserverDriverService } from "./service.ts";

const encoder = new TextEncoder();
const hsdBody = encoder.encode('{"method":"getblockchaininfo","params":[]}');
const dnsBody = buildHnsAuthoritativeDnsQueryV1({
  message_id: 11,
  query_kind: "dnskey",
  root_label: "regtest",
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function redirectedConnector(name: string, port: number, calls: string[]): HnsDnsTcpConnector {
  return {
    connect: async (request) => {
      calls.push(`${name}:${request.host}:${request.port}:${request.family}`);
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
        request.signal.addEventListener("abort", () => socket.destroy(), { once: true });
      });
    },
  };
}

function driverRequest(path: string, accept: string, body: Uint8Array): Request {
  return new Request(`${HNS_PRIVATE_DRIVER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      [HNS_PRIVATE_DRIVER_PROTOCOL_HEADER]: HNS_PRIVATE_DRIVER_PROTOCOL,
    },
    body,
  });
}

function dnsEnvelope(viewId: string, responseMaxBytes = 65_535, timeoutMs = 2_000): Uint8Array {
  return encodeHnsPrivateDriverRequestV1({
    exchange_kind: "authoritative_dns_tcp",
    driver_reference: "authoritative-dns:regtest",
    view_id: viewId,
    query_kind: "dnskey",
    root_label: "regtest",
    chain_authority_digest: "1".repeat(64),
    authority_nameserver: "ns1.regtest",
    authority_address_family: "GLUE4",
    authority_address: "127.0.0.1",
    request_bytes: dnsBody,
    response_max_bytes: responseMaxBytes,
    timeout_ms: timeoutMs,
  });
}

function serviceWithViews(connectors: readonly [HnsDnsTcpConnector, HnsDnsTcpConnector]) {
  return makeHnsObserverDriverService({
    hsd_driver_reference: "hsd-json-rpc:regtest-primary",
    dns_driver_reference: "authoritative-dns:regtest",
    hsd: {
      exchange: async () => ({
        status: 200,
        content_type: "application/json",
        response_bytes: encoder.encode('{"result":{},"error":null,"id":null}'),
      }),
    },
    dns_views: [
      {
        view_id: "dns-view-a",
        vantage_reference: "regtest-egress:view-a",
        connector: connectors[0],
      },
      {
        view_id: "dns-view-b",
        vantage_reference: "regtest-egress:view-b",
        connector: connectors[1],
      },
    ],
  });
}

describe("target-owned HNS observer driver service", () => {
  test("uses two independent views against one regtest authority with exact TCP frames", async () => {
    const frames: Uint8Array[] = [];
    const responseBytes = new Uint8Array([9, 8, 7, 6]);
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        frames.push(new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
        socket.end(
          new Uint8Array([
            responseBytes.byteLength >>> 8,
            responseBytes.byteLength & 0xff,
            ...responseBytes,
          ]),
        );
      });
    });
    const port = await listen(server);
    const calls: string[] = [];
    const service = serviceWithViews([
      redirectedConnector("a", port, calls),
      redirectedConnector("b", port, calls),
    ]);
    try {
      for (const view of ["dns-view-a", "dns-view-b"]) {
        const response = await service.fetch(
          driverRequest(HNS_PRIVATE_DRIVER_DNS_PATH, "application/dns-message", dnsEnvelope(view)),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/dns-message");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
      }
    } finally {
      await close(server);
    }

    expect(calls).toEqual(["a:127.0.0.1:53:4", "b:127.0.0.1:53:4"]);
    const framed = new Uint8Array([
      dnsBody.byteLength >>> 8,
      dnsBody.byteLength & 0xff,
      ...dnsBody,
    ]);
    expect(frames).toEqual([framed, framed]);
  });

  test("returns the exact max-plus-one DNS capacity marker", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(new Uint8Array([0, 7, 1, 2, 3, 4, 5, 6, 7]));
      });
    });
    const port = await listen(server);
    const calls: string[] = [];
    const connector = redirectedConnector("a", port, calls);
    const service = serviceWithViews([connector, redirectedConnector("b", port, calls)]);
    try {
      const response = await service.fetch(
        driverRequest(
          HNS_PRIVATE_DRIVER_DNS_PATH,
          "application/dns-message",
          dnsEnvelope("dns-view-a", 4),
        ),
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    } finally {
      await close(server);
    }
    expect(calls).toHaveLength(1);
  });

  test("does not retry a closed authority and maps it to unavailable", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.once("data", () => socket.destroy());
    });
    const port = await listen(server);
    const calls: string[] = [];
    const service = serviceWithViews([
      redirectedConnector("a", port, calls),
      redirectedConnector("b", port, calls),
    ]);
    try {
      const response = await service.fetch(
        driverRequest(
          HNS_PRIVATE_DRIVER_DNS_PATH,
          "application/dns-message",
          dnsEnvelope("dns-view-a"),
        ),
      );
      expect(response.status).toBe(502);
      expect(
        decodeHnsPrivateDriverErrorV1(
          response.status,
          new Uint8Array(await response.arrayBuffer()),
        ),
      ).toMatchObject({ error: "upstream_protocol_error" });
    } finally {
      await close(server);
    }
    expect(connections).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("enforces the wire deadline even when a connector ignores abort", async () => {
    let calls = 0;
    const unresolved: HnsDnsTcpConnector = {
      connect: () => {
        calls += 1;
        return new Promise<Socket>(() => undefined);
      },
    };
    const service = serviceWithViews([unresolved, unresolved]);
    const response = await service.fetch(
      driverRequest(
        HNS_PRIVATE_DRIVER_DNS_PATH,
        "application/dns-message",
        dnsEnvelope("dns-view-a", 65_535, 10),
      ),
    );
    expect(response.status).toBe(504);
    expect(
      decodeHnsPrivateDriverErrorV1(response.status, new Uint8Array(await response.arrayBuffer())),
    ).toMatchObject({ error: "timeout" });
    expect(calls).toBe(1);
  });

  test("rejects malformed envelopes and mismatched identity before upstream work", async () => {
    let calls = 0;
    const connector: HnsDnsTcpConnector = {
      connect: async () => {
        calls += 1;
        throw new Error("not reached");
      },
    };
    const service = serviceWithViews([connector, connector]);
    const valid = JSON.parse(new TextDecoder().decode(dnsEnvelope("dns-view-a"))) as Record<
      string,
      unknown
    >;
    for (const body of [
      encoder.encode(JSON.stringify({ ...valid, driver_reference: "authoritative-dns:other" })),
      encoder.encode(JSON.stringify({ ...valid, view_id: "dns-view-c" })),
      encoder.encode(JSON.stringify({ ...valid, authority_address: "regtest.invalid" })),
      encoder.encode(JSON.stringify({ ...valid, unknown: true })),
    ]) {
      const response = await service.fetch(
        driverRequest(HNS_PRIVATE_DRIVER_DNS_PATH, "application/dns-message", body),
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("fails configuration before listening when view independence is incomplete", () => {
    const connector: HnsDnsTcpConnector = {
      connect: async () => {
        throw new Error("not reached");
      },
    };
    expect(() =>
      makeHnsObserverDriverService({
        hsd_driver_reference: "hsd-json-rpc:regtest-primary",
        dns_driver_reference: "authoritative-dns:regtest",
        hsd: {
          exchange: async () => ({
            status: 200,
            content_type: null,
            response_bytes: new Uint8Array(),
          }),
        },
        dns_views: [
          { view_id: "dns-view-a", vantage_reference: "egress:same", connector },
          { view_id: "dns-view-b", vantage_reference: "egress:same", connector },
        ],
      }),
    ).toThrow();
  });

  test("forwards exact HSD bytes once through the closed local HTTP capability", async () => {
    const calls: Request[] = [];
    const service = makeHnsObserverDriverService({
      hsd_driver_reference: "hsd-json-rpc:regtest-primary",
      dns_driver_reference: "authoritative-dns:regtest",
      hsd: makeHnsObserverDriverHsdHttpCapability({
        endpoint: "http://127.0.0.1:14037/",
        authorization: "Basic cmVndGVzdDpyZWd0ZXN0",
        fetcher: async (request) => {
          calls.push(request as Request);
          return new Response('{"result":{"chain":"regtest"},"error":null,"id":null}', {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        },
      }),
      dns_views: [
        {
          view_id: "dns-view-a",
          vantage_reference: "regtest-egress:view-a",
          connector: { connect: async () => Promise.reject(new Error("not reached")) },
        },
        {
          view_id: "dns-view-b",
          vantage_reference: "regtest-egress:view-b",
          connector: { connect: async () => Promise.reject(new Error("not reached")) },
        },
      ],
    });
    const body = encodeHnsPrivateDriverRequestV1({
      exchange_kind: "hsd_json_rpc",
      driver_reference: "hsd-json-rpc:regtest-primary",
      request_bytes: hsdBody,
      response_max_bytes: 1_048_576,
      timeout_ms: 2_000,
    });
    const response = await service.fetch(
      driverRequest(HNS_PRIVATE_DRIVER_HSD_PATH, "application/octet-stream", body),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const forwarded = calls[0];
    if (forwarded === undefined) throw new Error("expected one forwarded HSD request");
    expect(forwarded.url).toBe("http://127.0.0.1:14037/");
    expect(forwarded.headers.get("authorization")).toBe("Basic cmVndGVzdDpyZWd0ZXN0");
    expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(hsdBody);
    expect(response.headers.get("pirate-hns-driver-upstream-status")).toBe("200");
  });

  test("enforces the HSD deadline when the local fetcher does not settle", async () => {
    let calls = 0;
    const service = makeHnsObserverDriverService({
      hsd_driver_reference: "hsd-json-rpc:regtest-primary",
      dns_driver_reference: "authoritative-dns:regtest",
      hsd: makeHnsObserverDriverHsdHttpCapability({
        endpoint: "http://127.0.0.1:14037/",
        authorization: "Basic cmVndGVzdDpyZWd0ZXN0",
        fetcher: () => {
          calls += 1;
          return new Promise<Response>(() => undefined);
        },
      }),
      dns_views: [
        {
          view_id: "dns-view-a",
          vantage_reference: "regtest-egress:view-a",
          connector: { connect: async () => Promise.reject(new Error("not reached")) },
        },
        {
          view_id: "dns-view-b",
          vantage_reference: "regtest-egress:view-b",
          connector: { connect: async () => Promise.reject(new Error("not reached")) },
        },
      ],
    });
    const body = encodeHnsPrivateDriverRequestV1({
      exchange_kind: "hsd_json_rpc",
      driver_reference: "hsd-json-rpc:regtest-primary",
      request_bytes: hsdBody,
      response_max_bytes: 1_048_576,
      timeout_ms: 10,
    });
    const response = await service.fetch(
      driverRequest(HNS_PRIVATE_DRIVER_HSD_PATH, "application/octet-stream", body),
    );
    expect(response.status).toBe(504);
    expect(calls).toBe(1);
  });
});
