import { COOKIE_CENSUS_TABLES } from "./census.mjs";
import { NEXT_GATEWAY, PREVIOUS_GATEWAY } from "./cookie-plan.ts";
import { stagingGatewayFixture } from "./fixture.ts";

export async function cookieProfileFixture() {
  const input = await stagingGatewayFixture();
  const nextManifest = (
    await Bun.file(
      new URL(
        "../../apps/hns-authority-provisioner/ops/staging-mainnet/deployment-manifest.gateway.json",
        import.meta.url,
      ),
    ).text()
  ).trim();
  const next = JSON.parse(nextManifest);
  const previousManifest = JSON.stringify({
    ...next,
    api_next_source_commit: "76cd679ead1a680bb74a47f6718d3e0e7e4e5f3f",
    bundle_sha256: "f19d0a9280a181b4efa892788646e7619e0ec6705a3f2c2421bbe59b320b5902",
    profile_sha256: "c4f4c07252ba10a25467f476cc5b56d50ef9cf02e25ad368a05551d19ba861ed",
    profile_utf8_bytes: 622,
    profile_version: "pirate-hns-community-app-interactive-gateway-v3",
    solid_ingress_composition_reference:
      "solid-hns-ingress-sha256:614a197b91112007fe26dda867b23452a2beeefa47acfdba147a5c7bfee38076",
  });
  const tenants = [];
  for (const state of input.states) {
    const root = state.dns.canonical_root;
    state.dns.gateway_deployment_reference = PREVIOUS_GATEWAY;
    state.dns.gateway_certificate_spki_sha256 = next.gateway_certificate_spki_sha256;
    state.app.gateway_deployment_reference = PREVIOUS_GATEWAY;
    state.health.observed_gateway_deployment_reference = PREVIOUS_GATEWAY;
    state.health.observed_gateway_certificate_spki_sha256 = next.gateway_certificate_spki_sha256;
    const zone = {
      dns_zone_activation_id: state.dns.dns_zone_activation_id,
      dns_zone_activation_generation: Number(state.dns.dns_zone_activation_generation),
      status: "active",
      stable_chain_delegation_matches: root === "8s28",
      dnssec_ds_authenticates_zone: true,
      retained_zone_digest_matches: true,
      gateway_deployment_reference: PREVIOUS_GATEWAY,
      gateway_certificate_spki_sha256: next.gateway_certificate_spki_sha256,
      gateway_health: "healthy",
    };
    const app = {
      variant: "community_app_v1",
      normalized_host: `app.${root}`,
      canonical_root: root,
      community_id: state.app.community_id,
      app_host_activation_id: state.app.app_host_activation_id,
      app_host_activation_generation: Number(state.app.app_host_activation_generation),
      app_host_activation_status: "active",
      activation_dns_zone_id: state.dns.dns_zone_activation_id,
      activation_dns_zone_generation: Number(state.dns.dns_zone_activation_generation),
      activation_gateway_deployment_reference: PREVIOUS_GATEWAY,
      route_binding_id: state.app.route_binding_id,
      route_binding_current: true,
      route_authority_kind: "verified_namespace_v1",
      route_authority_reference: state.app.route_authority_reference,
      route_authority_generation: Number(state.app.route_authority_generation),
      route_authority_effective: true,
      dns_zone: zone,
    };
    const handle = {
      variant: "handle_persona_v1",
      normalized_host: `participant.${root}`,
      canonical_root: root,
      canonical_handle_label: "participant",
      community_id: app.community_id,
      sale_namespace_activation_id: state.sale.sale_namespace_activation_id,
      sale_namespace_activation_generation: Number(state.sale.sale_namespace_activation_generation),
      sale_namespace_activation_status: "active",
      sale_namespace_dns_zone_id: zone.dns_zone_activation_id,
      sale_namespace_dns_zone_generation: zone.dns_zone_activation_generation,
      sale_namespace_gateway_deployment_reference: PREVIOUS_GATEWAY,
      namespace_authority_kind: "verified_namespace_v1",
      namespace_authority_reference: app.route_authority_reference,
      namespace_authority_generation: app.route_authority_generation,
      namespace_authority_effective: true,
      handle_grant_id: `grant-${root}`,
      handle_grant_generation: 1,
      handle_grant_active: true,
      fulfillment_kind: "hosted_persona_v1",
      owner_persona_id: `persona-${root}`,
      owner_persona_public: true,
      dns_zone: zone,
    };
    const rows = Object.fromEntries(
      COOKIE_CENSUS_TABLES.map((table: string) => [table, []]),
    ) as Record<string, unknown[]>;
    rows.handle_grants = [{ namespace_root: root, handle_label: "participant" }];
    tenants.push({
      root,
      rows,
      apps: [{ host: app.normalized_host, state: app }],
      handles: [{ host: handle.normalized_host, state: handle }],
      recovery:
        root === "8s28"
          ? {
              root_label: root,
              evidence_ref: app.route_authority_reference,
              binding_generation: String(app.route_authority_generation),
              expires_at: "2026-10-25T12:00:00.000Z",
            }
          : null,
    });
  }
  return {
    ...input,
    states: [input.states[0]],
    previousManifest,
    nextManifest,
    census: { database_time: input.states[0].database_time, roots: tenants },
    readiness: {
      ...input.readiness,
      previous_gateway_reference: PREVIOUS_GATEWAY,
      gateway_reference: NEXT_GATEWAY,
      manifest_json: nextManifest,
      profile_sha256: next.profile_sha256,
      handle_profile_sha256: next.handle_profile_sha256,
    },
  };
}
