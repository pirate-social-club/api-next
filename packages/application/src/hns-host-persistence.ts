import type { Effect } from "effect";
import type { ControlPlaneError } from "./ports.ts";

export type HnsDnsZoneActivationLifecycleStatusV1 = "active" | "suspended" | "revoked";

export const HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION =
  "pirate-hns-dns-zone-activation-document-v1" as const;

export type HnsDnsZoneActivationDocumentPayloadV1 = Readonly<{
  version: typeof HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION;
  dns_zone_activation_id: string;
  canonical_root: string;
  dns_authority: readonly ["pirate_managed_dns_v1", string, number];
  pirate_dns_authority_inventory: readonly [string, string, string];
  zone: readonly [number, string];
  dnssec_keyset: readonly [string, string];
  gateway: readonly [string, string];
  stable_chain_delegation_snapshot: readonly [string, string];
}>;

export function encodeHnsDnsZoneActivationDocumentV1(
  payload: HnsDnsZoneActivationDocumentPayloadV1,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

export type HnsDnsZoneActivationDocumentV1 = Readonly<{
  activation_document_bytes: Uint8Array;
  dns_zone_activation_id: string;
  canonical_root: string;
  dns_authority_kind: "pirate_managed_dns_v1";
  dns_authority_reference: string;
  dns_authority_generation: number;
  pirate_dns_authority_inventory_reference: string;
  pirate_dns_authority_inventory_version: string;
  pirate_dns_authority_inventory_digest: string;
  zone_revision: number;
  zone_bytes: Uint8Array;
  zone_bytes_digest: string;
  dnssec_keyset_reference: string;
  dnssec_keyset_version: string;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  stable_chain_delegation_snapshot_reference: string;
  stable_chain_delegation_snapshot_digest: string;
}>;

export type HnsDnsZoneActivationReservationV1 = Readonly<{
  outcome: "reserved" | "replayed";
  operation_id: string;
  dns_zone_activation_id: string;
  fence_token: number;
  lease_expires_at: string;
  activation_generation: number | null;
}>;

export type HnsDnsZoneActivationOutcomeV1 = Readonly<{
  outcome: "activated" | "replayed";
  dns_zone_activation_id: string;
  activation_generation: number;
}>;

export type HnsLifecycleOutcomeV1 = Readonly<{
  outcome: "changed" | "replayed";
  activation_id: string;
  activation_generation: number;
  status: HnsDnsZoneActivationLifecycleStatusV1;
}>;

export type HnsDnsZoneHealthOutcomeV1 = Readonly<{
  outcome: "recorded" | "replayed";
  dns_zone_activation_id: string;
  activation_generation: number;
  health_generation: number;
}>;

export type HnsCommunityAppHostActivationOutcomeV1 = Readonly<{
  outcome: "activated" | "changed" | "replayed";
  app_host_activation_id: string;
  app_host_activation_generation: number;
  status: HnsDnsZoneActivationLifecycleStatusV1;
}>;

export type HnsFirstPartyHostPersistenceStoreV1 = Readonly<{
  reserveDnsZoneActivation: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      activation_document_digest: string;
      dns_zone_activation_id: string;
      expected_activation_generation: number;
      lease_seconds: number;
    }>,
  ) => Effect.Effect<HnsDnsZoneActivationReservationV1, ControlPlaneError>;
  finalizeDnsZoneActivation: (
    input: Readonly<{
      reservation: HnsDnsZoneActivationReservationV1;
      document: HnsDnsZoneActivationDocumentV1;
    }>,
  ) => Effect.Effect<HnsDnsZoneActivationOutcomeV1, ControlPlaneError>;
  changeDnsZoneStatus: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      request_hash: string;
      dns_zone_activation_id: string;
      expected_activation_generation: number;
      target_status: HnsDnsZoneActivationLifecycleStatusV1;
      reason_code: string;
    }>,
  ) => Effect.Effect<HnsLifecycleOutcomeV1, ControlPlaneError>;
  recordDnsZoneHealth: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      request_hash: string;
      dns_zone_activation_id: string;
      activation_generation: number;
      expected_health_generation: number;
      stable_chain_delegation_snapshot_reference: string;
      stable_chain_delegation_snapshot_digest: string;
      observed_zone_bytes_digest: string;
      observed_dnssec_keyset_reference: string;
      observed_dnssec_keyset_version: string;
      observed_gateway_deployment_reference: string;
      observed_gateway_certificate_spki_sha256: string;
      delegation_matches: boolean;
      ds_authenticates_zone: boolean;
      retained_zone_digest_matches: boolean;
      gateway_healthy: boolean;
      valid_for_seconds: number;
    }>,
  ) => Effect.Effect<HnsDnsZoneHealthOutcomeV1, ControlPlaneError>;
  activateCommunityAppHost: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      request_hash: string;
      app_host_activation_id: string;
      community_id: string;
      canonical_root: string;
      route_binding_id: string;
      route_authority_kind: "verified_namespace_v1" | "operator_managed_route_v1";
      route_authority_reference: string;
      route_authority_generation: number;
      dns_zone_activation_id: string;
      dns_zone_activation_generation: number;
      gateway_deployment_reference: string;
    }>,
  ) => Effect.Effect<HnsCommunityAppHostActivationOutcomeV1, ControlPlaneError>;
  changeCommunityAppHostStatus: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      request_hash: string;
      app_host_activation_id: string;
      expected_activation_generation: number;
      target_status: HnsDnsZoneActivationLifecycleStatusV1;
      reason_code: string;
    }>,
  ) => Effect.Effect<HnsCommunityAppHostActivationOutcomeV1, ControlPlaneError>;
}>;
