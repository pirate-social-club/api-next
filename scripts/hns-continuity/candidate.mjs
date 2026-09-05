import { createHash } from "node:crypto";
import * as host from "../../packages/application/src/hns-host-persistence.ts";
import * as inv from "../../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import * as control from "../../packages/application/src/namespace-ownership/hns-control-observer.ts";
import { deriveCanonicalHnsAuthorityZoneBytesV1 } from "../../packages/hns-dns-runtime/src/dns-axfr-zone.ts";
import { ContinuityRefusal } from "./refusal.mjs";

/** Build solely from an operator's captured, independently verified observation. */
export async function buildContinuityCandidate({
  state,
  chain,
  primary,
  secondary,
  verification,
  sourceCommit,
}) {
  const root = state.dns.canonical_root;
  const bytes = (s) => new TextEncoder().encode(s);
  const hex = (s) => new Uint8Array(Buffer.from(s, "hex"));
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const encode = (o) => bytes(JSON.stringify(o));
  if (
    !Number.isSafeInteger(state.successor_health_generation) ||
    state.successor_health_generation < 0
  )
    throw new ContinuityRefusal("Successor health generation is missing");
  for (const view of [primary, secondary]) {
    const derived = deriveCanonicalHnsAuthorityZoneBytesV1({
      zone_name: root,
      response_sequence_bytes: hex(view.views[0].response_sequence_hex),
    });
    if (
      sha(derived) !== view.canonical_zone_sha256 ||
      Buffer.from(derived).toString("hex") !== view.canonical_zone_bytes_hex
    )
      throw new ContinuityRefusal("AXFR bytes disagree with the captured zone");
  }
  const capturedAt = Date.parse(state.database_time);
  const proofAt =
    typeof verification.observed_at === "number"
      ? verification.observed_at * 1000
      : Date.parse(verification.observed_at);
  for (const observed of [
    Date.parse(chain.observed_at),
    Date.parse(primary.observed_at),
    Date.parse(secondary.observed_at),
    proofAt,
  ]) {
    if (
      !Number.isFinite(observed) ||
      !Number.isFinite(capturedAt) ||
      Math.abs(observed - capturedAt) > 3600000
    )
      throw new ContinuityRefusal("Observation window exceeds one hour");
  }
  if (
    Date.parse(verification.certificate_expires) <= capturedAt + 7 * 86400000 ||
    !/^HTTP\/1\.[01] 200(?: |$)/u.test(verification.app_status)
  )
    throw new ContinuityRefusal("Gateway proof does not cover successor lifetime");
  if (
    primary.canonical_zone_bytes_hex !== secondary.canonical_zone_bytes_hex ||
    primary.canonical_zone_sha256 !== state.dns.zone_bytes_digest
  )
    throw new ContinuityRefusal("Zone agreement failed");
  if (
    verification.views.length !== 2 ||
    verification.views[0].ownership_txt !== verification.views[1].ownership_txt
  )
    throw new ContinuityRefusal("Ownership TXT disagreement");
  if (verification.certificate_spki !== state.dns.gateway_certificate_spki_sha256)
    throw new ContinuityRefusal("Gateway identity changed");
  const get = (ref) => chain.rows.find((r) => r.ref === ref).result;
  const info = get("getblockchaininfo:before");
  const name = get(`getnameinfo:${root}`).info;
  if (name.state !== "CLOSED" || name.stats.renewalPeriodEnd - info.blocks < 2016)
    throw new ContinuityRefusal("Root state or expiry unsafe");
  const records = (zone) =>
    control.hnsChainAuthorityRecords(
      "owner_authoritative_dns_txt",
      get(`getnameresource:${zone}`).records.flatMap((r) => {
        if (r.type === "NS") return [[r.type, r.ns.replace(/\.$/, "")]];
        if (r.type === "GLUE4" || r.type === "GLUE6")
          return [[r.type, r.ns.replace(/\.$/, ""), r.address]];
        if (r.type === "DS")
          return [[r.type, r.keyTag, r.algorithm, r.digestType, r.digest.toLowerCase()]];
        return [];
      }),
    );
  const childRecords = records(root),
    parentRecords = records("pirate");
  const digest = async (zone, authority_records) =>
    await control.hnsChainAuthorityDigest({
      chain_network: "main",
      chain_genesis_block_hash: host.HNS_MAINNET_GENESIS_BLOCK_HASH,
      root_label: zone,
      ownership_source: "owner_authoritative_dns_txt",
      authority_records,
    });
  const childDigest = await digest(root, childRecords),
    parentDigest = await digest("pirate", parentRecords);
  const snapshot = {
    dns_zone_activation_id: state.dns.dns_zone_activation_id,
    dns_current_generation: Number(state.dns.dns_zone_activation_generation),
    app_host_activation_id: state.app.app_host_activation_id,
    app_host_current_generation: Number(state.app.app_host_activation_generation),
    successor_dns_latest_health_generation: Number(state.successor_health_generation),
  };
  const ceremonyId = sha(encode([state.database_time, snapshot]));
  const evidenceReference = `hns-detached-observation:continuity-${ceremonyId}`;
  const transcript = chain.rows.map((r) => ({
    exchange_kind: "hns_rpc",
    vantage_reference: "hsd-vantage:primary-mainnet",
    subject_reference: r.ref === "getnameresource:pirate" ? "pirate" : root,
    query_reference: r.ref,
    request_bytes: bytes(r.request),
    response_bytes: bytes(r.raw),
  }));
  for (const [index, view] of [primary, secondary].entries()) {
    transcript.push({
      exchange_kind: "child_authority_dns",
      vantage_reference: `authority-vantage:${index ? "secondary" : "primary"}`,
      subject_reference: view.views[0].authority_address,
      query_reference: "axfr",
      request_bytes: hex(view.views[0].request_hex),
      response_bytes: hex(view.views[0].response_sequence_hex),
    });
  }
  for (const [index, view] of verification.views.entries())
    for (const e of view.exchanges) {
      const parent = e.name === "pirate" || e.name.endsWith(".pirate");
      transcript.push({
        exchange_kind: parent ? "parent_authority_dns" : "child_authority_dns",
        vantage_reference:
          (parent ? "parent-vantage:" : "authority-vantage:") + (index ? "secondary" : "primary"),
        subject_reference: parent ? "pirate" : view.address,
        query_reference: `${e.name}:${e.type.toLowerCase()}`,
        request_bytes: hex(e.request_hex),
        response_bytes: hex(e.response_hex),
      });
    }
  const evidence = await host.encodeHnsAuthorityDetachedObserverEvidenceV1({
    observation_id: `observer-continuity-${ceremonyId}`,
    request_sha256: sha(encode([root, snapshot, state.database_time])),
    provider_id: "hns.owner.v1",
    provider_configuration_reference: "hns-observer:operator-continuity-v1",
    provider_configuration_version: "v1",
    provider_configuration_digest: sha(
      encode(["main", "authenticated-hsd", "two-tsig-axfr", "dnssec-validation", "tlsa-spki"]),
    ),
    environment: "production",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: root,
    txt_name: `_pirate.${root}`,
    expected_txt_value: verification.views[0].ownership_txt,
    chain_authority_digest: childDigest,
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_anchor_height: info.blocks,
    chain_anchor_block_hash: info.bestblockhash,
    chain_anchor_median_time: info.mediantime,
    expiry_height: name.stats.renewalPeriodEnd,
    evidence_reference: evidenceReference,
    detached_transcript: transcript,
  });
  const priorInventory = (
    await inv.decodeHnsAuthorityInventoryBytes(hex(state.inventory.bytes_hex))
  ).inventory;
  const inventory = await inv.encodeHnsAuthorityInventory({
    ...priorInventory,
    authority_inventory_reference: `hns-authority-inventory:continuity-${ceremonyId}`,
    authority_inventory_version: `continuity-${ceremonyId}`,
    published_at: state.database_time,
    expires_at: new Date(Date.parse(state.database_time) + 7 * 86400000).toISOString(),
  });
  const inventoryValue = (await inv.decodeHnsAuthorityInventoryBytes(inventory)).inventory;
  if (
    priorInventory.dns_write_capabilities.some((entry) => entry.active && entry.root_label !== root)
  )
    throw new ContinuityRefusal(
      "Review additional root capabilities before extending this inventory",
    );
  const dnsGeneration = snapshot.dns_current_generation + 1;
  const dns = await host.prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: host.HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: snapshot.dns_zone_activation_id,
      canonical_root: root,
      dns_authority: [
        state.dns.dns_authority_kind,
        state.dns.dns_authority_reference,
        dnsGeneration,
      ],
      pirate_dns_authority_inventory: [
        inventoryValue.authority_inventory_reference,
        inventoryValue.authority_inventory_version,
        sha(inventory),
      ],
      zone_revision: dnsGeneration,
      dnssec_keyset: [state.dns.dnssec_keyset_reference, state.dns.dnssec_keyset_version],
      gateway: [state.dns.gateway_deployment_reference, state.dns.gateway_certificate_spki_sha256],
      stable_chain_delegation_snapshot: [evidenceReference, childDigest],
    },
    zone_bytes: hex(primary.canonical_zone_bytes_hex),
  });
  const dnsBytes = host.encodeHnsDnsZonePersistenceDocumentV1(dns);
  const operation = (kind, input) => {
    const request_hash = sha(encode([kind, input]));
    return {
      operation_id: `hns-continuity:${kind}:${request_hash}`,
      idempotency_key: `hns-continuity:${kind}:${request_hash}`,
      request_hash,
    };
  };
  const app = host.encodeHnsAppHostTransitionDocumentV1({
    ...operation("app", sha(dnsBytes)),
    app_host_activation_id: snapshot.app_host_activation_id,
    expected_activation_generation: snapshot.app_host_current_generation,
    target_status: "active",
    reason_code: "canonical-authority",
  });
  const health = host.encodeHnsDnsHealthDocumentV1({
    ...operation("health", sha(dnsBytes)),
    dns_zone_activation_id: snapshot.dns_zone_activation_id,
    activation_generation: dnsGeneration,
    expected_health_generation: snapshot.successor_dns_latest_health_generation,
    stable_chain_delegation_snapshot_reference: evidenceReference,
    stable_chain_delegation_snapshot_digest: childDigest,
    observed_zone_bytes_digest: dns.zone_bytes_digest,
    observed_dnssec_keyset_reference: dns.dnssec_keyset_reference,
    observed_dnssec_keyset_version: dns.dnssec_keyset_version,
    observed_gateway_deployment_reference: dns.gateway_deployment_reference,
    observed_gateway_certificate_spki_sha256: dns.gateway_certificate_spki_sha256,
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    valid_for_seconds: 7 * 86400,
  });
  const ds = (zone) =>
    records(zone)
      .filter((r) => r[0] === "DS")
      .map((r) => r.slice(1));
  const addresses = priorInventory.authoritative_nameserver_glue
    .filter((r) => r.active)
    .map((r) => ["A", r.authority_nameserver, r.authority_address]);
  const prepared = await host.prepareHnsAuthoritySuccessorCandidateV1({
    source_commit: sourceCommit,
    root_label: root,
    observed_at: state.database_time,
    chain_height: info.blocks,
    chain_authority_records: childRecords,
    generation_snapshot: snapshot,
    expected_authority_addresses: verification.views.map((v) => v.address),
    authority_views: verification.views.map((v) => ({
      attestation_kind: "operator_attested_authority_view_v1",
      authority_address: v.address,
      outcome: "observed",
      zone_bytes_digest: dns.zone_bytes_digest,
      dnskey_key_tag: ds(root)[0][0],
      derived_ds: ds(root),
    })),
    authority_address_provenance: {
      source_kind: "detached_parent_authority_attestation_v1",
      parent_zone: "pirate",
      parent_chain_authority_digest: parentDigest,
      parent_chain_authority_records: parentRecords,
      views: verification.views.map((_v, index) => ({
        view_id: index ? "parent-secondary" : "parent-primary",
        vantage_reference: index ? "parent-vantage:secondary" : "parent-vantage:primary",
        outcome: "observed",
        validation_attestation: "operator_attested_dnssec_secure",
        attested_dnskey_key_tag: ds("pirate")[0][0],
        attested_derived_ds: ds("pirate"),
        records: addresses,
      })),
    },
    artifacts: {
      authority_inventory: inventory,
      dns_zone_activation: dnsBytes,
      app_host_activation: app,
      health_observation: health,
      observer_evidence: evidence,
    },
  });
  return prepared;
}
