import { describe, expect, test } from "bun:test";
import {
  decodeHnsForwarderAuthorityHeader,
  encodeHnsForwarderAuthorityHeader,
  type HnsForwarderCommunityAppAuthorityV1,
  type HnsForwarderHandlePersonaAuthorityV1,
  HnsForwarderWireError,
  hnsForwarderV1Preimage,
  hnsForwarderV2Preimage,
  hnsForwarderV3Preimage,
} from "./hns-forwarder-v3.ts";

const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const appAuthority: HnsForwarderCommunityAppAuthorityV1 = [
  "community_app_v1",
  ["app_host_activation_01", 3],
  "route-binding-1",
  ["operator_managed_route_v1", "operator_route_activation_01", 7],
];
const handleAuthority: HnsForwarderHandlePersonaAuthorityV1 = [
  "handle_persona_v1",
  ["sale_namespace_activation_01", 3],
  ["verified_namespace_v1", "route_evidence_7", 7],
  ["handle_grant_01", 2],
  "persona_public_01",
];

function rawBase64Url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("HNS forwarder immutable byte contracts", () => {
  test("retains the v1 and v2 compatibility preimages byte-for-byte", () => {
    expect(
      hnsForwarderV1Preimage({
        timestamp: "1770000000",
        method: "GET",
        normalized_host: "xn--pokmon-dva",
        path_and_query: "/c/crew?sort=top",
        root: "xn--pokmon-dva",
        community_id: "com_cmt_public_namespace_test",
        community_route: "xn--pokmon-dva",
        subdomain: "",
      }),
    ).toBe(
      '["pirate-hns-forwarder-v1","1770000000","GET","xn--pokmon-dva","/c/crew?sort=top","xn--pokmon-dva","com_cmt_public_namespace_test","xn--pokmon-dva",""]',
    );
    expect(
      hnsForwarderV2Preimage({
        key_id: "gateway-key-2026-08",
        timestamp: "1770000000",
        method: "POST",
        normalized_host: "app.xn--pokmon-dva",
        path_and_query: "/c/app.xn--pokmon-dva/posts?draft=1",
        canonical_root: "xn--pokmon-dva",
        community_id: "com_cmt_public_namespace_test",
        canonical_path_segment: "app.xn--pokmon-dva",
        subdomain: "app",
        body_sha256: "cf6c63ce25116b04e3b776a2957606e18d8ac798dde21e3ec30882ac2dfbe0cb",
        nonce: "nonce-0001",
      }),
    ).toBe(
      '["pirate-hns-forwarder-v2","gateway-key-2026-08","1770000000","POST","app.xn--pokmon-dva","/c/app.xn--pokmon-dva/posts?draft=1","xn--pokmon-dva","com_cmt_public_namespace_test","app.xn--pokmon-dva","app","cf6c63ce25116b04e3b776a2957606e18d8ac798dde21e3ec30882ac2dfbe0cb","nonce-0001"]',
    );
  });

  test("reproduces both v3 authority headers and preimages exactly", () => {
    expect(encodeHnsForwarderAuthorityHeader(appAuthority)).toBe(
      "WyJjb21tdW5pdHlfYXBwX3YxIixbImFwcF9ob3N0X2FjdGl2YXRpb25fMDEiLDNdLCJyb3V0ZS1iaW5kaW5nLTEiLFsib3BlcmF0b3JfbWFuYWdlZF9yb3V0ZV92MSIsIm9wZXJhdG9yX3JvdXRlX2FjdGl2YXRpb25fMDEiLDddXQ",
    );
    expect(encodeHnsForwarderAuthorityHeader(handleAuthority)).toBe(
      "WyJoYW5kbGVfcGVyc29uYV92MSIsWyJzYWxlX25hbWVzcGFjZV9hY3RpdmF0aW9uXzAxIiwzXSxbInZlcmlmaWVkX25hbWVzcGFjZV92MSIsInJvdXRlX2V2aWRlbmNlXzciLDddLFsiaGFuZGxlX2dyYW50XzAxIiwyXSwicGVyc29uYV9wdWJsaWNfMDEiXQ",
    );
    const appPreimage = hnsForwarderV3Preimage({
      key_id: "gateway-key-2026-08",
      timestamp: "1770000000",
      method: "GET",
      normalized_host: "app.xn--pokmon-dva",
      path_and_query: "/c/app.xn--pokmon-dva",
      canonical_root: "xn--pokmon-dva",
      community_id: "com_cmt_public_namespace_test",
      host_authority: appAuthority,
      body_sha256: emptySha256,
      nonce: "",
    });
    const handlePreimage = hnsForwarderV3Preimage({
      key_id: "gateway-key-2026-08",
      timestamp: "1770000000",
      method: "GET",
      normalized_host: "name.xn--pokmon-dva",
      path_and_query: "/",
      canonical_root: "xn--pokmon-dva",
      community_id: "com_cmt_public_namespace_test",
      host_authority: handleAuthority,
      body_sha256: emptySha256,
      nonce: "",
    });
    expect(appPreimage).toBe(
      '["pirate-hns-forwarder-v3","gateway-key-2026-08","1770000000","GET","app.xn--pokmon-dva","/c/app.xn--pokmon-dva","xn--pokmon-dva","com_cmt_public_namespace_test",["community_app_v1",["app_host_activation_01",3],"route-binding-1",["operator_managed_route_v1","operator_route_activation_01",7]],"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",""]',
    );
    expect(handlePreimage).toBe(
      '["pirate-hns-forwarder-v3","gateway-key-2026-08","1770000000","GET","name.xn--pokmon-dva","/","xn--pokmon-dva","com_cmt_public_namespace_test",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",""]',
    );
    expect(new TextEncoder().encode(appPreimage).byteLength).toBe(363);
    expect(new TextEncoder().encode(handlePreimage).byteLength).toBe(359);
  });
});

