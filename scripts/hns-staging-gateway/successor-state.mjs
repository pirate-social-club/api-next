import {
  decodeHnsDnsHealthDocumentV1,
  decodeHnsDnsZonePersistenceDocumentV1,
} from "../../packages/application/src/hns-host-persistence.ts";
import { handleSaleNamespaceActivationHash } from "../../packages/domain/src/handles/sales-v2.ts";
import { NEXT_GATEWAY } from "./cookie-plan.ts";
import { bytes, digest, fail, sha } from "./identity.mjs";

const addedRows = {
  hns_dns_zone_activation_revisions: 1,
  hns_dns_zone_activation_operations: 1,
  hns_dns_zone_lifecycle_operations: 0,
  hns_dns_zone_health_observations: 1,
  hns_dns_zone_health_operations: 1,
  hns_community_app_host_activation_revisions: 1,
  hns_community_app_host_operations: 1,
  community_handle_sale_namespace_activation_revisions: 1,
  community_handle_sale_namespace_activation_actions: 1,
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const projection = (row, ignored) =>
  Object.fromEntries(
    Object.entries(plain(row))
      .filter(([key]) => !ignored.includes(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
const same = (actual, expected, ignored, label) =>
  fail(digest(projection(actual, ignored)) === digest(projection(expected, ignored)), label);

/** Match the reviewed operation's complete stored meaning, not supplied intent
 * hashes alone. Normal writers do not retain full app/health input bytes. */
export async function requireExactCookieSuccessor(plan, census, current) {
  const entry = plan.entries[0],
    previous = entry.predecessor;
  const before = plan.census.roots.find((tenant) => tenant.root === "8s28");
  const after = census.roots.find((tenant) => tenant.root === "8s28");
  fail(before !== undefined && after !== undefined, "Selected successor census missing");
  const within = (value) =>
    Number.isFinite(new Date(value).getTime()) &&
    new Date(value).getTime() >= Date.parse(plan.census.database_time) &&
    new Date(value).getTime() <= Date.parse(plan.execute_by);
  for (const [table, count] of Object.entries(addedRows)) {
    const old = before.rows[table],
      next = after.rows[table];
    const retained = new Set(next.map(digest));
    fail(
      next.length === old.length + count && old.every((row) => retained.has(digest(row))),
      "Selected successor history/count mismatch",
    );
  }
  const dns = await decodeHnsDnsZonePersistenceDocumentV1(bytes(entry.dns_hex));
  const health = decodeHnsDnsHealthDocumentV1(bytes(entry.health_hex));
  const expectedDns = {
    ...previous.dns,
    dns_zone_activation_generation: String(entry.generations.dns_activation_generation),
    dns_authority_generation: String(dns.dns_authority_generation),
    zone_revision: String(dns.zone_revision),
    gateway_deployment_reference: NEXT_GATEWAY,
    activation_document_bytes: Buffer.from(dns.activation_document_bytes),
    activation_document_digest: sha(dns.activation_document_bytes),
    status: "active",
    reason_code: null,
    suspended_at: null,
    revoked_at: null,
  };
  same(
    current.dns,
    expectedDns,
    ["activated_at", "recorded_at"],
    "Selected DNS successor differs from reviewed document",
  );
  fail(
    within(current.dns.activated_at) && within(current.dns.recorded_at),
    "Selected DNS successor time mismatch",
  );
  same(
    current.app,
    {
      ...previous.app,
      app_host_activation_generation: String(entry.generations.app_host_activation_generation),
      dns_zone_activation_generation: String(entry.generations.dns_activation_generation),
      gateway_deployment_reference: NEXT_GATEWAY,
      status: "active",
      reason_code: null,
      suspended_at: null,
      revoked_at: null,
    },
    ["recorded_at"],
    "Selected app successor differs from reviewed transition",
  );
  fail(within(current.app.recorded_at), "Selected app successor time mismatch");
  same(
    current.health,
    {
      ...previous.health,
      activation_generation: String(entry.generations.dns_activation_generation),
      health_generation: String(entry.generations.health_generation),
      observed_gateway_deployment_reference: NEXT_GATEWAY,
    },
    ["checked_at", "valid_until"],
    "Selected health successor differs from reviewed facts",
  );
  fail(
    within(current.health.checked_at) &&
      new Date(current.health.valid_until).getTime() -
        new Date(current.health.checked_at).getTime() ===
        health.valid_for_seconds * 1000 &&
      new Date(current.health.valid_until).getTime() <= Date.parse(entry.health_deadline),
    "Selected health successor differs from reviewed lifetime",
  );

  const saleHash = handleSaleNamespaceActivationHash({
    sale_namespace_activation_id: previous.sale.sale_namespace_activation_id,
    sale_namespace_activation_generation:
      Number(previous.sale.sale_namespace_activation_generation) + 1,
    community_id: previous.sale.community_id,
    family: "hns",
    canonical_root: "8s28",
    namespace_authority_reference: previous.sale.namespace_authority_reference,
    namespace_authority_generation: Number(previous.sale.namespace_authority_generation),
    dns_zone_activation_id: previous.dns.dns_zone_activation_id,
    dns_zone_activation_generation: entry.generations.dns_activation_generation,
  }).sha256;
  same(
    current.sale,
    {
      ...previous.sale,
      sale_namespace_activation_generation: String(
        Number(previous.sale.sale_namespace_activation_generation) + 1,
      ),
      sale_namespace_activation_hash: saleHash,
      dns_zone_activation_generation: String(entry.generations.dns_activation_generation),
      status: "active",
      reason_code: null,
      suspended_at: null,
      revoked_at: null,
    },
    ["recorded_at"],
    "Selected sale successor differs from reviewed authority",
  );
  fail(within(current.sale.recorded_at), "Selected sale successor time mismatch");

  const one = (table, key, value) => {
    const rows = after.rows[table].filter((row) => row[key] === value);
    fail(rows.length === 1, "Selected operation receipt is absent or ambiguous");
    fail(within(rows[0].committed_at), "Selected operation receipt time mismatch");
    return rows[0];
  };
  const appId = `staging-gateway:app:${entry.successor_id}`;
  same(
    one("hns_community_app_host_operations", "operation_id", appId),
    {
      operation_id: appId,
      operation_kind: "transition",
      idempotency_key: appId,
      request_hash: entry.successor_id,
      app_host_activation_id: previous.app.app_host_activation_id,
      expected_activation_generation: Number(previous.app.app_host_activation_generation),
      target_status: "active",
      result_activation_generation: entry.generations.app_host_activation_generation,
    },
    ["committed_at"],
    "Selected app operation differs from reviewed intent",
  );
  const healthId = `staging-gateway:health:${entry.successor_id}`;
  same(
    one("hns_dns_zone_health_operations", "operation_id", healthId),
    {
      operation_id: healthId,
      idempotency_key: healthId,
      request_hash: entry.successor_id,
      dns_zone_activation_id: previous.dns.dns_zone_activation_id,
      activation_generation: entry.generations.dns_activation_generation,
      expected_health_generation: entry.generations.health_generation - 1,
      result_health_generation: entry.generations.health_generation,
    },
    ["committed_at"],
    "Selected health operation differs from reviewed intent",
  );
  const saleId = `hns-continuity-sale:${entry.successor_id}`;
  const saleRequest = {
    account_id: previous.sale.actor_account_id,
    community_id: previous.sale.community_id,
    activation_id: previous.sale.sale_namespace_activation_id,
    idempotency_key: saleId,
    expected_activation_hash: previous.sale.sale_namespace_activation_hash,
    requested_status: "active",
    namespace_authority_reference: previous.sale.namespace_authority_reference,
    expected_namespace_authority_generation: Number(previous.sale.namespace_authority_generation),
    dns_zone_activation_id: previous.dns.dns_zone_activation_id,
    expected_dns_zone_activation_generation: entry.generations.dns_activation_generation,
    dedicated_root_replacement_confirmed: true,
  };
  same(
    one("community_handle_sale_namespace_activation_actions", "action_id", saleId),
    {
      action_id: saleId,
      actor_account_id: previous.sale.actor_account_id,
      community_id: previous.sale.community_id,
      endpoint_template: "/communities/:communityId/handle-sale-namespaces/:activationId/revisions",
      idempotency_key: saleId,
      request_hash: digest(["pirate-handle-sale-namespace-revise-request-v1", saleRequest]),
      sale_namespace_activation_id: previous.sale.sale_namespace_activation_id,
      expected_activation_generation: Number(previous.sale.sale_namespace_activation_generation),
      result_activation_generation: Number(previous.sale.sale_namespace_activation_generation) + 1,
      result_activation_hash: saleHash,
    },
    ["committed_at"],
    "Selected sale action differs from reviewed intent",
  );
}
