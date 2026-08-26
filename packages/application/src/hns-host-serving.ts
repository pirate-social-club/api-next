import type { Effect } from "effect";
import type {
  HnsForwarderCommunityAppAuthorityV1,
  HnsForwarderHandlePersonaAuthorityV1,
  HnsForwarderHostAuthorityV1,
} from "./hns-forwarder-v3.ts";
import { isCanonicalHnsForwarderHost, isHnsForwarderHostAuthorityV1 } from "./hns-forwarder-v3.ts";
import type { ControlPlaneError } from "./ports.ts";

export type HnsHostHealthStatusV1 = "healthy" | "unavailable";
export type HnsHostActivationStatusV1 = "pending" | "active" | "suspended" | "revoked";

export type HnsDnsZoneHealthV1 = Readonly<{
  dns_zone_activation_id: string;
  dns_zone_activation_generation: number;
  status: HnsHostActivationStatusV1;
  stable_chain_delegation_matches: boolean;
  dnssec_ds_authenticates_zone: boolean;
  retained_zone_digest_matches: boolean;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  gateway_health: HnsHostHealthStatusV1;
}>;

export type HnsCommunityAppHostAuthorityStateV1 = Readonly<{
  variant: "community_app_v1";
  normalized_host: string;
  canonical_root: string;
  community_id: string;
  app_host_activation_id: string;
  app_host_activation_generation: number;
  app_host_activation_status: HnsHostActivationStatusV1;
  activation_dns_zone_id: string;
  activation_dns_zone_generation: number;
  activation_gateway_deployment_reference: string;
  route_binding_id: string;
  route_binding_current: boolean;
  route_authority_kind: "verified_namespace_v1" | "operator_managed_route_v1";
  route_authority_reference: string;
  route_authority_generation: number;
  route_authority_effective: boolean;
  dns_zone: HnsDnsZoneHealthV1;
}>;

export type HnsHandlePersonaHostAuthorityStateV1 = Readonly<{
  variant: "handle_persona_v1";
  normalized_host: string;
  canonical_root: string;
  canonical_handle_label: string;
  community_id: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  sale_namespace_activation_status: HnsHostActivationStatusV1;
  sale_namespace_dns_zone_id: string;
  sale_namespace_dns_zone_generation: number;
  sale_namespace_gateway_deployment_reference: string;
  namespace_authority_kind: "verified_namespace_v1";
  namespace_authority_reference: string;
  namespace_authority_generation: number;
  namespace_authority_effective: boolean;
  handle_grant_id: string;
  handle_grant_generation: number;
  handle_grant_active: boolean;
  fulfillment_kind: "hosted_persona_v1" | "delegated_zone_v1" | "spaces_native_v1";
  owner_persona_id: string;
  owner_persona_public: boolean;
  dns_zone: HnsDnsZoneHealthV1;
}>;

export type HnsHostAuthorityStateV1 =
  | HnsCommunityAppHostAuthorityStateV1
  | HnsHandlePersonaHostAuthorityStateV1;

export type HnsHostAuthorityResolutionV1 = Readonly<{
  normalized_host: string;
  canonical_root: string;
  community_id: string;
  host_authority: HnsForwarderHostAuthorityV1;
  state: HnsHostAuthorityStateV1;
}>;

export type HnsForwarderGatewayAuthoritySourceV1 = Readonly<{
  /** The hostname is the only caller-controlled selector. Authority stays behind this port. */
  resolve: (
    normalizedHost: string,
  ) => Effect.Effect<HnsHostAuthorityStateV1 | null, ControlPlaneError>;
}>;

export type HnsForwarderWorkerAuthoritySourceV1 = Readonly<{
  /** Re-resolves current authority after transport authentication; envelope data is never authority. */
  resolve: (
    normalizedHost: string,
  ) => Effect.Effect<HnsHostAuthorityStateV1 | null, ControlPlaneError>;
}>;

