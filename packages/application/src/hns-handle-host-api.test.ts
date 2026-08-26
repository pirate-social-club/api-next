import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeHnsSolidHandleHostAuthorityRequestV1,
  encodeHnsSolidHandleHostAuthorityResponseV1,
  HnsHandleHostApiWireFailure,
  resolveHnsSolidHandleHostAuthorityV1,
} from "./hns-handle-host-api.ts";
import type { HnsHandlePersonaHostAuthorityStateV1 } from "./hns-host-serving.ts";

const requestText =
  '["pirate-hns-solid-handle-host-authority-request-v1","name.xn--pokmon-dva",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"gateway-deployment-handle-v1"]';
const responseText =
  '["pirate-hns-solid-handle-host-authority-response-v1","active","name.xn--pokmon-dva","xn--pokmon-dva","name","com_cmt_public_namespace_test","persona_public_01",["handle_persona_v1",["sale_namespace_activation_01",3],["verified_namespace_v1","route_evidence_7",7],["handle_grant_01",2],"persona_public_01"],"gateway-deployment-handle-v1"]';

const state: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  canonical_handle_label: "name",
  community_id: "com_cmt_public_namespace_test",
  sale_namespace_activation_id: "sale_namespace_activation_01",
  sale_namespace_activation_generation: 3,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-zone-handle",
  sale_namespace_dns_zone_generation: 4,
  sale_namespace_gateway_deployment_reference: "gateway-deployment-handle-v1",
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "route_evidence_7",
  namespace_authority_generation: 7,
  namespace_authority_effective: true,
  handle_grant_id: "handle_grant_01",
  handle_grant_generation: 2,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona_public_01",
  owner_persona_public: true,
  dns_zone: {
    dns_zone_activation_id: "dns-zone-handle",
    dns_zone_activation_generation: 4,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: "gateway-deployment-handle-v1",
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};

describe("HNS handle-host private authority wire", () => {
  test("reproduces the immutable request and response vectors", () => {
    const requestBytes = new TextEncoder().encode(requestText);
    expect(requestBytes.byteLength).toBe(252);
    expect(createHash("sha256").update(requestBytes).digest("hex")).toBe(
      "5f7cba88ec8f9d5d434bfaf659f7e6b795a12814ca283b4455d93dc478e4d3b3",
    );
    const request = decodeHnsSolidHandleHostAuthorityRequestV1(requestBytes);
    const responseBytes = encodeHnsSolidHandleHostAuthorityResponseV1(
      resolveHnsSolidHandleHostAuthorityV1(request, state),
    );
    expect(new TextDecoder().decode(responseBytes)).toBe(responseText);
    expect(responseBytes.byteLength).toBe(338);
    expect(createHash("sha256").update(responseBytes).digest("hex")).toBe(
      "2ae65f316fe73a99dda032e4ba654250cbe5629388cc77b887ba9071ce7c0ef7",
    );
  });

  test("rejects noncanonical requests and every inactive current-state family", () => {
    const request = decodeHnsSolidHandleHostAuthorityRequestV1(
      new TextEncoder().encode(requestText),
    );
    const invalidRequests = [
      `${requestText}\n`,
      requestText.replace("name.xn--pokmon-dva", "Name.xn--pokmon-dva"),
      requestText.replace("handle_persona_v1", "community_app_v1"),
      requestText.replace("gateway-deployment-handle-v1", "gateway deployment"),
    ];
    for (const invalid of invalidRequests) {
      expect(() =>
        decodeHnsSolidHandleHostAuthorityRequestV1(new TextEncoder().encode(invalid)),
      ).toThrow(HnsHandleHostApiWireFailure);
    }

    const inactiveStates: readonly HnsHandlePersonaHostAuthorityStateV1[] = [
      { ...state, sale_namespace_activation_status: "suspended" },
      { ...state, namespace_authority_effective: false },
      { ...state, handle_grant_active: false },
      { ...state, fulfillment_kind: "delegated_zone_v1" },
      { ...state, owner_persona_public: false },
      { ...state, sale_namespace_gateway_deployment_reference: "other-deployment" },
      { ...state, dns_zone: { ...state.dns_zone, status: "suspended" } },
      { ...state, dns_zone: { ...state.dns_zone, stable_chain_delegation_matches: false } },
      { ...state, dns_zone: { ...state.dns_zone, dnssec_ds_authenticates_zone: false } },
      { ...state, dns_zone: { ...state.dns_zone, retained_zone_digest_matches: false } },
      { ...state, dns_zone: { ...state.dns_zone, gateway_health: "unavailable" } },
    ];
    for (const inactive of inactiveStates) {
      expect(() => resolveHnsSolidHandleHostAuthorityV1(request, inactive)).toThrow(
        HnsHandleHostApiWireFailure,
      );
    }
    for (const mismatched of [
      { ...state, normalized_host: "other.xn--pokmon-dva" },
      { ...state, canonical_root: "other-root" },
      { ...state, canonical_handle_label: "other-label" },
      { ...state, owner_persona_id: "persona_public_other" },
      { ...state, handle_grant_id: "handle_grant_other" },
      { ...state, sale_namespace_activation_generation: 4 },
    ] as const) {
      expect(() => resolveHnsSolidHandleHostAuthorityV1(request, mismatched)).toThrow(
        HnsHandleHostApiWireFailure,
      );
    }
  });
});
