/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  buildHnsAuthoritativeDnsQueryV1,
  decodeHnsPrivateDriverRequestV1,
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
} from "@pirate/platform-cf/namespace-ownership-hns-private-driver-transport";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();

function headers(contentType: string, extra: Record<string, string> = {}) {
  return {
    "Content-Type": contentType,
    [HNS_PRIVATE_DRIVER_PROTOCOL_HEADER]: HNS_PRIVATE_DRIVER_PROTOCOL,
    ...extra,
  };
}

describe("HNS private-driver transport (workerd)", () => {
  it("retains exact HSD and ordered two-view DNS bytes", async () => {
    const calls: Array<ReturnType<typeof decodeHnsPrivateDriverRequestV1>["request"]> = [];
    const dnsResponse = new Uint8Array([1, 2, 3, 4]);
    const binding: HnsPrivateDriverBinding = {
      fetch: async (input) => {
        const request = input as Request;
        const decoded = decodeHnsPrivateDriverRequestV1(
          new Uint8Array(await request.arrayBuffer()),
        );
        calls.push(decoded.request);
        if (decoded.request.exchange_kind === "hsd_json_rpc") {
          return new Response('{"result":{"chain":"regtest"},"error":null,"id":null}', {
            headers: headers("application/octet-stream", {
              [HNS_PRIVATE_DRIVER_UPSTREAM_STATUS_HEADER]: "200",
              [HNS_PRIVATE_DRIVER_UPSTREAM_CONTENT_TYPE_HEADER]:
                encodeHnsPrivateDriverUpstreamContentType("application/json"),
            }),
          });
        }
        return new Response(dnsResponse, { headers: headers("application/dns-message") });
      },
    };
    const hsdBody = encoder.encode('{"method":"getblockchaininfo","params":[]}');
    const hsd = await makeHnsControlObserverHsdPrivateDriverCapability({
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
      signal: new AbortController().signal,
    });
    expect(new Uint8Array(await hsd.arrayBuffer())).toEqual(
      encoder.encode('{"result":{"chain":"regtest"},"error":null,"id":null}'),
    );

    const transport = makeHnsAuthoritativeDnsPrivateDriverTransport({
      binding,
      driver_reference: "authoritative-dns:regtest",
      timeout_ms: 4_000,
    });
    for (const [index, view] of ["dns-view-a", "dns-view-b"].entries()) {
      const requestBytes = buildHnsAuthoritativeDnsQueryV1({
        message_id: index + 1,
        query_kind: "dnskey",
        root_label: "regtest",
      });
      await expect(
        transport.exchange({
          driver_reference: "authoritative-dns:regtest",
          view_id: view,
          query_kind: "dnskey",
          root_label: "regtest",
          authority_records: [
            ["NS", "ns1.regtest"],
            ["GLUE4", "ns1.regtest", "192.0.2.53"],
          ],
          chain_authority_digest: "1".repeat(64),
          authority_nameserver: "ns1.regtest",
          authority_address_family: "GLUE4",
          authority_address: "192.0.2.53",
          request_bytes: requestBytes,
          response_max_bytes: 65_535,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(dnsResponse);
    }
    expect(calls.map((call) => call.exchange_kind)).toEqual([
      "hsd_json_rpc",
      "authoritative_dns_tcp",
      "authoritative_dns_tcp",
    ]);
    expect(calls.slice(1).map((call) => ("view_id" in call ? call.view_id : null))).toEqual([
      "dns-view-a",
      "dns-view-b",
    ]);
  });

  it("does not retry malformed driver responses and gives abort precedence", async () => {
    let calls = 0;
    const transport = makeHnsAuthoritativeDnsPrivateDriverTransport({
      binding: {
        fetch: async () => {
          calls += 1;
          return new Response(new Uint8Array([1]), {
            headers: headers("application/dns-message", {
              "Pirate-HNS-Driver-Unexpected": "true",
            }),
          });
        },
      },
      driver_reference: "authoritative-dns:regtest",
      timeout_ms: 4_000,
    });
    const requestBytes = buildHnsAuthoritativeDnsQueryV1({
      message_id: 1,
      query_kind: "dnskey",
      root_label: "regtest",
    });
    const base = {
      driver_reference: "authoritative-dns:regtest",
      view_id: "dns-view-a",
      query_kind: "dnskey" as const,
      root_label: "regtest",
      authority_records: [
        ["NS", "ns1.regtest"],
        ["GLUE4", "ns1.regtest", "192.0.2.53"],
      ] as const,
      chain_authority_digest: "1".repeat(64),
      authority_nameserver: "ns1.regtest",
      authority_address_family: "GLUE4" as const,
      authority_address: "192.0.2.53",
      request_bytes: requestBytes,
      response_max_bytes: 65_535,
    };
    await expect(
      transport.exchange({ ...base, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ outcome: "transport_error" });
    expect(calls).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(transport.exchange({ ...base, signal: controller.signal })).rejects.toMatchObject({
      outcome: "aborted",
    });
    expect(calls).toBe(1);
  });
});