describe("HNS forwarder v3 strict authority decoding", () => {
  test("round-trips only canonical ordered tuples", () => {
    const encoded = encodeHnsForwarderAuthorityHeader(appAuthority);
    expect(decodeHnsForwarderAuthorityHeader(encoded)).toEqual(appAuthority);
    expect(() => decodeHnsForwarderAuthorityHeader(`${encoded}=`)).toThrow(HnsForwarderWireError);
    expect(() => decodeHnsForwarderAuthorityHeader("+bad")).toThrow(HnsForwarderWireError);
    expect(() =>
      decodeHnsForwarderAuthorityHeader(rawBase64Url(JSON.stringify([...appAuthority, "extra"]))),
    ).toThrow(HnsForwarderWireError);
    expect(() =>
      decodeHnsForwarderAuthorityHeader(rawBase64Url(JSON.stringify(appAuthority, null, 1))),
    ).toThrow(HnsForwarderWireError);
    expect(() =>
      decodeHnsForwarderAuthorityHeader(
        rawBase64Url(
          JSON.stringify([
            "handle_persona_v1",
            ["sale_namespace_activation_01", 3],
            ["operator_managed_route_v1", "operator_route_activation_01", 7],
            ["handle_grant_01", 2],
            "persona_public_01",
          ]),
        ),
      ),
    ).toThrow(HnsForwarderWireError);
  });

  test("enforces variant-specific host, method, path, and nonce rules", () => {
    const common = {
      key_id: "gateway-key-2026-08",
      timestamp: "1770000000",
      community_id: "com_cmt_public_namespace_test",
      body_sha256: emptySha256,
      nonce: "",
    } as const;
    expect(() =>
      hnsForwarderV3Preimage({
        ...common,
        method: "GET",
        normalized_host: "name.xn--pokmon-dva",
        path_and_query: "/",
        canonical_root: "xn--pokmon-dva",
        host_authority: appAuthority,
      }),
    ).toThrow(HnsForwarderWireError);
    for (const changed of [
      { method: "POST", path_and_query: "/" },
      { method: "GET", path_and_query: "/private" },
      { method: "GET", path_and_query: "/?view=private" },
    ]) {
      expect(() =>
        hnsForwarderV3Preimage({
          ...common,
          ...changed,
          normalized_host: "name.xn--pokmon-dva",
          canonical_root: "xn--pokmon-dva",
          host_authority: handleAuthority,
        }),
      ).toThrow(HnsForwarderWireError);
    }
    expect(() =>
      hnsForwarderV3Preimage({
        ...common,
        method: "GET",
        normalized_host: "name.xn--pokmon-dva",
        path_and_query: "/",
        canonical_root: "xn--pokmon-dva",
        host_authority: handleAuthority,
        nonce: "safe-nonce",
      }),
    ).toThrow(HnsForwarderWireError);
  });
});
