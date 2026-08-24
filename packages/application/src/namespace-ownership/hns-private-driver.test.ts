import { describe, expect, test } from "bun:test";
import { buildHnsAuthoritativeDnsQueryV1 } from "./hns-authoritative-dns.ts";
import {
  decodeHnsPrivateDriverErrorV1,
  decodeHnsPrivateDriverRequestV1,
  decodeHnsPrivateDriverUpstreamContentType,
  encodeHnsPrivateDriverErrorV1,
  encodeHnsPrivateDriverRequestV1,
  encodeHnsPrivateDriverUpstreamContentType,
  HNS_PRIVATE_DRIVER_ERROR_VERSION,
  HNS_PRIVATE_DRIVER_REQUEST_VERSION,
  hnsPrivateDriverErrorStatus,
} from "./hns-private-driver.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const hsdBody = encoder.encode('{"method":"getblockchaininfo","params":[]}');
const dnsBody = buildHnsAuthoritativeDnsQueryV1({
  message_id: 0,
  query_kind: "dnskey",
  root_label: "regtest",
});

function hsdRequest(): Uint8Array {
  return encodeHnsPrivateDriverRequestV1({
    exchange_kind: "hsd_json_rpc",
    driver_reference: "hsd-json-rpc:regtest-primary",
    request_bytes: hsdBody,
    response_max_bytes: 1_048_576,
    timeout_ms: 4_000,
  });
}

function dnsRequest(): Uint8Array {
  return encodeHnsPrivateDriverRequestV1({
    exchange_kind: "authoritative_dns_tcp",
    driver_reference: "authoritative-dns:regtest",
    view_id: "dns-view-a",
    query_kind: "dnskey",
    root_label: "regtest",
    chain_authority_digest: "1".repeat(64),
    authority_nameserver: "ns1.regtest",
    authority_address_family: "GLUE4",
    authority_address: "192.0.2.53",
    request_bytes: dnsBody,
    response_max_bytes: 65_535,
    timeout_ms: 4_000,
  });
}

describe("HNS private observer-driver wire", () => {
  test("matches the ratified literal HSD and DNS request vectors", async () => {
    const hsd = hsdRequest();
    expect(hsd.byteLength).toBe(260);
    expect(decoder.decode(hsd)).toBe(
      '{"version":"pirate-hns-private-driver-request-v1","exchange_kind":"hsd_json_rpc","driver_reference":"hsd-json-rpc:regtest-primary","request_bytes_base64":"eyJtZXRob2QiOiJnZXRibG9ja2NoYWluaW5mbyIsInBhcmFtcyI6W119","response_max_bytes":1048576,"timeout_ms":4000}',
    );
    expect(await sha256(hsd)).toBe(
      "a140d89cafd85d67f17dcd31e3b052c4d41081f2e9fa37495ebc51687d8387e1",
    );

    const dns = dnsRequest();
    expect(dns.byteLength).toBe(521);
    expect(decoder.decode(dns)).toBe(
      '{"version":"pirate-hns-private-driver-request-v1","exchange_kind":"authoritative_dns_tcp","driver_reference":"authoritative-dns:regtest","view_id":"dns-view-a","query_kind":"dnskey","root_label":"regtest","chain_authority_digest":"1111111111111111111111111111111111111111111111111111111111111111","authority_nameserver":"ns1.regtest","authority_address_family":"GLUE4","authority_address":"192.0.2.53","request_bytes_base64":"AAAAAAABAAAAAAABB3JlZ3Rlc3QAADAAAQAAKQTQAACAAAAA","response_max_bytes":65535,"timeout_ms":4000}',
    );
    expect(await sha256(dns)).toBe(
      "af99e0504cd0a99eeec06e0b16c08fc6699f2318f85b83206d438f53efe52c2e",
    );
    expect(await sha256(dnsBody)).toBe(
      "eb49edc484a056b319609b39d88b2331fa06c64e727f288974533a5f6eb79343",
    );

    expect(decodeHnsPrivateDriverRequestV1(hsd)).toEqual({
      request: {
        version: HNS_PRIVATE_DRIVER_REQUEST_VERSION,
        exchange_kind: "hsd_json_rpc",
        driver_reference: "hsd-json-rpc:regtest-primary",
        request_bytes_base64: "eyJtZXRob2QiOiJnZXRibG9ja2NoYWluaW5mbyIsInBhcmFtcyI6W119",
        response_max_bytes: 1_048_576,
        timeout_ms: 4_000,
      },
      request_bytes: hsdBody,
    });
    expect(decodeHnsPrivateDriverRequestV1(dns).request.exchange_kind).toBe(
      "authoritative_dns_tcp",
    );
  });

  test("rejects member, byte, identity, bound, and timeout substitutions", () => {
    const valid = JSON.parse(decoder.decode(dnsRequest())) as Record<string, unknown>;
    const mutations: ReadonlyArray<Record<string, unknown>> = [
      { ...valid, version: "pirate-hns-private-driver-request-v2" },
      { ...valid, driver_reference: "authoritative-dns:Other" },
      { ...valid, view_id: "DNS-view-a" },
      { ...valid, query_kind: "control_txt" },
      { ...valid, root_label: "other" },
      { ...valid, chain_authority_digest: "A".repeat(64) },
      { ...valid, authority_nameserver: "ns1.regtest." },
      { ...valid, authority_address_family: "GLUE5" },
      { ...valid, request_bytes_base64: `${String(valid.request_bytes_base64).slice(0, -1)}` },
      { ...valid, response_max_bytes: 65_536 },
      { ...valid, timeout_ms: 0 },
      { ...valid, timeout_ms: 12_001 },
      { ...valid, unknown: true },
    ];
    for (const mutation of mutations) {
      expect(() =>
        decodeHnsPrivateDriverRequestV1(encoder.encode(JSON.stringify(mutation))),
      ).toThrow();
    }

    const reordered = encoder.encode(
      JSON.stringify({ exchange_kind: valid.exchange_kind, version: valid.version, ...valid }),
    );
    expect(() => decodeHnsPrivateDriverRequestV1(reordered)).toThrow();
  });

  test("pins exact error status pairs and upstream content-type encoding", () => {
    const expected = [
      ["invalid_request", 400],
      ["request_too_large", 413],
      ["upstream_protocol_error", 502],
      ["upstream_unavailable", 503],
      ["timeout", 504],
      ["internal_error", 500],
    ] as const;
    for (const [error, status] of expected) {
      expect(hnsPrivateDriverErrorStatus(error)).toBe(status);
      const bytes = encodeHnsPrivateDriverErrorV1(error);
      expect(decodeHnsPrivateDriverErrorV1(status, bytes)).toEqual({
        version: HNS_PRIVATE_DRIVER_ERROR_VERSION,
        error,
      });
      expect(() => decodeHnsPrivateDriverErrorV1(status === 400 ? 500 : 400, bytes)).toThrow();
    }

    expect(encodeHnsPrivateDriverUpstreamContentType(null)).toBe("-");
    expect(decodeHnsPrivateDriverUpstreamContentType("-")).toBeNull();
    const value = "application/json; charset=utf-8";
    expect(
      decodeHnsPrivateDriverUpstreamContentType(encodeHnsPrivateDriverUpstreamContentType(value)),
    ).toBe(value);
    expect(() => decodeHnsPrivateDriverUpstreamContentType("YQ")).toThrow();
  });
});
