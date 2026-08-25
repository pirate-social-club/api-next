import { describe, expect, test } from "bun:test";
import {
  decodeHnsSolidHostAuthorityRequestV2,
  encodeHnsSolidHostAuthorityResponseV2,
  HNS_SOLID_HOST_AUTHORITY_REQUEST_V2,
  HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2,
  HnsCommunityAppApiWireFailure,
  resolveHnsSolidHostAuthorityV2,
} from "./hns-community-app-api.ts";
import type { HnsCommunityAppHostAuthorityStateV1 } from "./hns-host-serving.ts";

const authority = [
  "community_app_v1",
  ["activation-01", 3],
  "route-binding-01",
  ["operator_managed_route_v1", "operator-activation-01", 7],
] as const;
const requestText = JSON.stringify([
  HNS_SOLID_HOST_AUTHORITY_REQUEST_V2,
  "app.xn--pokmon-dva",
  authority,
  "gateway-deployment-01",
]);

const activeState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: "app.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  community_id: "community-public-01",
  app_host_activation_id: "activation-01",
  app_host_activation_generation: 3,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-01",
  activation_dns_zone_generation: 2,
  activation_gateway_deployment_reference: "gateway-deployment-01",
  route_binding_id: "route-binding-01",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator-activation-01",
  route_authority_generation: 7,
  route_authority_effective: true,
  dns_zone: {
    dns_zone_activation_id: "dns-zone-01",
    dns_zone_activation_generation: 2,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: "gateway-deployment-01",
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};

describe("HNS Solid host-authority v2 wire", () => {
  test("matches the independent Solid request and response fixtures exactly", () => {
    const request = decodeHnsSolidHostAuthorityRequestV2(new TextEncoder().encode(requestText));
    const response = resolveHnsSolidHostAuthorityV2(request, activeState);
    expect(new TextDecoder().decode(encodeHnsSolidHostAuthorityResponseV2(response))).toBe(
      JSON.stringify([
        HNS_SOLID_HOST_AUTHORITY_RESPONSE_V2,
        "active",
        "app.xn--pokmon-dva",
        "xn--pokmon-dva",
        "community-public-01",
        authority,
        "gateway-deployment-01",
      ]),
    );
  });

  test("rejects noncanonical bytes and every retained-authority mismatch", () => {
    expect(() =>
      decodeHnsSolidHostAuthorityRequestV2(new TextEncoder().encode(`${requestText}\n`)),
    ).toThrow(HnsCommunityAppApiWireFailure);
    const request = decodeHnsSolidHostAuthorityRequestV2(new TextEncoder().encode(requestText));
    for (const state of [
      null,
      { ...activeState, app_host_activation_status: "suspended" as const },
      { ...activeState, route_authority_generation: 8 },
      { ...activeState, activation_gateway_deployment_reference: "other-deployment" },
    ]) {
      expect(() => resolveHnsSolidHostAuthorityV2(request, state)).toThrow(
        HnsCommunityAppApiWireFailure,
      );
    }
  });
});
