import { resolveActiveHnsHostAuthority } from "../../packages/application/src/hns-host-serving.ts";
import { readCurrentHnsStagingOwnerRecovery } from "../../packages/platform-cf/src/hns-staging-owner-txt-recovery.ts";
import { transactionAuthoritySources } from "./authority.ts";
import { decodeCookieCensus, NEXT_GATEWAY, PREVIOUS_GATEWAY } from "./cookie-plan.ts";
import { digest, fail, stateIdentity } from "./identity.mjs";

// Every query is fixed source, never an operator-supplied table or predicate.
const snapshots = {
  community_handle_sales_authority_grants:
    "t.community_id IN (SELECT community_id FROM community_canonical_route_bindings WHERE family='hns' AND root_label=$1)",
  communities:
    "t.community_id IN (SELECT community_id FROM community_canonical_route_bindings WHERE family='hns' AND root_label=$1)",
  community_canonical_route_bindings: "t.family='hns' AND t.root_label=$1",
  community_route_ownership_evidence: "t.family='hns' AND t.root_label=$1",
  community_route_hns_control_identities: "t.root_label=$1",
  community_route_lifecycle_transitions: "t.family='hns' AND t.root_label=$1",
  community_route_revalidation_sessions: "t.family='hns' AND t.root_label=$1",
  community_route_revalidation_completion_attempts:
    "t.route_binding_id IN (SELECT route_binding_id FROM community_canonical_route_bindings WHERE family='hns' AND root_label=$1)",
  community_route_revalidation_evidence_snapshots: "t.family='hns' AND t.root_label=$1",
  hns_dns_zone_activation_current: "t.canonical_root=$1",
  hns_root_import_activation_operations:
    "t.dns_zone_activation_id IN (SELECT dns_zone_activation_id FROM hns_dns_zone_activation_current WHERE canonical_root=$1)",
  hns_dns_zone_activation_revisions: "t.canonical_root=$1",
  hns_dns_zone_activation_operations:
    "t.dns_zone_activation_id IN (SELECT dns_zone_activation_id FROM hns_dns_zone_activation_current WHERE canonical_root=$1)",
  hns_dns_zone_lifecycle_operations:
    "t.dns_zone_activation_id IN (SELECT dns_zone_activation_id FROM hns_dns_zone_activation_current WHERE canonical_root=$1)",
  hns_dns_zone_health_observations:
    "t.dns_zone_activation_id IN (SELECT dns_zone_activation_id FROM hns_dns_zone_activation_current WHERE canonical_root=$1)",
  hns_dns_zone_health_operations:
    "t.dns_zone_activation_id IN (SELECT dns_zone_activation_id FROM hns_dns_zone_activation_current WHERE canonical_root=$1)",
  hns_community_app_host_activation_current:
    "t.app_host_activation_id IN (SELECT app_host_activation_id FROM hns_community_app_host_activation_revisions WHERE canonical_root=$1)",
  hns_community_app_host_activation_revisions: "t.canonical_root=$1",
  hns_community_app_host_operations:
    "t.app_host_activation_id IN (SELECT app_host_activation_id FROM hns_community_app_host_activation_revisions WHERE canonical_root=$1)",
  community_handle_sale_namespace_activation_current: "t.family='hns' AND t.canonical_root=$1",
  community_handle_sale_namespace_activation_revisions: "t.family='hns' AND t.canonical_root=$1",
  community_handle_sale_namespace_activation_actions:
    "t.sale_namespace_activation_id IN (SELECT sale_namespace_activation_id FROM community_handle_sale_namespace_activation_current WHERE family='hns' AND canonical_root=$1)",
  hns_authority_inventories:
    "EXISTS (SELECT 1 FROM hns_dns_zone_activation_revisions d WHERE d.canonical_root=$1 AND d.pirate_dns_authority_inventory_reference=t.authority_inventory_reference AND d.pirate_dns_authority_inventory_version=t.authority_inventory_version AND d.pirate_dns_authority_inventory_digest=t.authority_inventory_digest)",
  handle_grants: "t.family='hns' AND t.namespace_root=$1",
  personas:
    "t.persona_id IN (SELECT owner_persona_id FROM handle_grants WHERE family='hns' AND namespace_root=$1)",
};
const promotedTables = new Set([
  "hns_dns_zone_activation_current",
  "hns_dns_zone_activation_revisions",
  "hns_dns_zone_activation_operations",
  "hns_dns_zone_lifecycle_operations",
  "hns_dns_zone_health_observations",
  "hns_dns_zone_health_operations",
  "hns_community_app_host_activation_current",
  "hns_community_app_host_activation_revisions",
  "hns_community_app_host_operations",
  "community_handle_sale_namespace_activation_current",
  "community_handle_sale_namespace_activation_revisions",
  "community_handle_sale_namespace_activation_actions",
]);
export const COOKIE_CENSUS_TABLES = Object.freeze(Object.keys(snapshots).sort());

