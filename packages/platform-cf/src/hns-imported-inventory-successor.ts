import type { Client } from "pg";
import {
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsDnsZoneActivationDocumentV1,
} from "../../application/src/hns-host-persistence.ts";
import { decodeHnsRootImportReadinessResultV1 } from "../../application/src/namespace-ownership/hns-root-import-readiness.ts";
import { promoteHnsAuthoritySuccessorInTransaction } from "./hns-authority-successor-promotion.ts";

type State = {
  dns_zone_activation_id: string;
  dns_generation: string;
  zone_revision: string;
  dns_authority_kind: "pirate_managed_dns_v1";
  dns_authority_reference: string;
  dns_status: string;
  app_status: string;
  sale_status: string;
  app_host_activation_id: string;
  app_generation: string;
  app_dns_generation: string;
  sale_dns_generation: string;
  registry_reference: string;
  environment: string;
  stable_chain_delegation_snapshot_reference: string;
  stable_chain_delegation_snapshot_digest: string;
  actor_account_id: string;
  community_id: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_hash: string;
  namespace_authority_reference: string;
  namespace_authority_generation: string;
  sale_namespace_activation_generation: string;
  database_time: Date;
};

// The caller already holds renewal job, session and predecessor DNS locks.
export async function promoteImportedHnsInventorySuccessor(
  client: Client,
  resultBytes: Uint8Array,
  resultSha256: string,
) {
  const decoded = await decodeHnsRootImportReadinessResultV1(resultBytes);
  const result = decoded.result;
  const rows = await client.query<State>(
    `SELECT
    dns.dns_zone_activation_id, dns.current_generation AS dns_generation,
    revision.dns_authority_kind, revision.dns_authority_reference, revision.zone_revision, revision.status AS dns_status,
    revision.stable_chain_delegation_snapshot_reference, revision.stable_chain_delegation_snapshot_digest,
    app.app_host_activation_id, app.current_generation AS app_generation,
    app_revision.status AS app_status, app_revision.dns_zone_activation_generation AS app_dns_generation,
    sale_revision.*, sale_revision.status AS sale_status,
    sale_revision.dns_zone_activation_generation AS sale_dns_generation,
    inventory.registry_reference, inventory.environment, clock_timestamp() AS database_time
    FROM hns_dns_zone_activation_current dns
    JOIN hns_dns_zone_activation_revisions revision ON revision.dns_zone_activation_id=dns.dns_zone_activation_id AND revision.dns_zone_activation_generation=dns.current_generation
    JOIN hns_root_import_activation_operations activation ON activation.dns_zone_activation_id=dns.dns_zone_activation_id AND activation.root_import_session_id=$1
    JOIN hns_community_app_host_activation_current app ON app.app_host_activation_id=activation.app_host_activation_id
    JOIN hns_community_app_host_activation_revisions app_revision ON app_revision.app_host_activation_id=app.app_host_activation_id AND app_revision.app_host_activation_generation=app.current_generation
    JOIN community_handle_sale_namespace_activation_current sale ON sale.sale_namespace_activation_id=activation.sale_namespace_activation_id
    JOIN community_handle_sale_namespace_activation_revisions sale_revision ON sale_revision.sale_namespace_activation_id=sale.sale_namespace_activation_id AND sale_revision.sale_namespace_activation_generation=sale.current_generation
    JOIN hns_authority_inventories inventory ON inventory.authority_inventory_reference=revision.pirate_dns_authority_inventory_reference AND inventory.authority_inventory_version=revision.pirate_dns_authority_inventory_version AND inventory.authority_inventory_digest=revision.pirate_dns_authority_inventory_digest
    WHERE dns.canonical_root=$2 AND app_revision.community_id=sale_revision.community_id
      AND app_revision.dns_zone_activation_id=dns.dns_zone_activation_id
      AND sale_revision.dns_zone_activation_id=dns.dns_zone_activation_id
    FOR UPDATE OF app, sale`,
    [result.root_import_session_id, result.root_label],
  );
  const state = rows.rows[0];
  if (
    rows.rows.length !== 1 ||
    state === undefined ||
    state.dns_status !== "active" ||
    state.app_status !== "active" ||
    state.sale_status !== "active" ||
    state.app_dns_generation !== state.dns_generation ||
    state.sale_dns_generation !== state.dns_generation
  )
    throw new Error("HNS successor serving dependencies changed");
  // Predecessor structure remains fenced even after its evidence expires.
  // Fresh observed evidence below restores serving; requiring old liveness
  // here would make an expiry outage impossible to recover automatically.
  const dependency = await client.query(
    `SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,clock_timestamp())`,
    [
      state.community_id,
      state.namespace_authority_reference,
      Number(state.namespace_authority_generation),
      state.dns_zone_activation_id,
      Number(state.dns_generation),
    ],
  );
  if (
    dependency.rows.length !== 1 ||
    !dependency.rows[0].namespace_authority_current ||
    dependency.rows[0].canonical_root !== result.root_label
  )
    throw new Error("HNS successor namespace authority changed");
  if (decoded.authority_inventory.environment !== state.environment)
    throw new Error("HNS successor inventory environment changed");
  const observed = Date.parse(result.observed_at);
  const now = state.database_time.getTime();
  const expires = Math.min(
    Date.parse(result.valid_until),
    Date.parse(decoded.authority_inventory.expires_at),
  );
  const remaining = Math.floor((expires - now) / 1000);
  if (
    observed > now ||
    now - observed > 3_600_000 ||
    expires - observed > 604_800_000 ||
    remaining < 1 ||
    remaining > 604_800
  )
    throw new Error("HNS successor observation is stale");
  const generation = Number(state.dns_generation) + 1;
  const healthRows = await client.query<{ generation: string }>(
    "SELECT COALESCE(max(health_generation),0)::text AS generation FROM hns_dns_zone_health_observations WHERE dns_zone_activation_id=$1 AND activation_generation=$2",
    [state.dns_zone_activation_id, generation],
  );
  const healthGeneration = Number(healthRows.rows[0]?.generation);
  if (!Number.isSafeInteger(healthGeneration) || healthGeneration < 0)
    throw new Error("HNS successor health fence is invalid");
  const dns = await prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: state.dns_zone_activation_id,
      canonical_root: result.root_label,
      dns_authority: [state.dns_authority_kind, state.dns_authority_reference, generation],
      pirate_dns_authority_inventory: [
        result.authority_inventory_reference,
        result.authority_inventory_version,
        result.authority_inventory_digest,
      ],
      zone_revision: Number(state.zone_revision) + 1,
      dnssec_keyset: [result.dnssec_keyset_reference, result.dnssec_keyset_version],
      gateway: [result.gateway_deployment_reference, result.gateway_certificate_spki_sha256],
      stable_chain_delegation_snapshot: [
        state.stable_chain_delegation_snapshot_reference,
        state.stable_chain_delegation_snapshot_digest,
      ],
    },
    zone_bytes: decoded.managed_zone_bytes,
  });
  const operation = (kind: string) => ({
    operation_id: `hns-inventory-renewal:${kind}:${resultSha256}`,
    idempotency_key: `hns-inventory-renewal:${kind}:${resultSha256}`,
    request_hash: resultSha256,
  });
  return promoteHnsAuthoritySuccessorInTransaction({
    client,
    inventoryRegistryReference: state.registry_reference,
    authorityInventoryBytes: Buffer.from(result.authority_inventory_bytes_hex, "hex"),
    dnsActivationBytes: encodeHnsDnsZonePersistenceDocumentV1(dns),
    appActivationBytes: encodeHnsAppHostTransitionDocumentV1({
      ...operation("app"),
      app_host_activation_id: state.app_host_activation_id,
      expected_activation_generation: Number(state.app_generation),
      target_status: "active",
      reason_code: "canonical-authority",
    }),
    healthObservationBytes: encodeHnsDnsHealthDocumentV1({
      ...operation("health"),
      dns_zone_activation_id: state.dns_zone_activation_id,
      activation_generation: generation,
      expected_health_generation: healthGeneration,
      stable_chain_delegation_snapshot_reference: state.stable_chain_delegation_snapshot_reference,
      stable_chain_delegation_snapshot_digest: state.stable_chain_delegation_snapshot_digest,
      observed_zone_bytes_digest: result.observed_zone_bytes_sha256,
      observed_dnssec_keyset_reference: result.dnssec_keyset_reference,
      observed_dnssec_keyset_version: result.dnssec_keyset_version,
      observed_gateway_deployment_reference: result.gateway_deployment_reference,
      observed_gateway_certificate_spki_sha256: result.gateway_certificate_spki_sha256,
      delegation_matches: true,
      ds_authenticates_zone: true,
      retained_zone_digest_matches: true,
      gateway_healthy: true,
      valid_for_seconds: remaining,
    }),
    successorId: resultSha256,
    rootLabel: result.root_label,
    generations: {
      dns_activation_generation: generation,
      app_host_activation_generation: Number(state.app_generation) + 1,
      health_generation: healthGeneration + 1,
    },
    sale: state,
  });
}
