import { gunzipSync } from "node:zlib";

/** Retain the observed generations while giving the database fixture current validity. */
export async function seedContinuityFixture(client) {
  const raw = JSON.parse(
    gunzipSync(
      await Bun.file(
        new URL("./fixtures/continuity-observation.json.gz", import.meta.url),
      ).arrayBuffer(),
    ).toString(),
  );
  const state = raw.state;
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 86400000).toISOString();
  state.database_time = now;
  state.successor_health_generation = 0;
  raw.chain.observed_at = now;
  raw["zone-primary"].observed_at = now;
  raw["zone-secondary"].observed_at = now;
  raw["authority-verification"].observed_at = Date.parse(now) / 1000;
  raw["authority-verification"].certificate_expires = new Date(
    Date.now() + 30 * 86400000,
  ).toISOString();
  const { dns, app, sale, health } = state;
  const inventory = JSON.parse(Buffer.from(state.inventory.bytes_hex, "hex").toString());
  async function insert(table, row) {
    const columns = Object.keys(row);
    if (![table, ...columns].every((entry) => /^[a-z_][a-z0-9_]*$/u.test(entry)))
      throw new Error("Unsafe fixture identifier");
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
      Object.values(row),
    );
  }
  await client.query("SET session_replication_role = replica");
  try {
    await insert("users", { user_id: sale.actor_account_id, status: "active" });
    await insert("communities", {
      community_id: app.community_id,
      display_name: "Continuity fixture",
      status: "active",
      created_by_user_id: sale.actor_account_id,
      created_at: now,
      updated_at: now,
      route_slug: null,
      route_authority_version: "optional_route_v2",
      canonical_route_binding_id: app.route_binding_id,
    });
    await insert("community_route_ownership_evidence", {
      evidence_ref: sale.namespace_authority_reference,
      creation_ceremony_intent_id: "continuity-fixture-ceremony",
      verified_by_actor_id: sale.actor_account_id,
      family: "hns",
      root_label: dns.canonical_root,
      root_label_display: dns.canonical_root,
      path_segment: `app.${dns.canonical_root}`,
      requirement_hash: "1".repeat(64),
      provider_id: "continuity-fixture-provider",
      provider_binding_hash: "2".repeat(64),
      provider_configuration_version: "1",
      provider_identity_digest: "3".repeat(64),
      evidence_digest: "4".repeat(64),
      binding_generation: sale.namespace_authority_generation,
      verified_at: now,
      expires_at: until,
      origin: "creation_ceremony",
    });
    await insert("community_canonical_route_bindings", {
      route_binding_id: app.route_binding_id,
      community_id: app.community_id,
      family: "hns",
      root_label: dns.canonical_root,
      root_label_display: dns.canonical_root,
      ownership_status: "verified",
      route_lifecycle_status: "active",
      binding_generation: sale.namespace_authority_generation,
      verified_evidence_ref: sale.namespace_authority_reference,
    });
    await insert("community_handle_sales_authority_grants", {
      grant_id: sale.authority_grant_id,
      community_id: sale.community_id,
      principal_account_id: sale.actor_account_id,
      authority: "manage_handle_sales",
      source_kind: "creator_owner",
      status: "active",
      granted_at: now,
      granted_by_account_id: sale.actor_account_id,
    });
    await insert("hns_authority_inventories", {
      registry_reference: state.inventory.registry_reference,
      authority_inventory_reference: inventory.authority_inventory_reference,
      authority_inventory_version: inventory.authority_inventory_version,
      authority_inventory_digest: dns.pirate_dns_authority_inventory_digest,
      environment: inventory.environment,
      runtime_capability_set_digest: inventory.runtime_capability_set_digest,
      inventory_bytes: Buffer.from(state.inventory.bytes_hex, "hex"),
      published_at: new Date(Date.now() - 60000).toISOString(),
      expires_at: until,
    });
    const { zone_hex, activation_document_bytes, ...dnsRow } = dns;
    await insert("hns_dns_zone_activation_revisions", {
      ...dnsRow,
      zone_bytes: Buffer.from(zone_hex, "hex"),
      activation_document_bytes: Buffer.from(activation_document_bytes.data),
    });
    await insert("hns_dns_zone_activation_current", {
      dns_zone_activation_id: dns.dns_zone_activation_id,
      canonical_root: dns.canonical_root,
      current_generation: dns.dns_zone_activation_generation,
      updated_at: now,
    });
    await insert("hns_dns_zone_health_observations", {
      ...health,
      checked_at: now,
      valid_until: until,
    });
    await insert("hns_community_app_host_activation_revisions", app);
    await insert("hns_community_app_host_activation_current", {
      app_host_activation_id: app.app_host_activation_id,
      normalized_host: app.normalized_host,
      community_id: app.community_id,
      current_generation: app.app_host_activation_generation,
      updated_at: now,
    });
    await insert("community_handle_sale_namespace_activation_revisions", sale);
    await insert("community_handle_sale_namespace_activation_current", {
      sale_namespace_activation_id: sale.sale_namespace_activation_id,
      family: sale.family,
      canonical_root: sale.canonical_root,
      community_id: sale.community_id,
      current_generation: sale.sale_namespace_activation_generation,
      updated_at: now,
    });
  } finally {
    await client.query("SET session_replication_role = origin");
  }
  return {
    state,
    chain: raw.chain,
    primary: raw["zone-primary"],
    secondary: raw["zone-secondary"],
    verification: raw["authority-verification"],
    sourceCommit: "7d3c8aae24240faf7dde3e35fb359f96caa934b7",
  };
}
