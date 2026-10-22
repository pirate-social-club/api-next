import { createHash } from "node:crypto";
import type { Client } from "pg";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic stand-ins for the import path's `hns-dns_<uuid>`-style identifiers. */
function uuidShaped(seed: string): string {
  const hex = sha256(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type HnsDiscoveryHealthFixture = Readonly<{
  activation_generation?: number;
  health_generation?: number;
  checked_at?: string;
  valid_until?: string;
  delegation_matches?: boolean;
  ds_authenticates_zone?: boolean;
  retained_zone_digest_matches?: boolean;
  gateway_healthy?: boolean;
  stable_chain_delegation_snapshot_reference?: string;
  stable_chain_delegation_snapshot_digest?: string;
  observed_zone_bytes_digest?: string;
  observed_dnssec_keyset_reference?: string;
  observed_dnssec_keyset_version?: string;
  observed_gateway_deployment_reference?: string;
  observed_gateway_certificate_spki_sha256?: string;
}>;

/**
 * One zone shaped like an imported root. Each override breaks exactly one
 * condition; the defaults describe a healthy, published, unexpired zone.
 */
export type HnsDiscoveryZoneFixture = Readonly<{
  root: string;
  published_at: string;
  inventory_expires_at: string;
  checked_at: string;
  valid_until: string;
  dns_zone_activation_id?: string;
  gateway_deployment_reference?: string;
  status?: "active" | "suspended" | "revoked";
  /** Revisions 1 through this generation are written; the last is current. */
  current_generation?: number;
  /** Which part of the revision's inventory binding names no inventory row. */
  inventory_mismatch?: "reference" | "version" | "digest";
  /** Defaults to one healthy observation of the current generation. */
  health?: readonly HnsDiscoveryHealthFixture[];
  /** An app host on `app.<root>`, bound to this zone generation. */
  app_host_generation?: number;
}>;

function hnsDiscoveryZoneIdentity(zone: HnsDiscoveryZoneFixture) {
  const root = zone.root;
  const inventoryBytes = `hns-authority-inventory:${root}`;
  return {
    dns_zone_activation_id: zone.dns_zone_activation_id ?? `hns-dns_${uuidShaped(`dns:${root}`)}`,
    authority_inventory_reference: `hns-authority:${root}`,
    authority_inventory_version: `readiness-${sha256(`readiness:${root}`).slice(0, 16)}`,
    inventory_bytes: inventoryBytes,
    authority_inventory_digest: sha256(inventoryBytes),
    zone_bytes: `$ORIGIN ${root}.\n`,
    zone_bytes_digest: sha256(`$ORIGIN ${root}.\n`),
    dnssec_keyset_reference: `pdns-keyset:${root}`,
    dnssec_keyset_version: sha256(`keyset:${root}`),
    gateway_deployment_reference:
      zone.gateway_deployment_reference ?? "hns-platform-gateway:staging-v1",
    gateway_certificate_spki_sha256: sha256(`spki:${root}`),
    stable_chain_delegation_snapshot_reference: `hns-root-chain:${sha256(`chain:${root}`)}`,
    stable_chain_delegation_snapshot_digest: sha256(`delegation:${root}`),
    app_host_activation_id: `hns-app_${uuidShaped(`app:${root}`)}`,
  };
}

/** Writes retained read-model rows only; the caller owns the transaction. */
export async function insertHnsDiscoveryZone(
  client: Client,
  zone: HnsDiscoveryZoneFixture,
): Promise<void> {
  const identity = hnsDiscoveryZoneIdentity(zone);
  const currentGeneration = zone.current_generation ?? 1;
  await client.query(
    `INSERT INTO hns_authority_inventories (
       registry_reference, authority_inventory_reference, authority_inventory_version,
       authority_inventory_digest, environment, runtime_capability_set_digest,
       inventory_bytes, published_at, expires_at
     ) VALUES (
       'hns-authority:root-import', $1, $2, $3, 'test', repeat('5', 64),
       convert_to($4::text, 'UTF8'), $5::timestamptz, $6::timestamptz
     )`,
    [
      identity.authority_inventory_reference,
      identity.authority_inventory_version,
      identity.authority_inventory_digest,
      identity.inventory_bytes,
      zone.published_at,
      zone.inventory_expires_at,
    ],
  );
  for (let generation = 1; generation <= currentGeneration; generation += 1) {
    const current = generation === currentGeneration;
    const status = current ? (zone.status ?? "active") : "active";
    const activationDocument = `hns-dns-zone-activation:${zone.root}:${generation}`;
    await client.query(
      `INSERT INTO hns_dns_zone_activation_revisions (
         dns_zone_activation_id, dns_zone_activation_generation, activation_document_bytes,
         activation_document_digest, canonical_root, dns_authority_kind,
         dns_authority_reference, dns_authority_generation,
         pirate_dns_authority_inventory_reference, pirate_dns_authority_inventory_version,
         pirate_dns_authority_inventory_digest, zone_revision, zone_bytes, zone_bytes_digest,
         dnssec_keyset_reference, dnssec_keyset_version, gateway_deployment_reference,
         gateway_certificate_spki_sha256, stable_chain_delegation_snapshot_reference,
         stable_chain_delegation_snapshot_digest, status, reason_code, activated_at,
         suspended_at, revoked_at
       ) VALUES (
         $1, $2::bigint, convert_to($3::text, 'UTF8'),
         encode(sha256(convert_to($3::text, 'UTF8')), 'hex'), $4, 'pirate_managed_dns_v1', $5,
         $2::bigint, $6, $7, $8, $2::bigint, convert_to($9::text, 'UTF8'), $10, $11, $12, $13,
         $14, $15, $16, $17::text,
         CASE WHEN $17::text = 'active' THEN NULL ELSE 'operator_review' END, $18::timestamptz,
         CASE WHEN $17::text = 'suspended' THEN $18::timestamptz END,
         CASE WHEN $17::text = 'revoked' THEN $18::timestamptz END
       )`,
      [
        identity.dns_zone_activation_id,
        generation,
        activationDocument,
        zone.root,
        `pdns-zone:${zone.root}`,
        current && zone.inventory_mismatch === "reference"
          ? `${identity.authority_inventory_reference}-other`
          : identity.authority_inventory_reference,
        current && zone.inventory_mismatch === "version"
          ? `${identity.authority_inventory_version}-other`
          : identity.authority_inventory_version,
        current && zone.inventory_mismatch === "digest"
          ? sha256(`other:${zone.root}`)
          : identity.authority_inventory_digest,
        identity.zone_bytes,
        identity.zone_bytes_digest,
        identity.dnssec_keyset_reference,
        identity.dnssec_keyset_version,
        identity.gateway_deployment_reference,
        identity.gateway_certificate_spki_sha256,
        identity.stable_chain_delegation_snapshot_reference,
        identity.stable_chain_delegation_snapshot_digest,
        status,
        zone.published_at,
      ],
    );
  }
  await client.query(
    `INSERT INTO hns_dns_zone_activation_current (
       dns_zone_activation_id, canonical_root, current_generation, updated_at
     ) VALUES ($1, $2, $3::bigint, $4::timestamptz)`,
    [identity.dns_zone_activation_id, zone.root, currentGeneration, zone.published_at],
  );
  const observations = zone.health ?? [{}];
  for (const [index, health] of observations.entries()) {
    await client.query(
      `INSERT INTO hns_dns_zone_health_observations (
         dns_zone_activation_id, activation_generation, health_generation,
         stable_chain_delegation_snapshot_reference, stable_chain_delegation_snapshot_digest,
         observed_zone_bytes_digest, observed_dnssec_keyset_reference,
         observed_dnssec_keyset_version, observed_gateway_deployment_reference,
         observed_gateway_certificate_spki_sha256, delegation_matches, ds_authenticates_zone,
         retained_zone_digest_matches, gateway_healthy, checked_at, valid_until
       ) VALUES (
         $1, $2::bigint, $3::bigint, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15::timestamptz, $16::timestamptz
       )`,
      [
        identity.dns_zone_activation_id,
        health.activation_generation ?? currentGeneration,
        health.health_generation ?? index + 1,
        health.stable_chain_delegation_snapshot_reference ??
          identity.stable_chain_delegation_snapshot_reference,
        health.stable_chain_delegation_snapshot_digest ??
          identity.stable_chain_delegation_snapshot_digest,
        health.observed_zone_bytes_digest ?? identity.zone_bytes_digest,
        health.observed_dnssec_keyset_reference ?? identity.dnssec_keyset_reference,
        health.observed_dnssec_keyset_version ?? identity.dnssec_keyset_version,
        health.observed_gateway_deployment_reference ?? identity.gateway_deployment_reference,
        health.observed_gateway_certificate_spki_sha256 ?? identity.gateway_certificate_spki_sha256,
        health.delegation_matches ?? true,
        health.ds_authenticates_zone ?? true,
        health.retained_zone_digest_matches ?? true,
        health.gateway_healthy ?? true,
        health.checked_at ?? zone.checked_at,
        health.valid_until ?? zone.valid_until,
      ],
    );
  }
  if (zone.app_host_generation === undefined) return;
  await client.query(
    `INSERT INTO hns_community_app_host_activation_revisions (
       app_host_activation_id, app_host_activation_generation, normalized_host,
       canonical_root, community_id, route_binding_id, route_authority_kind,
       route_authority_reference, route_authority_generation, dns_zone_activation_id,
       dns_zone_activation_generation, gateway_deployment_reference, status, activated_at
     ) VALUES (
       $1, 1, 'app.' || $2::text, $2::text, 'community-' || $2::text,
       'route-binding-' || $2::text, 'operator_managed_route_v1',
       'operator-route:' || $2::text, 1, $3, $4::bigint, $5, 'active', $6::timestamptz
     )`,
    [
      identity.app_host_activation_id,
      zone.root,
      identity.dns_zone_activation_id,
      zone.app_host_generation,
      identity.gateway_deployment_reference,
      zone.published_at,
    ],
  );
  await client.query(
    `INSERT INTO hns_community_app_host_activation_current (
       app_host_activation_id, normalized_host, community_id, current_generation, updated_at
     ) VALUES ($1, 'app.' || $2::text, 'community-' || $2::text, 1, $3::timestamptz)`,
    [identity.app_host_activation_id, zone.root, zone.published_at],
  );
}

/**
 * Discovery needs only retained zone state. Foreign-key triggers are disabled
 * transaction-locally, as in the resolver parity fixture, so a binding can be
 * broken without repeating the import ceremony its own suites already cover.
 */
export async function seedHnsDiscoveryZones(
  client: Client,
  schema: string,
  zones: readonly HnsDiscoveryZoneFixture[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}`);
    await client.query("SET LOCAL session_replication_role = replica");
    for (const zone of zones) await insertHnsDiscoveryZone(client, zone);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
