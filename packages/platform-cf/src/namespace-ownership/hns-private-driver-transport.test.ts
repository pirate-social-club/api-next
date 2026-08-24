import { describe, expect, test } from "bun:test";
import {
  buildHnsAuthoritativeDnsQueryV1,
  decodeHnsPrivateDriverRequestV1,
  encodeHnsPrivateDriverErrorV1,
  encodeHnsPrivateDriverUpstreamContentType,
  HNS_PRIVATE_DRIVER_PROTOCOL,
  HNS_PRIVATE_DRIVER_PROTOCOL_HEADER,
  HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER,
  HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER,
} from "@pirate/application/namespace-ownership";
import {
  type HnsPrivateDriverBinding,
  makeHnsAuthoritativeDnsPrivateDriverTransport,
  makeHnsControlObserverHsdPrivateDriverCapability,
} from "./hns-private-driver-transport.ts";

const encoder = new TextEncoder();
const hsdBody = encoder.encode('{"method":"getblockchaininfo","params":[]}');
const dnsBody = buildHnsAuthoritativeDnsQueryV1({
  message_id: 7,
  query_kind: "dnskey",
  root_label: "regtest",
});

function hsdExchange(binding: HnsPrivateDriverBinding, signal = new AbortController().signal) {
  return makeHnsControlObserverHsdPrivateDriverCapability({
    binding,
    driver_reference: "hsd-json-rpc:regtest-primary",
    timeout_ms: 4_000,
  }).exchange({
    method: "POST",
    headers: [
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
    ],
    body: hsdBody,
    response_max_bytes: 1_048_576,
    redirect: "manual",
    signal,
  });
}

function dnsExchange(
  binding: HnsPrivateDriverBinding,
  overrides: Partial<{ readonly response_max_bytes: number; readonly signal: AbortSignal }> = {},
) {
  return makeHnsAuthoritativeDnsPrivateDriverTransport({
    binding,
    driver_reference: "authoritative-dns:regtest",
    timeout_ms: 4_000,
  }).exchange({
    driver_reference: "authoritative-dns:regtest",
    view_id: "dns-view-a",
    query_kind: "dnskey",
    root_label: "regtest",
    authority_records: [
      ["NS", "ns1.regtest"],
      ["GLUE4", "ns1.regtest", "192.0.2.53"],
      ["DS", 1, 13, 2, "1".repeat(64)],
    ],
    chain_authority_digest: "1".repeat(64),
    authority_nameserver: "ns1.regtest",
    authority_address_family: "GLUE4",
    authority_address: "192.0.2.53",
    request_bytes: dnsBody,
    response_max_bytes: overrides.response_max_bytes ?? 65_535,
    signal: overrides.signal ?? new AbortController().signal,
  });
}

function protocolHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [HNS_PRIVATE_DRIVER_PROTOCOL_HEADER]: HNS_PRIVATE_DRIVER_PROTOCOL,
    ...extra,
  };
}

describe("HNS private-driver Worker transports", () => {
  test("sends one exact fixed HSD request and restores the upstream response metadata", async () => {
    const requests: Request[] = [];
    const responseBytes = encoder.encode('{"result":{"chain":"regtest"},"error":null,"id":null}');
    const response = await hsdExchange({
      fetch: async (request) => {
        const captured = request as Request;
        requests.push(captured);
        const decoded = decodeHnsPrivateDriverRequestV1(
          new Uint8Array(await captured.arrayBuffer()),
        );
        expect(decoded.request).toMatchObject({
          exchange_kind: "hsd_json_rpc",
          driver_reference: "hsd-json-rpc:regtest-primary",
          response_max_bytes: 1_048_576,
          timeout_ms: 4_000,
        });
        expect(decoded.request_bytes).toEqual(hsdBody);
        return new Response(responseBytes, {
          headers: protocolHeaders({
            "Content-Type": "application/octet-stream",
            [HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER]: "200",
            [HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER]:
              encodeHnsPrivateDriverUpstreamContentType("application/json; charset=utf-8"),
          }),
        });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://hns-observer-driver.internal/internal/hns-observer-driver/v1/hsd",
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.redirect).toBe("manual");
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.headers.get("accept")).toBe("application/octet-stream");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
  });

  test("sends exact DNS bytes once and retains only the capacity marker", async () => {
    let calls = 0;
    let cancelled = false;
    const result = await dnsExchange(
      {
        fetch: async (request) => {
          calls += 1;
          const captured = request as Request;
          const decoded = decodeHnsPrivateDriverRequestV1(
            new Uint8Array(await captured.arrayBuffer()),
          );
          expect(captured.url).toBe(
            "http://hns-observer-driver.internal/internal/hns-observer-driver/v1/authoritative-dns",
          );
          expect(captured.headers.get("accept")).toBe("application/dns-message");
          expect(decoded.request).toMatchObject({
            exchange_kind: "authoritative_dns_tcp",
            driver_reference: "authoritative-dns:regtest",
            view_id: "dns-view-a",
            query_kind: "dnskey",
            root_label: "regtest",
            authority_address: "192.0.2.53",
            timeout_ms: 4_000,
          });
          expect(decoded.request_bytes).toEqual(dnsBody);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: protocolHeaders({ "Content-Type": "application/dns-message" }),
            },
          );
        },
      },
      { response_max_bytes: 4 },
    );
    expect(calls).toBe(1);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(cancelled).toBe(true);
  });

  test("maps only the exact timeout envelope to timeout and never retries", async () => {
    for (const [status, error, outcome] of [
      [504, "timeout", "timeout"],
      [503, "upstream_unavailable", "transport_error"],
      [502, "upstream_protocol_error", "transport_error"],
    ] as const) {
      let calls = 0;
      await expect(
        dnsExchange({
          fetch: async () => {
            calls += 1;
            return new Response(encodeHnsPrivateDriverErrorV1(error), {
              status,
              headers: protocolHeaders({ "Content-Type": "application/json" }),
            });
          },
        }),
      ).rejects.toMatchObject({ outcome });
      expect(calls).toBe(1);
    }
  });

  test("rejects malformed successes, error mismatches, and unexpected owned headers", async () => {
    const responses = [
      new Response(new Uint8Array([1]), {
        headers: protocolHeaders({ "Content-Type": "application/octet-stream" }),
      }),
      new Response(new Uint8Array([1]), {
        headers: protocolHeaders({
          "Content-Type": "application/dns-message",
          "Pirate-HNS-Driver-Unexpected": "true",
        }),
      }),
      new Response(encodeHnsPrivateDriverErrorV1("timeout"), {
        status: 503,
        headers: protocolHeaders({ "Content-Type": "application/json" }),
      }),
      new Response(new Uint8Array(), {
        headers: protocolHeaders({ "Content-Type": "application/dns-message" }),
      }),
    ];
    for (const response of responses) {
      await expect(dnsExchange({ fetch: async () => response })).rejects.toMatchObject({
        outcome: "transport_error",
      });
    }
  });

  test("gives an outer abort precedence over an unresolved binding fetch", async () => {
    const controller = new AbortController();
    const outcome = dnsExchange(
      { fetch: () => new Promise<Response>(() => undefined) },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ outcome: "aborted" });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let calls = 0;
    await expect(
      hsdExchange(
        {
          fetch: async () => {
            calls += 1;
            return new Response();
          },
        },
        alreadyAborted.signal,
      ),
    ).rejects.toMatchObject({ outcome: "aborted" });
    expect(calls).toBe(0);
  });
});