function dnsZoneHealthy(
  zone: HnsDnsZoneHealthV1,
  activationZoneId: string,
  activationZoneGeneration: number,
  activationGatewayReference: string,
): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(zone.dns_zone_activation_id) &&
    Number.isSafeInteger(zone.dns_zone_activation_generation) &&
    zone.dns_zone_activation_generation > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(zone.gateway_deployment_reference) &&
    zone.status === "active" &&
    zone.dns_zone_activation_id === activationZoneId &&
    zone.dns_zone_activation_generation === activationZoneGeneration &&
    zone.gateway_deployment_reference === activationGatewayReference &&
    zone.stable_chain_delegation_matches &&
    zone.dnssec_ds_authenticates_zone &&
    zone.retained_zone_digest_matches &&
    zone.gateway_health === "healthy" &&
    /^[0-9a-f]{64}$/u.test(zone.gateway_certificate_spki_sha256)
  );
}

export function hnsHostAuthorityFromState(
  state: HnsHostAuthorityStateV1,
): HnsForwarderHostAuthorityV1 {
  if (state.variant === "community_app_v1") {
    return [
      "community_app_v1",
      [state.app_host_activation_id, state.app_host_activation_generation],
      state.route_binding_id,
      [
        state.route_authority_kind,
        state.route_authority_reference,
        state.route_authority_generation,
      ],
    ];
  }
  return [
    "handle_persona_v1",
    [state.sale_namespace_activation_id, state.sale_namespace_activation_generation],
    [
      state.namespace_authority_kind,
      state.namespace_authority_reference,
      state.namespace_authority_generation,
    ],
    [state.handle_grant_id, state.handle_grant_generation],
    state.owner_persona_id,
  ];
}

export function isHnsCommunityAppHostAuthorityActive(
  state: HnsCommunityAppHostAuthorityStateV1,
): boolean {
  return (
    isCanonicalHnsForwarderHost(state.normalized_host) &&
    isHnsForwarderHostAuthorityV1(hnsHostAuthorityFromState(state)) &&
    state.normalized_host === `app.${state.canonical_root}` &&
    state.app_host_activation_status === "active" &&
    state.route_binding_current &&
    state.route_authority_effective &&
    dnsZoneHealthy(
      state.dns_zone,
      state.activation_dns_zone_id,
      state.activation_dns_zone_generation,
      state.activation_gateway_deployment_reference,
    )
  );
}

export function isHnsHandlePersonaHostAuthorityActive(
  state: HnsHandlePersonaHostAuthorityStateV1,
): boolean {
  return (
    isCanonicalHnsForwarderHost(state.normalized_host) &&
    isHnsForwarderHostAuthorityV1(hnsHostAuthorityFromState(state)) &&
    state.normalized_host === `${state.canonical_handle_label}.${state.canonical_root}` &&
    state.sale_namespace_activation_status === "active" &&
    state.namespace_authority_kind === "verified_namespace_v1" &&
    state.namespace_authority_effective &&
    state.handle_grant_active &&
    state.fulfillment_kind === "hosted_persona_v1" &&
    state.owner_persona_public &&
    dnsZoneHealthy(
      state.dns_zone,
      state.sale_namespace_dns_zone_id,
      state.sale_namespace_dns_zone_generation,
      state.sale_namespace_gateway_deployment_reference,
    )
  );
}

export function resolveActiveHnsHostAuthority(
  state: HnsHostAuthorityStateV1 | null,
): HnsHostAuthorityResolutionV1 | null {
  if (state === null) return null;
  const active =
    state.variant === "community_app_v1"
      ? isHnsCommunityAppHostAuthorityActive(state)
      : isHnsHandlePersonaHostAuthorityActive(state);
  return active
    ? {
        normalized_host: state.normalized_host,
        canonical_root: state.canonical_root,
        community_id: state.community_id,
        host_authority: hnsHostAuthorityFromState(state),
        state,
      }
    : null;
}

export function hnsForwarderAuthorityMatchesState(
  authority: HnsForwarderHostAuthorityV1,
  state: HnsHostAuthorityStateV1,
): boolean {
  if (authority[0] !== state.variant) return false;
  return JSON.stringify(authority) === JSON.stringify(hnsHostAuthorityFromState(state));
}

export function isCommunityAppAuthority(
  authority: HnsForwarderHostAuthorityV1,
): authority is HnsForwarderCommunityAppAuthorityV1 {
  return authority[0] === "community_app_v1";
}

export function isHandlePersonaAuthority(
  authority: HnsForwarderHostAuthorityV1,
): authority is HnsForwarderHandlePersonaAuthorityV1 {
  return authority[0] === "handle_persona_v1";
}
