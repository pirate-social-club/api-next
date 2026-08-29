import type { Effect } from "effect";
import type { ControlPlaneError } from "./ports.ts";

export type HnsDnsZoneActivationLifecycleStatusV1 = "active" | "suspended" | "revoked";

export const HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION =
  "pirate-hns-dns-zone-activation-document-v1" as const;

export type HnsAuthoritySuccessorGenerationSnapshotV1 = Readonly<{
  dns_current_generation: number;
  app_host_current_generation: number;
  successor_dns_latest_health_generation: number;
}>;

export type HnsAuthoritySuccessorGenerationsV1 = Readonly<{
  dns_activation_generation: number;
  app_host_activation_generation: number;
  health_generation: number;
}>;

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a nonnegative incrementable safe integer`);
  }
  return value;
}

/**
 * Predicts the exact generations that the fenced persistence functions will
 * derive from a read-only snapshot. This function never reserves or writes.
 */
export function deriveHnsAuthoritySuccessorGenerationsV1(
  snapshot: HnsAuthoritySuccessorGenerationSnapshotV1,
): HnsAuthoritySuccessorGenerationsV1 {
  return {
    dns_activation_generation:
      nonnegativeSafeInteger(snapshot.dns_current_generation, "DNS current generation") + 1,
    app_host_activation_generation:
      nonnegativeSafeInteger(snapshot.app_host_current_generation, "app-host current generation") +
      1,
    health_generation:
      nonnegativeSafeInteger(
        snapshot.successor_dns_latest_health_generation,
        "successor DNS latest health generation",
      ) + 1,
  };
}

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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds the exact document consumed by both emit-only review and persistence. */
export async function prepareHnsDnsZoneActivationDocumentV1(
  input: Readonly<{
    payload: Omit<HnsDnsZoneActivationDocumentPayloadV1, "zone"> & {
      zone_revision: number;
    };
    zone_bytes: Uint8Array;
  }>,
): Promise<HnsDnsZoneActivationDocumentV1> {
  const zoneBytes = new Uint8Array(input.zone_bytes);
  const zoneDigest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", zoneBytes)));
  const payload: HnsDnsZoneActivationDocumentPayloadV1 = {
    version: input.payload.version,
    dns_zone_activation_id: input.payload.dns_zone_activation_id,
    canonical_root: input.payload.canonical_root,
    dns_authority: input.payload.dns_authority,
    pirate_dns_authority_inventory: input.payload.pirate_dns_authority_inventory,
    zone: [input.payload.zone_revision, zoneDigest],
    dnssec_keyset: input.payload.dnssec_keyset,
    gateway: input.payload.gateway,
    stable_chain_delegation_snapshot: input.payload.stable_chain_delegation_snapshot,
  };
  return {
    activation_document_bytes: encodeHnsDnsZoneActivationDocumentV1(payload),
    dns_zone_activation_id: payload.dns_zone_activation_id,
    canonical_root: payload.canonical_root,
    dns_authority_kind: payload.dns_authority[0],
    dns_authority_reference: payload.dns_authority[1],
    dns_authority_generation: payload.dns_authority[2],
    pirate_dns_authority_inventory_reference: payload.pirate_dns_authority_inventory[0],
    pirate_dns_authority_inventory_version: payload.pirate_dns_authority_inventory[1],
    pirate_dns_authority_inventory_digest: payload.pirate_dns_authority_inventory[2],
    zone_revision: payload.zone[0],
    zone_bytes: zoneBytes,
    zone_bytes_digest: payload.zone[1],
    dnssec_keyset_reference: payload.dnssec_keyset[0],
    dnssec_keyset_version: payload.dnssec_keyset[1],
    gateway_deployment_reference: payload.gateway[0],
    gateway_certificate_spki_sha256: payload.gateway[1],
    stable_chain_delegation_snapshot_reference: payload.stable_chain_delegation_snapshot[0],
    stable_chain_delegation_snapshot_digest: payload.stable_chain_delegation_snapshot[1],
  };
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