/** The global native endpoint changes for every tenant. A serializable snapshot
 * alone does not exclude a newly inserted tenant that can serialize afterward.
 * These short, ordered table locks freeze the full reviewed authority census,
 * including absent rows. They require explicit exclusive operational custody. */
export async function lockCookieCensus(client) {
  await client.query(
    `LOCK TABLE ${Object.keys(snapshots).sort().join(",")} IN SHARE ROW EXCLUSIVE MODE`,
  );
}

async function gatewayRoots(client) {
  const result = await client.query(
    `
    SELECT canonical_root FROM (
      SELECT d.canonical_root FROM hns_dns_zone_activation_current c
      JOIN hns_dns_zone_activation_revisions d ON d.dns_zone_activation_id=c.dns_zone_activation_id
        AND d.dns_zone_activation_generation=c.current_generation
      WHERE d.gateway_deployment_reference=ANY($1::text[])
      UNION
      SELECT a.canonical_root FROM hns_community_app_host_activation_current c
      JOIN hns_community_app_host_activation_revisions a ON a.app_host_activation_id=c.app_host_activation_id
        AND a.app_host_activation_generation=c.current_generation
      WHERE a.gateway_deployment_reference=ANY($1::text[])
      UNION
      SELECT s.canonical_root FROM community_handle_sale_namespace_activation_current c
      JOIN community_handle_sale_namespace_activation_revisions s ON s.sale_namespace_activation_id=c.sale_namespace_activation_id
        AND s.sale_namespace_activation_generation=c.current_generation
      JOIN hns_dns_zone_activation_revisions d ON d.dns_zone_activation_id=s.dns_zone_activation_id
        AND d.dns_zone_activation_generation=s.dns_zone_activation_generation
      WHERE d.gateway_deployment_reference=ANY($1::text[])
    ) roots ORDER BY canonical_root`,
    [[PREVIOUS_GATEWAY, NEXT_GATEWAY]],
  );
  fail(result.rows.length > 0 && result.rows.length <= 100, "Gateway root census size invalid");
  return result.rows.map((row) => row.canonical_root);
}

