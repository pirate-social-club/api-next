import type { Client } from "pg";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function seedHnsResolverParityFixture(client: Client, schema: string): Promise<void> {
  const quotedSchema = quoteIdentifier(schema);
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quotedSchema}`);
    // The resolver proof needs only retained read-model state. Disable FK
    // triggers transaction-locally so it does not duplicate the full command
    // ceremony already covered by the owning repository suites.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`
      INSERT INTO community_route_ownership_evidence (
        evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
        family, root_label, root_label_display, path_segment,
        requirement_hash, provider_id, provider_binding_hash,
        provider_configuration_version, provider_identity_digest,
        evidence_digest, binding_generation, verified_at, expires_at
      ) VALUES (
        'hns-parity-evidence', 'hns-parity-ceremony', 'hns-parity-actor',
        'hns', 'parity', 'parity', 'app.parity', repeat('1', 64),
        'hns-parity-provider', repeat('2', 64), '1', repeat('3', 64),
        repeat('4', 64), 1, '2026-08-30T00:00:00Z', '2026-09-02T00:00:00Z'
      );

      INSERT INTO communities (
        community_id, display_name, status, created_by_user_id,
        created_at, updated_at, canonical_route_binding_id
      ) VALUES (
        'hns-parity-community', 'HNS parity', 'active', 'hns-parity-actor',
        '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z', 'hns-parity-binding'
      );

      INSERT INTO community_canonical_route_bindings (
        route_binding_id, community_id, family, root_label, root_label_display,
        ownership_status, route_lifecycle_status, binding_generation,
        verified_evidence_ref
      ) VALUES (
        'hns-parity-binding', 'hns-parity-community', 'hns', 'parity', 'parity',
        'verified', 'active', 1, 'hns-parity-evidence'
      );

      INSERT INTO hns_authority_inventories (
        registry_reference, authority_inventory_reference,
        authority_inventory_version, authority_inventory_digest, environment,
        runtime_capability_set_digest, inventory_bytes, published_at, expires_at
      ) VALUES (
        'registry:parity', 'inventory:parity', '1',
        encode(sha256(decode('01', 'hex')), 'hex'), 'test', repeat('5', 64),
        decode('01', 'hex'), '2026-08-30T00:00:00Z', '2026-09-02T00:00:00Z'
      );

      INSERT INTO hns_dns_zone_activation_revisions (
        dns_zone_activation_id, dns_zone_activation_generation,
        activation_document_bytes, activation_document_digest, canonical_root,
        dns_authority_kind, dns_authority_reference, dns_authority_generation,
        pirate_dns_authority_inventory_reference,
        pirate_dns_authority_inventory_version,
        pirate_dns_authority_inventory_digest, zone_revision, zone_bytes,
        zone_bytes_digest, dnssec_keyset_reference, dnssec_keyset_version,
        gateway_deployment_reference, gateway_certificate_spki_sha256,
        stable_chain_delegation_snapshot_reference,
        stable_chain_delegation_snapshot_digest, status, activated_at
      ) VALUES (
        'hns-parity-dns', 1, decode('02', 'hex'),
        encode(sha256(decode('02', 'hex')), 'hex'), 'parity',
        'pirate_managed_dns_v1', 'dns-authority:parity', 1,
        'inventory:parity', '1', encode(sha256(decode('01', 'hex')), 'hex'),
        1, decode('03', 'hex'), encode(sha256(decode('03', 'hex')), 'hex'),
        'keyset-parity', '1', 'gateway-parity', repeat('6', 64),
        'delegation:parity', repeat('7', 64), 'active', '2026-08-30T00:00:00Z'
      );

      INSERT INTO hns_dns_zone_activation_current (
        dns_zone_activation_id, canonical_root, current_generation, updated_at
      ) VALUES ('hns-parity-dns', 'parity', 1, '2026-08-30T00:00:00Z');

      INSERT INTO hns_community_app_host_activation_revisions (
        app_host_activation_id, app_host_activation_generation, normalized_host,
        canonical_root, community_id, route_binding_id, route_authority_kind,
        route_authority_reference, route_authority_generation,
        dns_zone_activation_id, dns_zone_activation_generation,
        gateway_deployment_reference, status, activated_at
      ) VALUES (
        'hns-parity-app', 1, 'app.parity', 'parity', 'hns-parity-community',
        'hns-parity-binding', 'verified_namespace_v1', 'hns-parity-evidence', 1,
        'hns-parity-dns', 1, 'gateway-parity', 'active', '2026-08-30T00:00:00Z'
      );

      INSERT INTO hns_community_app_host_activation_current (
        app_host_activation_id, normalized_host, community_id,
        current_generation, updated_at
      ) VALUES (
        'hns-parity-app', 'app.parity', 'hns-parity-community', 1,
        '2026-08-30T00:00:00Z'
      );
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function readHnsResolverParityBehavior(
  client: Client,
  schema: string,
  databaseNow: Date,
): Promise<{
  readonly activeRoutes: readonly Record<string, unknown>[];
  readonly routeAuthorities: readonly Record<string, unknown>[];
  readonly appHostAuthorities: readonly Record<string, unknown>[];
}> {
  const quotedSchema = quoteIdentifier(schema);
  const activeRoutes = await client.query(
    `SELECT * FROM ${quotedSchema}.effective_active_route('hns-parity-community', $1)`,
    [databaseNow],
  );
  const routeAuthorities = await client.query(
    `SELECT * FROM ${quotedSchema}.effective_route_authority_v2('hns-parity-community', $1)`,
    [databaseNow],
  );
  const appHostAuthorities = await client.query(
    `SELECT * FROM ${quotedSchema}.resolve_hns_community_app_host_authority_v1(
       'app.parity', $1
     )`,
    [databaseNow],
  );
  return {
    activeRoutes: activeRoutes.rows,
    routeAuthorities: routeAuthorities.rows,
    appHostAuthorities: appHostAuthorities.rows,
  };
}
