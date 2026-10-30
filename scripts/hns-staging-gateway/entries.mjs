import {
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsDnsZoneActivationDocumentV1,
} from "../../packages/application/src/hns-host-persistence.ts";
import { decodeHnsAuthorityInventoryBytes } from "../../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import { requireHnsReviewedGatewayRotation } from "../../packages/platform-cf/src/hns-gateway-rotation.ts";
import { bytes, digest, fail, reference, sha, stateIdentity } from "./identity.mjs";

/** Mode-specific manifest, root and tenant validation belongs to the caller. */
export async function prepareGatewayEntries({
  states,
  previousManifest,
  nextManifest,
  readiness,
  sourceCommit,
  executeBy,
}) {
  const after = JSON.parse(nextManifest);
  fail(/^[0-9a-f]{40}$/u.test(sourceCommit), "Source commit invalid");
  const observed = Math.max(...states.map((state) => Date.parse(state.database_time)));
  const deadline = Date.parse(executeBy);
  fail(
    Number.isFinite(deadline) && deadline > observed && deadline <= observed + 900000,
    "Execution window must be at most fifteen minutes",
  );
  const rotation = await requireHnsReviewedGatewayRotation({
    rotation: readiness,
    previousGatewayReference: reference(previousManifest),
    certificateSpki: after.gateway_certificate_spki_sha256,
    observedAt: new Date(observed).toISOString(),
    environment: "staging",
  });
  fail(rotation.manifest_json === nextManifest, "Readiness names another manifest");
  const entries = [];
  for (const state of states) {
    const { dns, app, sale, health } = state;
    const inventoryBytes = bytes(state.inventory.bytes_hex);
    const decoded = await decodeHnsAuthorityInventoryBytes(inventoryBytes);
    const inventory = decoded.inventory;
    fail(
      inventory.environment === "staging" &&
        decoded.inventory_digest === dns.pirate_dns_authority_inventory_digest &&
        inventory.authority_inventory_reference === dns.pirate_dns_authority_inventory_reference &&
        inventory.authority_inventory_version === dns.pirate_dns_authority_inventory_version &&
        new Date(state.inventory.expires_at).toISOString() === inventory.expires_at,
      "Retained staging inventory mismatch",
    );
    fail(
      dns.gateway_deployment_reference === reference(previousManifest) &&
        dns.gateway_certificate_spki_sha256 === after.gateway_certificate_spki_sha256 &&
        sha(bytes(dns.zone_hex)) === dns.zone_bytes_digest,
      "Retained gateway or zone identity mismatch",
    );
    fail(
      dns.status === "active" &&
        app.status === "active" &&
        sale.status === "active" &&
        app.gateway_deployment_reference === dns.gateway_deployment_reference &&
        app.dns_zone_activation_id === dns.dns_zone_activation_id &&
        sale.dns_zone_activation_id === dns.dns_zone_activation_id &&
        Number(app.dns_zone_activation_generation) === Number(dns.dns_zone_activation_generation) &&
        Number(sale.dns_zone_activation_generation) === Number(dns.dns_zone_activation_generation),
      "Inactive or mixed predecessor",
    );
    fail(
      health.delegation_matches &&
        health.ds_authenticates_zone &&
        health.retained_zone_digest_matches &&
        health.gateway_healthy &&
        health.observed_zone_bytes_digest === dns.zone_bytes_digest &&
        health.observed_dnssec_keyset_reference === dns.dnssec_keyset_reference &&
        health.observed_dnssec_keyset_version === dns.dnssec_keyset_version &&
        health.observed_gateway_deployment_reference === dns.gateway_deployment_reference &&
        health.observed_gateway_certificate_spki_sha256 === dns.gateway_certificate_spki_sha256 &&
        health.stable_chain_delegation_snapshot_reference ===
          dns.stable_chain_delegation_snapshot_reference &&
        health.stable_chain_delegation_snapshot_digest ===
          dns.stable_chain_delegation_snapshot_digest,
      "Retained health facts do not match the predecessor",
    );
    // PostgreSQL timestamps are Date objects before the plan is serialized. Date.parse
    // coerces them through toString and loses milliseconds, unlike the frozen strings.
    const cap = Math.min(new Date(health.valid_until).getTime(), Date.parse(inventory.expires_at));
    const ttl = Math.floor((cap - deadline) / 1000) - 5;
    fail(
      Number.isSafeInteger(ttl) &&
        ttl > 0 &&
        ttl <= 604800 &&
        new Date(health.checked_at).getTime() <= observed,
      "Retained evidence cannot cover the execution window",
    );
    const generation = Number(dns.dns_zone_activation_generation) + 1;
    fail(
      Number.isSafeInteger(generation) &&
        Number.isSafeInteger(state.successor_health_generation) &&
        state.successor_health_generation >= 0,
      "Invalid generation fence",
    );
    const root = dns.canonical_root;
    const successorId = digest([
      sourceCommit,
      root,
      stateIdentity(state),
      reference(nextManifest),
      executeBy,
    ]);
    const operation = (kind) => ({
      operation_id: `staging-gateway:${kind}:${successorId}`,
      idempotency_key: `staging-gateway:${kind}:${successorId}`,
      request_hash: successorId,
    });
    const nextDns = await prepareHnsDnsZoneActivationDocumentV1({
      payload: {
        version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
        dns_zone_activation_id: dns.dns_zone_activation_id,
        canonical_root: root,
        dns_authority: [dns.dns_authority_kind, dns.dns_authority_reference, generation],
        pirate_dns_authority_inventory: [
          dns.pirate_dns_authority_inventory_reference,
          dns.pirate_dns_authority_inventory_version,
          dns.pirate_dns_authority_inventory_digest,
        ],
        zone_revision: Number(dns.zone_revision) + 1,
        dnssec_keyset: [dns.dnssec_keyset_reference, dns.dnssec_keyset_version],
        gateway: [reference(nextManifest), dns.gateway_certificate_spki_sha256],
        stable_chain_delegation_snapshot: [
          dns.stable_chain_delegation_snapshot_reference,
          dns.stable_chain_delegation_snapshot_digest,
        ],
      },
      zone_bytes: bytes(dns.zone_hex),
    });
    entries.push({
      root,
      predecessor: state,
      predecessor_sha256: stateIdentity(state),
      successor_id: successorId,
      inherited_health_checked_at: new Date(health.checked_at).toISOString(),
      health_deadline: new Date(cap).toISOString(),
      generations: {
        dns_activation_generation: generation,
        app_host_activation_generation: Number(app.app_host_activation_generation) + 1,
        health_generation: state.successor_health_generation + 1,
      },
      dns_hex: Buffer.from(encodeHnsDnsZonePersistenceDocumentV1(nextDns)).toString("hex"),
      app_hex: Buffer.from(
        encodeHnsAppHostTransitionDocumentV1({
          ...operation("app"),
          app_host_activation_id: app.app_host_activation_id,
          expected_activation_generation: Number(app.app_host_activation_generation),
          target_status: "active",
          reason_code: "canonical-authority",
        }),
      ).toString("hex"),
      health_hex: Buffer.from(
        encodeHnsDnsHealthDocumentV1({
          ...operation("health"),
          dns_zone_activation_id: dns.dns_zone_activation_id,
          activation_generation: generation,
          expected_health_generation: state.successor_health_generation,
          stable_chain_delegation_snapshot_reference:
            dns.stable_chain_delegation_snapshot_reference,
          stable_chain_delegation_snapshot_digest: dns.stable_chain_delegation_snapshot_digest,
          observed_zone_bytes_digest: dns.zone_bytes_digest,
          observed_dnssec_keyset_reference: dns.dnssec_keyset_reference,
          observed_dnssec_keyset_version: dns.dnssec_keyset_version,
          observed_gateway_deployment_reference: reference(nextManifest),
          observed_gateway_certificate_spki_sha256: dns.gateway_certificate_spki_sha256,
          delegation_matches: true,
          ds_authenticates_zone: true,
          retained_zone_digest_matches: true,
          gateway_healthy: true,
          valid_for_seconds: ttl,
        }),
      ).toString("hex"),
    });
  }
  return { rotation, entries };
}