export async function readCookieCensus(client, expectedRoots) {
  const sources = transactionAuthoritySources(client);
  const roots = [];
  const observedRoots = await gatewayRoots(client);
  if (expectedRoots !== undefined)
    fail(
      JSON.stringify(observedRoots) === JSON.stringify(expectedRoots),
      "Gateway root set changed",
    );
  for (const root of observedRoots) {
    const rows = {};
    for (const [table, predicate] of Object.entries(snapshots)) {
      const result = await client.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${predicate} ORDER BY to_jsonb(t)::text LIMIT 10001`,
        [root],
      );
      fail(result.rows.length <= 10000, "Cookie authority census exceeds row bound");
      rows[table] = result.rows.map((row) => row.row);
    }
    const apps = [];
    for (const row of rows.hns_community_app_host_activation_current)
      apps.push({ host: row.normalized_host, state: await sources.app(row.normalized_host) });
    apps.sort((a, b) => a.host.localeCompare(b.host));
    const handles = [];
    for (const row of rows.handle_grants) {
      const host = `${row.handle_label}.${row.namespace_root}`;
      handles.push({ host, state: await sources.handle(host) });
    }
    handles.sort((a, b) => a.host.localeCompare(b.host));
    let recovery = null;
    if (root === "8s28") {
      fail(apps.length === 1 && apps[0].state !== null, "Selected app authority unreadable");
      const app = apps[0].state;
      const imports = await client.query(
        "SELECT root_import_session_id FROM hns_root_import_activation_operations WHERE dns_zone_activation_id=$1",
        [app.activation_dns_zone_id],
      );
      fail(imports.rows.length === 1, "Selected imported authority is ambiguous");
      recovery = await readCurrentHnsStagingOwnerRecovery(client, {
        community_id: app.community_id,
        route_binding_id: app.route_binding_id,
        root_import_session_id: imports.rows[0].root_import_session_id,
        lock: false,
      });
    }
    roots.push({ root, rows, apps, handles, recovery });
  }
  const clock = await client.query(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_time`,
  );
  const census = JSON.parse(JSON.stringify({ database_time: clock.rows[0].database_time, roots }));
  fail(
    Buffer.byteLength(JSON.stringify(census)) <= 6 * 1024 * 1024,
    "Cookie census byte bound exceeded",
  );
  return decodeCookieCensus(census);
}

function active(host) {
  fail(host.state !== null && typeof host.state === "object", "Unknown host authority in census");
  return resolveActiveHnsHostAuthority(host.state) !== null;
}
export function requireCookieCensus(value, selectedState, gateway = PREVIOUS_GATEWAY) {
  const census = decodeCookieCensus(value);
  const names = census.roots.map((root) => root.root);
  fail(
    JSON.stringify(names) === JSON.stringify(["8s28", "a18n"]),
    "Unknown or incomplete co-tenant root set",
  );
  fail(
    names.includes("8s28") && JSON.stringify(names) === JSON.stringify([...new Set(names)].sort()),
    "Incomplete or reordered gateway census",
  );
  for (const tenant of census.roots) {
    fail(
      JSON.stringify(Object.keys(tenant.rows).sort()) ===
        JSON.stringify(Object.keys(snapshots).sort()),
      "Incomplete authority table census",
    );
    fail(
      tenant.apps.length === 1 && tenant.apps[0].host === `app.${tenant.root}`,
      "Incomplete app census",
    );
    fail(
      JSON.stringify(tenant.handles.map((h) => h.host)) ===
        JSON.stringify(
          tenant.rows.handle_grants.map((r) => `${r.handle_label}.${r.namespace_root}`).sort(),
        ),
      "Incomplete claimed-handle census",
    );
    if (tenant.root !== "8s28") {
      fail(tenant.recovery === null, "Unselected recovery is outside scope");
      for (const host of [...tenant.apps, ...tenant.handles]) {
        fail(!active(host), "An unselected co-tenant is available");
        const s = host.state;
        fail(
          s.dns_zone.gateway_deployment_reference !== NEXT_GATEWAY,
          "Unexpected already-promoted co-tenant",
        );
      }
      continue;
    }
    const app = tenant.apps[0];
    const proof = tenant.recovery;
    fail(
      active(app) &&
        app.state.variant === "community_app_v1" &&
        app.state.activation_gateway_deployment_reference === gateway &&
        app.state.dns_zone.gateway_deployment_reference === gateway &&
        proof !== null &&
        proof.root_label === "8s28" &&
        proof.evidence_ref === app.state.route_authority_reference &&
        Number(proof.binding_generation) === app.state.route_authority_generation &&
        Date.parse(proof.expires_at) > Date.parse(census.database_time),
      "Selected genuine recovered authority is unavailable",
    );
    if (selectedState !== undefined)
      fail(
        selectedState.dns.canonical_root === "8s28" &&
          selectedState.app.route_authority_reference === proof.evidence_ref &&
          selectedState.sale.namespace_authority_reference === proof.evidence_ref &&
          Number(selectedState.sale.namespace_authority_generation) ===
            Number(proof.binding_generation),
        "Selected recovery and serving predecessors disagree",
      );
    if (selectedState !== undefined) {
      const grants = tenant.rows.community_handle_sales_authority_grants.filter(
        (grant) =>
          grant.community_id === selectedState.sale.community_id &&
          grant.principal_account_id === selectedState.sale.actor_account_id &&
          grant.authority === "manage_handle_sales" &&
          grant.status === "active",
      );
      fail(
        grants.length === 1 && grants[0].grant_id === selectedState.sale.authority_grant_id,
        "Selected sales authority is missing, ambiguous or changed",
      );
    }
    for (const host of tenant.handles) active(host);
  }
  return census;
}

export function requireUnchangedCookieCensus(before, after, promoted) {
  fail(
    JSON.stringify(before.roots.map((r) => r.root)) ===
      JSON.stringify(after.roots.map((r) => r.root)),
    "Gateway root set changed",
  );
  for (let i = 0; i < before.roots.length; i++) {
    const previous = before.roots[i],
      next = after.roots[i];
    if (!promoted || previous.root !== "8s28") {
      fail(digest(previous) === digest(next), "Co-tenant authority census changed");
      continue;
    }
    for (const table of Object.keys(snapshots))
      if (!promotedTables.has(table))
        fail(
          digest(previous.rows[table]) === digest(next.rows[table]),
          "Promotion changed unrelated authority rows",
        );
    fail(
      JSON.stringify(previous.handles.map((h) => h.host)) ===
        JSON.stringify(next.handles.map((h) => h.host)),
      "Claimed handle set changed",
    );
    for (let h = 0; h < previous.handles.length; h++)
      fail(
        active(previous.handles[h]) === active(next.handles[h]),
        "Claimed handle availability changed",
      );
  }
}

export const cookieCensusIdentity = stateIdentity;
