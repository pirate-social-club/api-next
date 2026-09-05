import { Client } from "pg";
import { ContinuityRefusal } from "./refusal.mjs";

export function openContinuityDatabase(connectionString) {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
  return new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000 });
}

export async function readContinuityState(c, root) {
  const one = async (sql, values = []) => {
    const r = await c.query(sql, values);
    if (r.rows.length !== 1) throw new ContinuityRefusal("Expected exactly one retained row");
    return r.rows[0];
  };
  const dns = await one(
    `SELECT r.*,encode(r.zone_bytes,'hex') AS zone_hex FROM hns_dns_zone_activation_current c JOIN hns_dns_zone_activation_revisions r ON r.dns_zone_activation_id=c.dns_zone_activation_id AND r.dns_zone_activation_generation=c.current_generation WHERE c.canonical_root=$1`,
    [root],
  );
  delete dns.zone_bytes;
  const app = await one(
    `SELECT r.* FROM hns_community_app_host_activation_current c JOIN hns_community_app_host_activation_revisions r ON r.app_host_activation_id=c.app_host_activation_id AND r.app_host_activation_generation=c.current_generation WHERE c.normalized_host=$1`,
    [`app.${dns.canonical_root}`],
  );
  const inventory = await one(
    `SELECT registry_reference,encode(inventory_bytes,'hex') AS bytes_hex,published_at,expires_at FROM hns_authority_inventories WHERE authority_inventory_reference=$1 AND authority_inventory_version=$2 AND authority_inventory_digest=$3`,
    [
      dns.pirate_dns_authority_inventory_reference,
      dns.pirate_dns_authority_inventory_version,
      dns.pirate_dns_authority_inventory_digest,
    ],
  );
  const sale = await one(
    `SELECT r.* FROM community_handle_sale_namespace_activation_current c JOIN community_handle_sale_namespace_activation_revisions r ON r.sale_namespace_activation_id=c.sale_namespace_activation_id AND r.sale_namespace_activation_generation=c.current_generation WHERE r.dns_zone_activation_id=$1`,
    [dns.dns_zone_activation_id],
  );
  const health = await one(
    `SELECT * FROM hns_dns_zone_health_observations WHERE dns_zone_activation_id=$1 AND activation_generation=$2 ORDER BY health_generation DESC LIMIT 1`,
    [dns.dns_zone_activation_id, dns.dns_zone_activation_generation],
  );
  if (
    dns.status !== "active" ||
    app.status !== "active" ||
    sale.status !== "active" ||
    app.community_id !== sale.community_id ||
    app.canonical_root !== root ||
    sale.canonical_root !== root ||
    app.dns_zone_activation_id !== dns.dns_zone_activation_id ||
    Number(app.dns_zone_activation_generation) !== Number(dns.dns_zone_activation_generation) ||
    Number(sale.dns_zone_activation_generation) !== Number(dns.dns_zone_activation_generation)
  )
    throw new ContinuityRefusal("Existing root serving dependencies disagree");
  const clock = await one(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_time`,
  );
  const successor = await one(
    `SELECT COALESCE(max(health_generation),0)::text AS generation FROM hns_dns_zone_health_observations WHERE dns_zone_activation_id=$1 AND activation_generation=$2`,
    [dns.dns_zone_activation_id, Number(dns.dns_zone_activation_generation) + 1],
  );
  return {
    dns,
    app,
    inventory,
    sale,
    health,
    ...clock,
    successor_health_generation: Number(successor.generation),
  };
}
