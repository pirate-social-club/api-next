import { describe, expect, test } from "bun:test";
import {
  type HnsCommunityAppHostAuthorityStateV1,
  type HnsHandlePersonaHostAuthorityStateV1,
  hnsForwarderAuthorityMatchesState,
  hnsHostAuthorityFromState,
  resolveActiveHnsHostAuthority,
} from "./hns-host-serving.ts";

const zone = {
  dns_zone_activation_id: "dns-zone-1",
  dns_zone_activation_generation: 4,
  status: "active" as const,
  stable_chain_delegation_matches: true,
  dnssec_ds_authenticates_zone: true,
  retained_zone_digest_matches: true,
  gateway_deployment_reference: "gateway-deployment-1",
  gateway_certificate_spki_sha256: "a".repeat(64),
  gateway_health: "healthy" as const,
};

const appState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: "app.pirate",
  canonical_root: "pirate",
  community_id: "community_01",
  app_host_activation_id: "app-host-1",
  app_host_activation_generation: 2,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-1",
  activation_dns_zone_generation: 4,
  activation_gateway_deployment_reference: "gateway-deployment-1",
  route_binding_id: "route-binding-1",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator-route-1",
  route_authority_generation: 7,
  route_authority_effective: true,
  dns_zone: zone,
};

const handleState: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.pirate",
  canonical_root: "pirate",
  canonical_handle_label: "name",
  community_id: "community_01",
  sale_namespace_activation_id: "sale-namespace-1",
  sale_namespace_activation_generation: 3,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-zone-1",
  sale_namespace_dns_zone_generation: 4,
  sale_namespace_gateway_deployment_reference: "gateway-deployment-1",
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "route-evidence-7",
  namespace_authority_generation: 7,
  namespace_authority_effective: true,
  handle_grant_id: "handle-grant-1",
  handle_grant_generation: 2,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona-public-1",
  owner_persona_public: true,
  dns_zone: zone,
};

describe("HNS host activation and health predicates", () => {
  test("admits only mutually current app-host authority", () => {
    const resolved = resolveActiveHnsHostAuthority(appState);
    expect(resolved?.host_authority).toEqual([
      "community_app_v1",
      ["app-host-1", 2],
      "route-binding-1",
      ["operator_managed_route_v1", "operator-route-1", 7],
    ]);
    for (const changed of [
      { app_host_activation_status: "revoked" as const },
      { route_binding_current: false },
      { route_authority_effective: false },
      { activation_dns_zone_generation: 3 },
      { dns_zone: { ...zone, dnssec_ds_authenticates_zone: false } },
      { dns_zone: { ...zone, stable_chain_delegation_matches: false } },
      { dns_zone: { ...zone, gateway_health: "unavailable" as const } },
    ]) {
      expect(resolveActiveHnsHostAuthority({ ...appState, ...changed })).toBeNull();
    }
  });

  test("keeps handle grants distinct and fails generation replay closed", () => {
    const authority = hnsHostAuthorityFromState(handleState);
    expect(resolveActiveHnsHostAuthority(handleState)?.host_authority).toEqual(authority);
    expect(hnsForwarderAuthorityMatchesState(authority, handleState)).toBe(true);
    expect(
      hnsForwarderAuthorityMatchesState(authority, {
        ...handleState,
        handle_grant_generation: handleState.handle_grant_generation + 1,
      }),
    ).toBe(false);
    expect(
      resolveActiveHnsHostAuthority({
        ...handleState,
        sale_namespace_activation_status: "suspended",
      }),
    ).toBeNull();
    expect(
      resolveActiveHnsHostAuthority({ ...handleState, handle_grant_active: false }),
    ).toBeNull();
    expect(
      resolveActiveHnsHostAuthority({ ...handleState, owner_persona_public: false }),
    ).toBeNull();
  });
});
