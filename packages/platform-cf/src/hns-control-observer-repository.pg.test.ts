import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  buildHnsAuthoritativeDnsQueryV1,
  decodeHnsControlObservationRequestBytes,
  decodeHnsControlObservationResultBytes,
  decodeHnsControlObservationResultV2Bytes,
  decodeHnsControlObserverConfigurationBytes,
  encodeHnsAuthoritativeDnsSemanticFactsV1,
  encodeHnsAuthorityInventory,
  encodeHnsControlObservationRequest,
  encodeHnsControlObservationResultV2,
  encodeHnsControlObserverConfiguration,
  encodeHnsControlObserverConfigurationV2,
  HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES,
  type HnsAuthorityInventoryV1,
  type HnsControlObserverConfigurationV1,
  type HnsControlObserverConfigurationV2,
  type HnsControlObserverReservationInput,
  type HnsControlObserverReservationOutcome,
  type HnsControlObserverSnapshotFinalizeInput,
  type HnsControlObserverSnapshotFinalizeInputV2,
  hnsAuthorityCapabilitySetDigest,
  hnsChainAuthorityDigest,
  hnsControlObserverSnapshotAccountingEnvelopeV2Bytes,
  hnsControlObserverSnapshotDigestV2,
  hnsControlObserverSnapshotLogicalByteLengthV2,
  hnsControlObserverTranscriptManifestDigestV2,
  hnsControlObserverTranscriptManifestV2,
  hnsObservedTxtValuesDigest,
} from "@pirate/application";
import type { Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  makeControlPlaneHnsAuthorityInventoryResolver,
  makeControlPlaneHnsControlObserverConfigurationResolver,
  makeControlPlaneHnsControlObserverSnapshotReader,
  makeControlPlaneHnsControlObserverSnapshotStore,
  makeControlPlaneHnsControlObserverSnapshotStoreV2,
} from "./namespace-ownership/hns-control-observer-postgres.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_HNS_OBSERVER_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-hns-observer-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-hns-observer-suite-complete\n";

if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const encoder = new TextEncoder();
const testCount = 23;
let completedTestCount = 0;
let admin: Client | undefined;
let schema = "";
let scoped = "";

const configurationValue = {
  version: "pirate-hns-control-observer-configuration-v1",
  provider_id: "hns.owner.v1",
  provider_configuration_reference: "hns-observer-pg-regtest",
  provider_configuration_version: "hns-observer-config-v1",
  environment: "test",
  ownership_sources: ["hns_parent_chain_txt"],
  chain: {
    driver_reference: "hsd-json-rpc:regtest-primary",
    network: "regtest",
    genesis_block_hash: "2".repeat(64),
    minimum_verification_progress_millionths: 999_000,
    maximum_tip_age_seconds: 3_600,
    maximum_future_tip_seconds: 7_200,
    expected_block_interval_seconds: 600,
    minimum_safe_remaining_blocks: 144,
    expiry_safety_blocks: 144,
    response_max_bytes: 1_048_576,
  },
  authoritative_dns: null,
  evidence_lease_seconds: 2_592_000,
  observer_deadline_ms: 1_000,
  observer_reservation_lease_seconds: 4,
  snapshot_store_reference: "postgres:hns-control-observer-v1",
} as const;

const dnsConfigurationValue = {
  ...configurationValue,
  provider_configuration_reference: "hns-observer-pg-dns-regtest",
  ownership_sources: ["owner_authoritative_dns_txt"],
  authoritative_dns: {
    driver_reference: "authoritative-dns:regtest",
    required_view_ids: ["getblockchaininfo"],
    require_dnssec: true,
    require_all_views: true,
    response_max_bytes: 65_535,
  },
} as const satisfies HnsControlObserverConfigurationV1;

const authorityInventoryRegistryReference = "authority-inventory:pg-regtest";

const custodyConfigurationValue = {
  version: "pirate-hns-control-observer-configuration-v2",
  provider_id: dnsConfigurationValue.provider_id,
  provider_configuration_reference: "hns-observer-pg-custody-regtest",
  provider_configuration_version: "hns-observer-config-v2",
  environment: dnsConfigurationValue.environment,
  ownership_sources: dnsConfigurationValue.ownership_sources,
  chain: dnsConfigurationValue.chain,
  authoritative_dns: dnsConfigurationValue.authoritative_dns,
  authority_inventory: {
    registry_reference: authorityInventoryRegistryReference,
    maximum_inventory_lifetime_seconds: 3_600,
    response_max_bytes: 65_536,
  },
  evidence_lease_seconds: dnsConfigurationValue.evidence_lease_seconds,
  observer_deadline_ms: dnsConfigurationValue.observer_deadline_ms,
  observer_reservation_lease_seconds: dnsConfigurationValue.observer_reservation_lease_seconds,
  snapshot_store_reference: dnsConfigurationValue.snapshot_store_reference,
} as const satisfies HnsControlObserverConfigurationV2;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function dnsRecord(type: number, rdata: Uint8Array): Uint8Array {
  return concatBytes([
    new Uint8Array([0xc0, 0x0c]),
    uint16(type),
    uint16(1),
    new Uint8Array([0, 0, 1, 44]),
    uint16(rdata.byteLength),
    rdata,
  ]);
}

function signedDnsResponse(
  request: Uint8Array,
  recordType: 16 | 48,
  recordData: Uint8Array,
): Uint8Array {
  const signatureData = new Uint8Array(18);
  signatureData.set(uint16(recordType));
  const answers = [dnsRecord(recordType, recordData), dnsRecord(46, signatureData)];
  const header = new Uint8Array(12);
  header[0] = request[0] ?? 0;
  header[1] = request[1] ?? 0;
  header.set(uint16(0x8400), 2);
  header.set(uint16(1), 4);
  header.set(uint16(answers.length), 6);
  header.set(uint16(1), 10);
  return concatBytes([
    header,
    request.subarray(12, request.byteLength - 11),
    ...answers,
    request.subarray(request.byteLength - 11),
  ]);
}

function servfailDnsResponse(request: Uint8Array): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = request[0] ?? 0;
  header[1] = request[1] ?? 0;
  header.set(uint16(0x8402), 2);
  header.set(uint16(1), 4);
  header.set(uint16(1), 10);
  return concatBytes([header, request.subarray(12)]);
}

function scopedConnection(raw: string, schemaName: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schemaName}`)}`;
}

function runtime() {
  return makeDirectPostgresControlPlaneLayer(scoped);
}

function runOptions(signal = new AbortController().signal) {
  return { deadline_ms: 1_000, signal } as const;
}

async function rawSha256(bytes: Uint8Array): Promise<Sha256HexValue> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  ) as Sha256HexValue;
}

async function hsdResponseTranscriptEntry(
  ownershipSource: "hns_parent_chain_txt" | "owner_authoritative_dns_txt",
) {
  const requestBytes = encoder.encode('{"method":"getblockchaininfo","params":[]}');
  const responseBytes = encoder.encode(
    '{"result":{"chain":"regtest","blocks":10},"error":null,"id":null}',
  );
  return {
    driver_reference: dnsConfigurationValue.chain.driver_reference,
    ownership_source: ownershipSource,
    method_or_view_id: "getblockchaininfo",
    request_bytes: requestBytes,
    request_sha256: await rawSha256(requestBytes),
    transport_outcome: "response" as const,
    transport_status: 200,
    response_bytes: responseBytes,
    response_sha256: await rawSha256(responseBytes),
  };
}

async function seedConfiguration(
  configuration: HnsControlObserverConfigurationV1 = configurationValue,
) {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  const configurationBytes = await encodeHnsControlObserverConfiguration(configuration);
  const decoded = await decodeHnsControlObserverConfigurationBytes(configurationBytes);
  await admin.query({
    text: `INSERT INTO hns_control_observer_configurations (
             provider_configuration_reference,
             provider_configuration_version,
             provider_configuration_digest,
             configuration_bytes
           ) VALUES ($1, $2, $3, $4)`,
    values: [
      configuration.provider_configuration_reference,
      configuration.provider_configuration_version,
      decoded.configuration_digest,
      configurationBytes,
    ],
  });
  return { configurationBytes, configurationDigest: decoded.configuration_digest };
}

async function seedCustodyConfiguration() {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  const configurationBytes =
    await encodeHnsControlObserverConfigurationV2(custodyConfigurationValue);
  const configurationDigest = await rawSha256(configurationBytes);
  await admin.query({
    text: `INSERT INTO hns_control_observer_configurations (
             provider_configuration_reference,
             provider_configuration_version,
             provider_configuration_digest,
             configuration_bytes
           ) VALUES ($1, $2, $3, $4)`,
    values: [
      custodyConfigurationValue.provider_configuration_reference,
      custodyConfigurationValue.provider_configuration_version,
      configurationDigest,
      configurationBytes,
    ],
  });
  return { configurationBytes, configurationDigest };
}

async function authorityInventoryFixture(
  version: string,
  options: Readonly<{ readonly nameserver?: string; readonly active?: boolean }> = {},
) {
  const nameserver = options.nameserver ?? "ns1.pgobserver";
  const authoritativeNameserverGlue = [
    {
      authority_nameserver: nameserver,
      authority_address_family: "GLUE4" as const,
      authority_address: "192.0.2.53",
      active: options.active ?? true,
    },
  ];
  const runtimeCapabilitySetDigest = await hnsAuthorityCapabilitySetDigest({
    environment: "test",
    authoritative_nameserver_glue: authoritativeNameserverGlue,
    dns_write_capabilities: [],
  });
  const now = Date.now();
  const publishedAt = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(now + 300_000).toISOString();
  const inventory: HnsAuthorityInventoryV1 = {
    version: "pirate-hns-authority-inventory-v1",
    authority_inventory_reference: `authority-inventory:pg-${version}`,
    authority_inventory_version: version,
    environment: "test",
    completeness: "complete",
    runtime_capability_set_digest: runtimeCapabilitySetDigest,
    published_at: publishedAt,
    expires_at: expiresAt,
    authoritative_nameserver_glue: authoritativeNameserverGlue,
    dns_write_capabilities: [],
  };
  const inventoryBytes = await encodeHnsAuthorityInventory(inventory);
  const inventoryDigest = await rawSha256(inventoryBytes);
  return {
    expiresAt,
    inventory,
    inventoryBytes,
    inventoryDigest,
    publishedAt,
    runtimeCapabilitySetDigest,
  };
}

async function seedAuthorityInventory(
  value: Awaited<ReturnType<typeof authorityInventoryFixture>>,
): Promise<void> {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  await admin.query({
    text: `INSERT INTO hns_authority_inventories (
             registry_reference,
             authority_inventory_reference,
             authority_inventory_version,
             authority_inventory_digest,
             environment,
             runtime_capability_set_digest,
             inventory_bytes,
             published_at,
             expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: [
      authorityInventoryRegistryReference,
      value.inventory.authority_inventory_reference,
      value.inventory.authority_inventory_version,
      value.inventoryDigest,
      value.inventory.environment,
      value.runtimeCapabilitySetDigest,
      value.inventoryBytes,
      value.publishedAt,
      value.expiresAt,
    ],
  });
}

async function reservationInput(
  observationId: string,
  expectedTxtValue = "pirate-verification=pg-observer-01",
  configuration: HnsControlObserverConfigurationV1 = configurationValue,
  ownershipSource: "hns_parent_chain_txt" | "owner_authoritative_dns_txt" = "hns_parent_chain_txt",
): Promise<HnsControlObserverReservationInput> {
  const { configurationBytes, configurationDigest } = await seedConfiguration(configuration);
  const requestBytes = await encodeHnsControlObservationRequest({
    version: "pirate-hns-control-observation-request-v1",
    observation_id: observationId,
    provider_id: "hns.owner.v1",
    provider_configuration_reference: configuration.provider_configuration_reference,
    provider_configuration_version: configuration.provider_configuration_version,
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: ownershipSource,
    root_label: "pgobserver",
    txt_name: ownershipSource === "hns_parent_chain_txt" ? "pgobserver" : "_pirate.pgobserver",
    expected_txt_value: expectedTxtValue,
  });
  const request = await decodeHnsControlObservationRequestBytes(requestBytes);
  return {
    observation_id: observationId,
    request_bytes: requestBytes,
    request_sha256: request.request_sha256,
    configuration_bytes: configurationBytes,
    provider_configuration_digest: configurationDigest,
    reservation_lease_seconds: configuration.observer_reservation_lease_seconds,
  };
}

async function custodyReservationInput(observationId: string) {
  const { configurationBytes, configurationDigest } = await seedCustodyConfiguration();
  const requestBytes = await encodeHnsControlObservationRequest({
    version: "pirate-hns-control-observation-request-v1",
    observation_id: observationId,
    provider_id: "hns.owner.v1",
    provider_configuration_reference: custodyConfigurationValue.provider_configuration_reference,
    provider_configuration_version: custodyConfigurationValue.provider_configuration_version,
    provider_configuration_digest: configurationDigest,
    environment: "test",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "pgobserver",
    txt_name: "_pirate.pgobserver",
    expected_txt_value: "pirate-verification=pg-custody-01",
  });
  const request = await decodeHnsControlObservationRequestBytes(requestBytes);
  return {
    observation_id: observationId,
    request_bytes: requestBytes,
    request_sha256: request.request_sha256,
    configuration_bytes: configurationBytes,
    provider_configuration_digest: configurationDigest,
    reservation_lease_seconds: custodyConfigurationValue.observer_reservation_lease_seconds,
  } satisfies HnsControlObserverReservationInput;
}

function acquired(
  value: HnsControlObserverReservationOutcome,
): Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }> {
  if (value.kind !== "acquired") throw new Error("expected acquired reservation");
  return value;
}

async function finalizeInput(
  reservation: HnsControlObserverReservationInput,
  authority: Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }>,
): Promise<HnsControlObserverSnapshotFinalizeInput> {
  const resultBytes = encoder.encode(
    JSON.stringify({
      version: "pirate-hns-control-observation-result-v1",
      observation_id: reservation.observation_id,
      request_sha256: reservation.request_sha256,
      status: "unavailable",
      reason_code: "chain_transport_unavailable",
      retry_after_seconds: 5,
      diagnostic_ref: authority.snapshot_reference,
    }),
  );
  const decoded = await decodeHnsControlObservationResultBytes(resultBytes);
  const transcriptRequest = encoder.encode('{"method":"getblockchaininfo","params":[]}');
  return {
    observation_id: reservation.observation_id,
    observer_fence: authority.observer_fence,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    snapshot_reference: authority.snapshot_reference,
    transcript: [
      {
        driver_reference: configurationValue.chain.driver_reference,
        ownership_source: "hns_parent_chain_txt",
        method_or_view_id: "getblockchaininfo",
        request_bytes: transcriptRequest,
        request_sha256: await rawSha256(transcriptRequest),
        transport_outcome: "transport_error",
        transport_status: null,
        response_bytes: null,
        response_sha256: null,
      },
    ],
    semantic_facts_bytes: encoder.encode('{"status":"unavailable"}'),
    result_bytes: resultBytes,
    result_sha256: decoded.result_sha256,
  };
}

async function ownerChainOnlyFinalizeInput(
  reservation: HnsControlObserverReservationInput,
  authority: Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }>,
  reason: "root_absent" | "root_inactive" | "txt_absent",
): Promise<HnsControlObserverSnapshotFinalizeInput> {
  const request = await decodeHnsControlObservationRequestBytes(reservation.request_bytes);
  const chainAuthorityDigest = await hnsChainAuthorityDigest({
    chain_network: dnsConfigurationValue.chain.network,
    chain_genesis_block_hash: dnsConfigurationValue.chain.genesis_block_hash,
    root_label: request.request.root_label,
    ownership_source: "owner_authoritative_dns_txt",
    authority_records: [],
  });
  const expectedTxtValueSha256 = await rawSha256(
    encoder.encode(request.request.expected_txt_value),
  );
  const resultBytes = encoder.encode(
    JSON.stringify({
      version: "pirate-hns-control-observation-result-v1",
      observation_id: reservation.observation_id,
      request_sha256: reservation.request_sha256,
      status: "rejected",
      reason_code: reason,
      provider_id: request.request.provider_id,
      provider_configuration_reference: request.request.provider_configuration_reference,
      provider_configuration_version: request.request.provider_configuration_version,
      provider_configuration_digest: request.request.provider_configuration_digest,
      environment: request.request.environment,
      ownership_source: request.request.ownership_source,
      root_label: request.request.root_label,
      txt_name: request.request.txt_name,
      expected_txt_value_sha256: expectedTxtValueSha256,
      observed_txt_values_digest: null,
      chain_authority_digest: chainAuthorityDigest,
      chain_network: dnsConfigurationValue.chain.network,
      chain_genesis_block_hash: dnsConfigurationValue.chain.genesis_block_hash,
      chain_anchor_height: 10,
      chain_anchor_block_hash: "8".repeat(64),
      chain_anchor_median_time: 1_700_000_000,
      expiry_height: reason === "txt_absent" ? 1_000 : null,
      provider_evidence_ref: authority.snapshot_reference,
    }),
  );
  const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes, request.request);
  return {
    observation_id: reservation.observation_id,
    observer_fence: authority.observer_fence,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    snapshot_reference: authority.snapshot_reference,
    transcript: [await hsdResponseTranscriptEntry("owner_authoritative_dns_txt")],
    semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
    result_bytes: resultBytes,
    result_sha256: decodedResult.result_sha256,
  };
}

async function custodyIneligibleFinalizeInput(
  reservation: HnsControlObserverReservationInput,
  authority: Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }>,
  inventory: Awaited<ReturnType<typeof authorityInventoryFixture>>,
): Promise<HnsControlObserverSnapshotFinalizeInputV2> {
  const request = await decodeHnsControlObservationRequestBytes(reservation.request_bytes);
  const transcript = [await hsdResponseTranscriptEntry("owner_authoritative_dns_txt")];
  const semanticFactsBytes = encodeHnsAuthoritativeDnsSemanticFactsV1([]);
  const transcriptManifestSha256 = await hnsControlObserverTranscriptManifestDigestV2(
    hnsControlObserverTranscriptManifestV2(transcript),
  );
  const semanticFactsSha256 = await rawSha256(semanticFactsBytes);
  const observerSnapshotSha256 = await hnsControlObserverSnapshotDigestV2({
    observation_id: reservation.observation_id,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    authority_inventory_reference_or_null: inventory.inventory.authority_inventory_reference,
    authority_inventory_version_or_null: inventory.inventory.authority_inventory_version,
    authority_inventory_digest_or_null: inventory.inventoryDigest,
    reservation_database_time: authority.reservation_database_time,
    snapshot_reference: authority.snapshot_reference,
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_sha256: semanticFactsSha256,
  });
  const resultBytes = await encodeHnsControlObservationResultV2(
    {
      version: "pirate-hns-control-observation-result-v2",
      observation_id: reservation.observation_id,
      request_sha256: reservation.request_sha256,
      status: "ineligible",
      reason_code: "owner_authoritative_source_ineligible",
      provider_id: request.request.provider_id,
      provider_configuration_reference: request.request.provider_configuration_reference,
      provider_configuration_version: request.request.provider_configuration_version,
      provider_configuration_digest: request.request.provider_configuration_digest,
      environment: request.request.environment,
      ownership_source: "owner_authoritative_dns_txt",
      root_label: request.request.root_label,
      txt_name: request.request.txt_name,
      expected_txt_value_sha256: await rawSha256(
        encoder.encode(request.request.expected_txt_value),
      ),
      chain_authority_digest: await hnsChainAuthorityDigest({
        chain_network: custodyConfigurationValue.chain.network,
        chain_genesis_block_hash: custodyConfigurationValue.chain.genesis_block_hash,
        root_label: request.request.root_label,
        ownership_source: "owner_authoritative_dns_txt",
        authority_records: [
          ["NS", "ns1.pgobserver"],
          ["GLUE4", "ns1.pgobserver", "192.0.2.53"],
        ],
      }),
      chain_network: custodyConfigurationValue.chain.network,
      chain_genesis_block_hash: custodyConfigurationValue.chain.genesis_block_hash,
      chain_anchor_height: 10,
      chain_anchor_block_hash: "8".repeat(64),
      chain_anchor_median_time: Math.floor(Date.parse(authority.reservation_database_time) / 1_000),
      expiry_height: 1_000,
      authority_inventory_reference: inventory.inventory.authority_inventory_reference,
      authority_inventory_version: inventory.inventory.authority_inventory_version,
      authority_inventory_digest: inventory.inventoryDigest,
      observer_snapshot_sha256: observerSnapshotSha256,
      diagnostic_ref: authority.snapshot_reference,
    },
    request.request,
  );
  const decodedResult = await decodeHnsControlObservationResultV2Bytes(
    resultBytes,
    request.request,
  );
  return {
    observation_id: reservation.observation_id,
    observer_fence: authority.observer_fence,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    snapshot_reference: authority.snapshot_reference,
    authority_inventory_bytes: inventory.inventoryBytes,
    authority_inventory_reference_or_null: inventory.inventory.authority_inventory_reference,
    authority_inventory_version_or_null: inventory.inventory.authority_inventory_version,
    authority_inventory_digest_or_null: inventory.inventoryDigest,
    transcript,
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_bytes: semanticFactsBytes,
    semantic_facts_sha256: semanticFactsSha256,
    observer_snapshot_sha256: observerSnapshotSha256,
    result_bytes: resultBytes,
    result_sha256: decodedResult.result_sha256,
  };
}

async function custodyInventoryUnavailableFinalizeInput(
  reservation: HnsControlObserverReservationInput,
  authority: Extract<HnsControlObserverReservationOutcome, { readonly kind: "acquired" }>,
): Promise<HnsControlObserverSnapshotFinalizeInputV2> {
  const request = await decodeHnsControlObservationRequestBytes(reservation.request_bytes);
  const semanticFactsBytes = encodeHnsAuthoritativeDnsSemanticFactsV1([]);
  const transcriptManifestSha256 = await hnsControlObserverTranscriptManifestDigestV2(
    hnsControlObserverTranscriptManifestV2([]),
  );
  const semanticFactsSha256 = await rawSha256(semanticFactsBytes);
  const observerSnapshotSha256 = await hnsControlObserverSnapshotDigestV2({
    observation_id: reservation.observation_id,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    authority_inventory_reference_or_null: null,
    authority_inventory_version_or_null: null,
    authority_inventory_digest_or_null: null,
    reservation_database_time: authority.reservation_database_time,
    snapshot_reference: authority.snapshot_reference,
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_sha256: semanticFactsSha256,
  });
  const resultBytes = await encodeHnsControlObservationResultV2(
    {
      version: "pirate-hns-control-observation-result-v2",
      observation_id: reservation.observation_id,
      request_sha256: reservation.request_sha256,
      status: "unavailable",
      reason_code: "authority_inventory_unavailable",
      retry_after_seconds: null,
      observer_snapshot_sha256: observerSnapshotSha256,
      diagnostic_ref: authority.snapshot_reference,
    },
    request.request,
  );
  const decodedResult = await decodeHnsControlObservationResultV2Bytes(
    resultBytes,
    request.request,
  );
  return {
    observation_id: reservation.observation_id,
    observer_fence: authority.observer_fence,
    request_sha256: reservation.request_sha256,
    provider_configuration_digest: reservation.provider_configuration_digest,
    snapshot_reference: authority.snapshot_reference,
    authority_inventory_bytes: null,
    authority_inventory_reference_or_null: null,
    authority_inventory_version_or_null: null,
    authority_inventory_digest_or_null: null,
    transcript: [],
    transcript_manifest_sha256: transcriptManifestSha256,
    semantic_facts_bytes: semanticFactsBytes,
    semantic_facts_sha256: semanticFactsSha256,
    observer_snapshot_sha256: observerSnapshotSha256,
    result_bytes: resultBytes,
    result_sha256: decodedResult.result_sha256,
  };
}

async function expireReservation(observationId: string): Promise<void> {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  await admin.query(
    "ALTER TABLE hns_control_observer_reservations DISABLE TRIGGER hns_control_observer_reservation_guard",
  );
  try {
    await admin.query({
      text: `WITH expired AS (
               SELECT date_trunc('milliseconds', clock_timestamp() - INTERVAL '10 seconds')
                 AS database_time
             )
             UPDATE hns_control_observer_reservations AS reservation
                SET reservation_database_time = expired.database_time,
                    lease_expires_at = expired.database_time
                      + reservation.reservation_lease_seconds * INTERVAL '1 second',
                    created_at = expired.database_time,
                    updated_at = expired.database_time
               FROM expired
              WHERE observation_id = $1`,
      values: [observationId],
    });
  } finally {
    await admin.query(
      "ALTER TABLE hns_control_observer_reservations ENABLE TRIGGER hns_control_observer_reservation_guard",
    );
  }
}

async function rowCount(table: string): Promise<number> {
  if (admin === undefined) throw new Error("Postgres test schema is unavailable");
  const result = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count);
}

suite("Postgres 17 HNS control observer persistence", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    schema = `api_next_hns_observer_${crypto.randomUUID().replaceAll("-", "")}`;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    scoped = scopedConnection(connectionString, schema);
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(await loadPostgresMigrations()).pipe(Effect.provide(runtime())),
      ),
    );
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  }, 30_000);

  beforeEach(async () => {
    if (admin === undefined) return;
    await admin.query(`TRUNCATE
      hns_control_observer_snapshot_transcript_entries,
      hns_control_observer_snapshots,
      hns_control_observer_reservations,
      hns_control_observer_operations,
      hns_control_observer_configurations,
      hns_authority_inventories
      CASCADE`);
  });

  test("resolves exact immutable configuration bytes", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const { configurationBytes } = await seedConfiguration();
    const resolver = makeControlPlaneHnsControlObserverConfigurationResolver(runtime());
    const first = await resolver.resolve(
      {
        reference: configurationValue.provider_configuration_reference,
        version: configurationValue.provider_configuration_version,
      },
      runOptions(),
    );
    expect(first).toEqual(configurationBytes);
    first?.fill(0);
    await expect(
      resolver.resolve(
        {
          reference: configurationValue.provider_configuration_reference,
          version: configurationValue.provider_configuration_version,
        },
        runOptions(),
      ),
    ).resolves.toEqual(configurationBytes);
    await expect(
      admin.query(
        "UPDATE hns_control_observer_configurations SET configuration_bytes = configuration_bytes",
      ),
    ).rejects.toThrow("append-only");
    await expect(admin.query("DELETE FROM hns_control_observer_configurations")).rejects.toThrow(
      "append-only",
    );
    completedTestCount += 1;
  });

  test("resolves one current immutable authority inventory as exact bytes", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const inventory = await authorityInventoryFixture("inventory-v1");
    await seedAuthorityInventory(inventory);
    const resolver = makeControlPlaneHnsAuthorityInventoryResolver(runtime(), {
      registryReference: authorityInventoryRegistryReference,
      responseMaxBytes: 65_536,
    });
    const first = await resolver.resolve(runOptions());
    expect(first).toEqual({
      authority_inventory_reference: inventory.inventory.authority_inventory_reference,
      authority_inventory_version: inventory.inventory.authority_inventory_version,
      authority_inventory_digest: inventory.inventoryDigest,
      inventory_bytes: inventory.inventoryBytes,
    });
    first?.inventory_bytes.fill(0);
    await expect(resolver.resolve(runOptions())).resolves.toMatchObject({
      authority_inventory_digest: inventory.inventoryDigest,
      inventory_bytes: inventory.inventoryBytes,
    });
    await expect(
      admin.query("UPDATE hns_authority_inventories SET inventory_bytes = inventory_bytes"),
    ).rejects.toThrow("append-only");
    await expect(admin.query("DELETE FROM hns_authority_inventories")).rejects.toThrow(
      "append-only",
    );
    completedTestCount += 1;
  });

  test("fails closed when two authority inventories are current", async () => {
    const first = await authorityInventoryFixture("inventory-v1", {
      nameserver: "ns1.pgobserver",
    });
    const second = await authorityInventoryFixture("inventory-v2", {
      nameserver: "ns2.pgobserver",
    });
    await seedAuthorityInventory(first);
    await seedAuthorityInventory(second);
    const resolver = makeControlPlaneHnsAuthorityInventoryResolver(runtime(), {
      registryReference: authorityInventoryRegistryReference,
      responseMaxBytes: 65_536,
    });
    await expect(resolver.resolve(runOptions())).rejects.toThrow("ambiguous current authority");
    completedTestCount += 1;
  });

  test("retains one v2 custody terminal, rejects cross-version, and blocks post-terminal append", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const inventory = await authorityInventoryFixture("inventory-v1");
    await seedAuthorityInventory(inventory);
    const input = await custodyReservationInput("observer-pg-custody-ineligible-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const v2Terminal = await custodyIneligibleFinalizeInput(input, authority, inventory);

    const v1Store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const v2TerminalAsV1 = { ...v2Terminal } as unknown as HnsControlObserverSnapshotFinalizeInput;
    for (const key of [
      "authority_inventory_bytes",
      "authority_inventory_reference_or_null",
      "authority_inventory_version_or_null",
      "authority_inventory_digest_or_null",
      "transcript_manifest_sha256",
      "semantic_facts_sha256",
      "observer_snapshot_sha256",
    ]) {
      delete (v2TerminalAsV1 as unknown as Record<string, unknown>)[key];
    }
    await expect(v1Store.finalize(v2TerminalAsV1, runOptions())).rejects.toThrow("strict decoding");
    const v1Terminal = await finalizeInput(input, authority);
    await expect(
      store.finalize(
        v1Terminal as unknown as HnsControlObserverSnapshotFinalizeInputV2,
        runOptions(),
      ),
    ).rejects.toThrow("strict decoding");
    await expect(
      store.finalize(
        {
          ...v2Terminal,
          authority_inventory_digest_or_null: "9".repeat(64) as Sha256HexValue,
        },
        runOptions(),
      ),
    ).rejects.toThrow("inventory digest");

    const outcomes = await Promise.all([
      store.finalize(v2Terminal, runOptions()),
      store.finalize(v2Terminal, runOptions()),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["replay", "retained"]);
    const retained = await admin.query<{
      authority_inventory_digest: string;
      observer_snapshot_sha256: string;
      result_status: string;
      transcript_manifest_sha256: string;
    }>({
      text: `SELECT authority_inventory_digest,
                    observer_snapshot_sha256,
                    result_status,
                    transcript_manifest_sha256
               FROM hns_control_observer_snapshots
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(retained.rows).toEqual([
      {
        authority_inventory_digest: inventory.inventoryDigest,
        observer_snapshot_sha256: v2Terminal.observer_snapshot_sha256,
        result_status: "ineligible",
        transcript_manifest_sha256: v2Terminal.transcript_manifest_sha256,
      },
    ]);
    await expect(
      store.finalize(
        {
          ...v2Terminal,
          result_bytes: new Uint8Array([...v2Terminal.result_bytes, 0]),
          result_sha256: "0".repeat(64) as Sha256HexValue,
        },
        runOptions(),
      ),
    ).resolves.toEqual({ kind: "mismatch" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(1);
    await expect(store.reserve(input, runOptions())).resolves.toMatchObject({
      kind: "replay",
      result_sha256: v2Terminal.result_sha256,
      result_bytes: v2Terminal.result_bytes,
    });
    completedTestCount += 1;
  });

  test("retains a v2 inventory-unavailable authority with no inventory tuple", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await custodyReservationInput("observer-pg-custody-unavailable-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await custodyInventoryUnavailableFinalizeInput(input, authority);
    await expect(store.finalize(terminal, runOptions())).resolves.toMatchObject({
      kind: "retained",
    });
    const retained = await admin.query<{
      authority_inventory_bytes: Uint8Array | null;
      authority_inventory_reference: string | null;
      authority_inventory_version: string | null;
      authority_inventory_digest: string | null;
      result_status: string;
    }>({
      text: `SELECT authority_inventory_bytes,
                    authority_inventory_reference,
                    authority_inventory_version,
                    authority_inventory_digest,
                    result_status
               FROM hns_control_observer_snapshots
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(retained.rows).toEqual([
      {
        authority_inventory_bytes: null,
        authority_inventory_reference: null,
        authority_inventory_version: null,
        authority_inventory_digest: null,
        result_status: "unavailable",
      },
    ]);
    await expect(store.reserve(input, runOptions())).resolves.toMatchObject({
      kind: "replay",
      result_bytes: terminal.result_bytes,
      result_sha256: terminal.result_sha256,
    });
    completedTestCount += 1;
  });

  test("accounts exact inventory-inclusive v2 logical bytes", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const inventory = await authorityInventoryFixture("inventory-accounting-v1");
    await seedAuthorityInventory(inventory);
    const input = await custodyReservationInput("observer-pg-custody-accounting-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await custodyIneligibleFinalizeInput(input, authority, inventory);
    await expect(store.finalize(terminal, runOptions())).resolves.toMatchObject({
      kind: "retained",
    });
    const expectedPayload = {
      observation_id: input.observation_id,
      observer_fence: authority.observer_fence,
      reservation_database_time: authority.reservation_database_time,
      lease_expires_at: authority.lease_expires_at,
      request_bytes: input.request_bytes,
      request_sha256: input.request_sha256,
      configuration_bytes: input.configuration_bytes,
      provider_configuration_digest: input.provider_configuration_digest,
      authority_inventory_bytes: inventory.inventoryBytes,
      authority_inventory_reference_or_null: inventory.inventory.authority_inventory_reference,
      authority_inventory_version_or_null: inventory.inventory.authority_inventory_version,
      authority_inventory_digest_or_null: inventory.inventoryDigest,
      snapshot_reference: authority.snapshot_reference,
      transcript: terminal.transcript,
      transcript_manifest_sha256: terminal.transcript_manifest_sha256,
      semantic_facts_bytes: terminal.semantic_facts_bytes,
      semantic_facts_sha256: terminal.semantic_facts_sha256,
      observer_snapshot_sha256: terminal.observer_snapshot_sha256,
      result_status: "ineligible" as const,
      result_reference_kind: "diagnostic_ref" as const,
      result_bytes: terminal.result_bytes,
      result_sha256: terminal.result_sha256,
    };
    const expectedAccounting = hnsControlObserverSnapshotAccountingEnvelopeV2Bytes(expectedPayload);
    const expectedLogicalLength = hnsControlObserverSnapshotLogicalByteLengthV2(expectedPayload);
    const retained = await admin.query<{
      accounting_envelope_bytes: Uint8Array;
      logical_snapshot_byte_length: number;
    }>({
      text: `SELECT accounting_envelope_bytes, logical_snapshot_byte_length
               FROM hns_control_observer_snapshots
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]?.accounting_envelope_bytes).toEqual(expectedAccounting);
    expect(Number(retained.rows[0]?.logical_snapshot_byte_length)).toBe(expectedLogicalLength);
    completedTestCount += 1;
  });

  test("rejects every partial v2 inventory tuple before insertion", async () => {
    const inventory = await authorityInventoryFixture("inventory-partial-v1");
    await seedAuthorityInventory(inventory);
    const input = await custodyReservationInput("observer-pg-custody-partial-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await custodyIneligibleFinalizeInput(input, authority, inventory);
    await expect(
      store.finalize({ ...terminal, authority_inventory_bytes: null }, runOptions()),
    ).rejects.toThrow("partial nullable tuple");
    await expect(
      store.finalize({ ...terminal, authority_inventory_reference_or_null: null }, runOptions()),
    ).rejects.toThrow("partial nullable tuple");
    await expect(
      store.finalize({ ...terminal, authority_inventory_version_or_null: null }, runOptions()),
    ).rejects.toThrow("partial nullable tuple");
    await expect(
      store.finalize({ ...terminal, authority_inventory_digest_or_null: null }, runOptions()),
    ).rejects.toThrow("partial nullable tuple");
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    completedTestCount += 1;
  });

  test("rejects v1 and v2 cross-substitution in both store directions", async () => {
    const inventory = await authorityInventoryFixture("inventory-cross-version-v1");
    await seedAuthorityInventory(inventory);
    const input = await custodyReservationInput("observer-pg-custody-cross-version-01");
    const authority = acquired(
      await makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime()).reserve(
        input,
        runOptions(),
      ),
    );
    const v1Terminal = await finalizeInput(input, authority);
    const v2Terminal = await custodyIneligibleFinalizeInput(input, authority, inventory);
    const v1Store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const v2Store = makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime());
    const v2TerminalCastAsV1 = {
      ...v2Terminal,
    } as unknown as HnsControlObserverSnapshotFinalizeInput;
    for (const key of [
      "authority_inventory_bytes",
      "authority_inventory_reference_or_null",
      "authority_inventory_version_or_null",
      "authority_inventory_digest_or_null",
      "transcript_manifest_sha256",
      "semantic_facts_sha256",
      "observer_snapshot_sha256",
    ]) {
      delete (v2TerminalCastAsV1 as unknown as Record<string, unknown>)[key];
    }
    await expect(v1Store.finalize(v2TerminalCastAsV1, runOptions())).rejects.toThrow(
      "strict decoding",
    );
    await expect(
      v2Store.finalize(
        v1Terminal as unknown as HnsControlObserverSnapshotFinalizeInputV2,
        runOptions(),
      ),
    ).rejects.toThrow("strict decoding");
    await expect(v2Store.finalize(v2Terminal, runOptions())).resolves.toMatchObject({
      kind: "retained",
    });
    completedTestCount += 1;
  });

  test("rejects late v2 finalization after database-time expiry without a write", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const inventory = await authorityInventoryFixture("inventory-expiry-v1");
    await seedAuthorityInventory(inventory);
    const input = await custodyReservationInput("observer-pg-custody-expired-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStoreV2(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    await expireReservation(input.observation_id);
    const expiredReservation = await admin.query<{
      reservation_database_time: string;
      lease_expires_at: string;
    }>({
      text: `SELECT to_char(reservation_database_time AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reservation_database_time,
                    to_char(lease_expires_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at
               FROM hns_control_observer_reservations
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    const expiredAuthority = {
      ...authority,
      reservation_database_time: expiredReservation.rows[0]?.reservation_database_time ?? "",
      lease_expires_at: expiredReservation.rows[0]?.lease_expires_at ?? "",
    };
    const terminal = await custodyIneligibleFinalizeInput(input, expiredAuthority, inventory);
    await expect(store.finalize(terminal, runOptions())).resolves.toEqual({ kind: "lost" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(0);
    completedTestCount += 1;
  });

  test("serializes first reservation, exact busy replay, and changed-byte mismatch", async () => {
    const input = await reservationInput("observer-pg-reserve-01");
    const left = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const right = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const [first, second] = await Promise.all([
      left.reserve(input, runOptions()),
      right.reserve(input, runOptions()),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["acquired", "busy"]);
    const authority = acquired(first.kind === "acquired" ? first : second);
    expect(authority.snapshot_reference).toMatch(/^hns-observer:postgres:/u);
    const changedRequest = await encodeHnsControlObservationRequest({
      ...(await decodeHnsControlObservationRequestBytes(input.request_bytes)).request,
      expected_txt_value: "pirate-verification=changed",
    });
    const changedDecoded = await decodeHnsControlObservationRequestBytes(changedRequest);
    const changed = {
      ...input,
      request_bytes: changedRequest,
      request_sha256: changedDecoded.request_sha256,
    };
    await expect(left.reserve(changed, runOptions())).resolves.toEqual({ kind: "mismatch" });
    const wrongDigestRequest = await encodeHnsControlObservationRequest({
      ...(await decodeHnsControlObservationRequestBytes(input.request_bytes)).request,
      provider_configuration_digest: "3".repeat(64) as Sha256HexValue,
    });
    const wrongDigestDecoded = await decodeHnsControlObservationRequestBytes(wrongDigestRequest);
    await expect(
      left.reserve(
        {
          ...input,
          request_bytes: wrongDigestRequest,
          request_sha256: wrongDigestDecoded.request_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("authority does not match");
    await expect(
      left.reserve(
        { ...input, observation_id: "observer-pg-reserve-outer-substitution" },
        runOptions(),
      ),
    ).rejects.toThrow("authority does not match");
    expect(await rowCount("hns_control_observer_operations")).toBe(1);
    expect(await rowCount("hns_control_observer_reservations")).toBe(1);
    completedTestCount += 1;
  });

  test("reads one owned immutable snapshot for active-renewal recovery", async () => {
    const input = await reservationInput("observer-pg-read-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await expect(store.finalize(terminal, runOptions())).resolves.toMatchObject({
      kind: "retained",
      snapshot_reference: authority.snapshot_reference,
    });
    const reader = makeControlPlaneHnsControlObserverSnapshotReader(runtime());
    const first = await reader.read(authority.snapshot_reference, runOptions());
    expect(first).toEqual({
      snapshot_reference: authority.snapshot_reference,
      request_bytes: input.request_bytes,
      result_bytes: terminal.result_bytes,
      result_sha256: terminal.result_sha256,
    });
    first?.request_bytes.fill(0);
    first?.result_bytes.fill(0);
    await expect(reader.read(authority.snapshot_reference, runOptions())).resolves.toEqual({
      snapshot_reference: authority.snapshot_reference,
      request_bytes: input.request_bytes,
      result_bytes: terminal.result_bytes,
      result_sha256: terminal.result_sha256,
    });
    await expect(reader.read("hns-observer:postgres:missing", runOptions())).resolves.toBeNull();
    await expect(reader.read("invalid", runOptions())).rejects.toMatchObject({
      reason: "invalid_snapshot",
    });
    completedTestCount += 1;
  });

  test("serializes expired reacquisition to one new fence and rejects the stale finalizer", async () => {
    const input = await reservationInput("observer-pg-reacquire-01");
    const left = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const right = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const first = acquired(await left.reserve(input, runOptions()));
    const staleFinalize = await finalizeInput(input, first);
    await expireReservation(input.observation_id);
    const reacquisitions = await Promise.all([
      left.reserve(input, runOptions()),
      right.reserve(input, runOptions()),
    ]);
    expect(reacquisitions.map((outcome) => outcome.kind).sort()).toEqual(["acquired", "busy"]);
    const second = acquired(
      reacquisitions[0].kind === "acquired" ? reacquisitions[0] : reacquisitions[1],
    );
    expect(second).toMatchObject({
      observer_fence: first.observer_fence + 1,
      snapshot_reference: first.snapshot_reference,
    });
    await expect(left.finalize(staleFinalize, runOptions())).resolves.toEqual({ kind: "lost" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    await expect(
      left.finalize(await finalizeInput(input, second), runOptions()),
    ).resolves.toMatchObject({ kind: "retained" });
    completedTestCount += 1;
  });

  test("finalize after database-time lease expiry writes no snapshot", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await reservationInput("observer-pg-expired-finalize-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await expireReservation(input.observation_id);
    await expect(store.finalize(terminal, runOptions())).resolves.toEqual({ kind: "lost" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(0);
    await expect(
      admin.query({
        text: `UPDATE hns_control_observer_reservations AS reservation
                  SET state = 'terminal',
                      terminal_snapshot_reference = operation.snapshot_reference,
                      terminal_status = 'unavailable',
                      terminal_at = reservation.reservation_database_time + INTERVAL '1 second',
                      updated_at = reservation.reservation_database_time + INTERVAL '1 second'
                 FROM hns_control_observer_operations AS operation
                WHERE operation.observation_id = reservation.observation_id
                  AND reservation.observation_id = $1`,
        values: [input.observation_id],
      }),
    ).rejects.toThrow("lost its lease or fence");
    completedTestCount += 1;
  });

  test("commits one append-only snapshot and exact concurrent replay", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await reservationInput("observer-pg-finalize-01");
    const left = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const right = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await left.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    const outcomes = await Promise.all([
      left.finalize(terminal, runOptions()),
      right.finalize(terminal, runOptions()),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["replay", "retained"]);
    await expect(
      left.finalize(
        {
          ...terminal,
          result_bytes: new Uint8Array([...terminal.result_bytes, 0]),
          result_sha256: "0".repeat(64) as Sha256HexValue,
        },
        runOptions(),
      ),
    ).resolves.toEqual({ kind: "mismatch" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(1);
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(1);
    await expect(
      admin.query("UPDATE hns_control_observer_snapshots SET result_bytes = result_bytes"),
    ).rejects.toThrow("append-only");
    await expect(
      admin.query("DELETE FROM hns_control_observer_snapshot_transcript_entries"),
    ).rejects.toThrow("append-only");
    await expect(
      admin.query(`INSERT INTO hns_control_observer_snapshot_transcript_entries (
                     snapshot_reference,
                     entry_ordinal,
                     driver_reference,
                     ownership_source,
                     method_or_view_id,
                     request_bytes,
                     request_sha256,
                     transport_outcome,
                     transport_status,
                     response_bytes,
                     response_sha256
                   )
                   SELECT snapshot_reference,
                          1,
                          driver_reference,
                          ownership_source,
                          method_or_view_id,
                          request_bytes,
                          request_sha256,
                          transport_outcome,
                          transport_status,
                          response_bytes,
                          response_sha256
                     FROM hns_control_observer_snapshot_transcript_entries
                    WHERE entry_ordinal = 0`),
    ).rejects.toThrow("not open for insertion");
    completedTestCount += 1;
  });

  test("rejects a logical snapshot above the complete accounting cap", async () => {
    const input = await reservationInput("observer-pg-capacity-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await expect(
      store.finalize(
        {
          ...terminal,
          semantic_facts_bytes: new Uint8Array(HNS_CONTROL_OBSERVER_SNAPSHOT_MAX_BYTES),
        },
        runOptions(),
      ),
    ).rejects.toThrow("snapshot bound");
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    completedTestCount += 1;
  });

  test("uses configured driver authority when a DNS view id matches an HSD method", async () => {
    const input = await reservationInput(
      "observer-pg-dns-method-collision-01",
      "pirate-verification=pg-observer-dns-01",
      dnsConfigurationValue,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 1,
      query_kind: "dnskey",
      root_label: "pgobserver",
    });
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "authoritative_dns_timeout",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          transcript: [
            {
              driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: dnskeyRequest,
              request_sha256: await rawSha256(dnskeyRequest),
              transport_outcome: "timeout",
              transport_status: null,
              response_bytes: null,
              response_sha256: null,
            },
          ],
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(1);
    completedTestCount += 1;
  });

  test("retains a no-DS insecure result before any DNS exchange", async () => {
    const input = await reservationInput(
      "observer-pg-dns-no-ds-01",
      "pirate-verification=pg-observer-no-ds-01",
      dnsConfigurationValue,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "authoritative_dns_insecure",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript: [],
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(0);
    completedTestCount += 1;
  });

  test("retains only chain-state owner rejections before authoritative DNS", async () => {
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    for (const reason of ["root_absent", "root_inactive"] as const) {
      const chainConfiguration = {
        ...dnsConfigurationValue,
        provider_configuration_reference: `hns-observer-pg-dns-${reason}`,
      } as const satisfies HnsControlObserverConfigurationV1;
      const input = await reservationInput(
        `observer-pg-owner-chain-${reason}`,
        `pirate-verification=pg-observer-${reason}`,
        chainConfiguration,
        "owner_authoritative_dns_txt",
      );
      const authority = acquired(await store.reserve(input, runOptions()));
      await expect(
        store.finalize(await ownerChainOnlyFinalizeInput(input, authority, reason), runOptions()),
      ).resolves.toMatchObject({ kind: "retained" });
    }

    const txtAbsentConfiguration = {
      ...dnsConfigurationValue,
      provider_configuration_reference: "hns-observer-pg-dns-txt-absent",
    } as const satisfies HnsControlObserverConfigurationV1;
    const invalidInput = await reservationInput(
      "observer-pg-owner-chain-txt-absent",
      "pirate-verification=pg-observer-txt-absent",
      txtAbsentConfiguration,
      "owner_authoritative_dns_txt",
    );
    const invalidAuthority = acquired(await store.reserve(invalidInput, runOptions()));
    await expect(
      store.finalize(
        await ownerChainOnlyFinalizeInput(invalidInput, invalidAuthority, "txt_absent"),
        runOptions(),
      ),
    ).rejects.toThrow("strict decoding");
    expect(await rowCount("hns_control_observer_snapshots")).toBe(2);
    expect(await rowCount("hns_control_observer_snapshot_transcript_entries")).toBe(2);
    completedTestCount += 1;
  });

  test("retains authenticated owner control before an expiry-horizon rejection", async () => {
    const expectedTxtValue = "pirate-verification=pg-observer-expiry";
    const expiryConfiguration = {
      ...dnsConfigurationValue,
      provider_configuration_reference: "hns-observer-pg-dns-expiry",
    } as const satisfies HnsControlObserverConfigurationV1;
    const input = await reservationInput(
      "observer-pg-owner-expiry-01",
      expectedTxtValue,
      expiryConfiguration,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const request = await decodeHnsControlObservationRequestBytes(input.request_bytes);
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 21,
      query_kind: "dnskey",
      root_label: request.request.root_label,
    });
    const controlRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 22,
      query_kind: "control_txt",
      root_label: request.request.root_label,
    });
    const dnskeyResponse = signedDnsResponse(dnskeyRequest, 48, new Uint8Array([1]));
    const controlTxtBytes = encoder.encode(expectedTxtValue);
    const controlResponse = signedDnsResponse(
      controlRequest,
      16,
      concatBytes([new Uint8Array([controlTxtBytes.byteLength]), controlTxtBytes]),
    );
    const authorityRecords = [
      ["NS", "ns1.pgobserver"],
      ["GLUE4", "ns1.pgobserver", "192.0.2.53"],
      ["DS", 12_345, 13, 2, "ab".repeat(32)],
    ] as const;
    const chainAuthorityDigest = await hnsChainAuthorityDigest({
      chain_network: expiryConfiguration.chain.network,
      chain_genesis_block_hash: expiryConfiguration.chain.genesis_block_hash,
      root_label: request.request.root_label,
      ownership_source: "owner_authoritative_dns_txt",
      authority_records: authorityRecords,
    });
    const observedTxtValuesDigest = await hnsObservedTxtValuesDigest([
      { chunks: [expectedTxtValue] },
    ]);
    if (observedTxtValuesDigest === null) throw new Error("expected TXT digest");
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "rejected",
        reason_code: "expiry_horizon_insufficient",
        provider_id: request.request.provider_id,
        provider_configuration_reference: request.request.provider_configuration_reference,
        provider_configuration_version: request.request.provider_configuration_version,
        provider_configuration_digest: request.request.provider_configuration_digest,
        environment: request.request.environment,
        ownership_source: request.request.ownership_source,
        root_label: request.request.root_label,
        txt_name: request.request.txt_name,
        expected_txt_value_sha256: await rawSha256(encoder.encode(expectedTxtValue)),
        observed_txt_values_digest: observedTxtValuesDigest,
        chain_authority_digest: chainAuthorityDigest,
        chain_network: expiryConfiguration.chain.network,
        chain_genesis_block_hash: expiryConfiguration.chain.genesis_block_hash,
        chain_anchor_height: 10,
        chain_anchor_block_hash: "8".repeat(64),
        chain_anchor_median_time: 1_700_000_000,
        expiry_height: 200,
        provider_evidence_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(
      resultBytes,
      request.request,
    );
    const dnskeyRequestSha256 = await rawSha256(dnskeyRequest);
    const dnskeyResponseSha256 = await rawSha256(dnskeyResponse);
    const controlRequestSha256 = await rawSha256(controlRequest);
    const controlResponseSha256 = await rawSha256(controlResponse);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript: [
            await hsdResponseTranscriptEntry("owner_authoritative_dns_txt"),
            {
              driver_reference: expiryConfiguration.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: dnskeyRequest,
              request_sha256: dnskeyRequestSha256,
              transport_outcome: "response",
              transport_status: null,
              response_bytes: dnskeyResponse,
              response_sha256: dnskeyResponseSha256,
            },
            {
              driver_reference: expiryConfiguration.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: controlRequest,
              request_sha256: controlRequestSha256,
              transport_outcome: "response",
              transport_status: null,
              response_bytes: controlResponse,
              response_sha256: controlResponseSha256,
            },
          ],
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([
            {
              view_id: "getblockchaininfo",
              authority_nameserver: "ns1.pgobserver",
              authority_address_family: "GLUE4",
              authority_address: "192.0.2.53",
              dnskey_request_sha256: dnskeyRequestSha256,
              dnskey_response_sha256: dnskeyResponseSha256,
              control_request_sha256: controlRequestSha256,
              control_response_sha256: controlResponseSha256,
              chain_authority_digest: chainAuthorityDigest,
              validation_database_time: authority.reservation_database_time,
              dnssec_validation: "secure",
              semantic_class: "txt_values",
              observed_txt_values_digest: observedTxtValuesDigest,
            },
          ]),
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(1);
    completedTestCount += 1;
  });

  test("retains completed secure views before a later unavailable DNS terminal", async () => {
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    for (const reason of [
      "authoritative_dns_timeout",
      "authoritative_dns_servfail",
      "observer_capacity",
    ] as const) {
      const terminalConfiguration = {
        ...dnsConfigurationValue,
        provider_configuration_reference: `hns-observer-pg-dns-${reason}`,
        authoritative_dns: {
          ...dnsConfigurationValue.authoritative_dns,
          required_view_ids: ["dns-view-a", "dns-view-b"],
        },
      } as const satisfies HnsControlObserverConfigurationV1;
      const input = await reservationInput(
        `observer-pg-owner-prefix-${reason}`,
        "pirate-verification=pg-observer-prefix",
        terminalConfiguration,
        "owner_authoritative_dns_txt",
      );
      const authority = acquired(await store.reserve(input, runOptions()));
      const request = await decodeHnsControlObservationRequestBytes(input.request_bytes);
      const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
        message_id: 31,
        query_kind: "dnskey",
        root_label: request.request.root_label,
      });
      const controlRequest = buildHnsAuthoritativeDnsQueryV1({
        message_id: 32,
        query_kind: "control_txt",
        root_label: request.request.root_label,
      });
      const terminalRequest = buildHnsAuthoritativeDnsQueryV1({
        message_id: 33,
        query_kind: "dnskey",
        root_label: request.request.root_label,
      });
      const dnskeyResponse = signedDnsResponse(dnskeyRequest, 48, new Uint8Array([1]));
      const controlTxtBytes = encoder.encode(request.request.expected_txt_value);
      const controlResponse = signedDnsResponse(
        controlRequest,
        16,
        concatBytes([new Uint8Array([controlTxtBytes.byteLength]), controlTxtBytes]),
      );
      const terminalResponse =
        reason === "authoritative_dns_timeout"
          ? null
          : reason === "authoritative_dns_servfail"
            ? servfailDnsResponse(terminalRequest)
            : new Uint8Array(terminalConfiguration.authoritative_dns.response_max_bytes);
      const chainAuthorityDigest = "5".repeat(64) as Sha256HexValue;
      const observedTxtValuesDigest = await hnsObservedTxtValuesDigest([
        { chunks: [request.request.expected_txt_value] },
      ]);
      if (observedTxtValuesDigest === null) throw new Error("expected TXT digest");
      const resultBytes = encoder.encode(
        JSON.stringify({
          version: "pirate-hns-control-observation-result-v1",
          observation_id: input.observation_id,
          request_sha256: input.request_sha256,
          status: "unavailable",
          reason_code: reason,
          retry_after_seconds: null,
          diagnostic_ref: authority.snapshot_reference,
        }),
      );
      const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
      const dnskeyRequestSha256 = await rawSha256(dnskeyRequest);
      const dnskeyResponseSha256 = await rawSha256(dnskeyResponse);
      const controlRequestSha256 = await rawSha256(controlRequest);
      const controlResponseSha256 = await rawSha256(controlResponse);
      const terminalRequestSha256 = await rawSha256(terminalRequest);
      const terminalResponseSha256 =
        terminalResponse === null ? null : await rawSha256(terminalResponse);
      const retainedAuthority = {
        observation_id: input.observation_id,
        observer_fence: authority.observer_fence,
        request_sha256: input.request_sha256,
        provider_configuration_digest: input.provider_configuration_digest,
        snapshot_reference: authority.snapshot_reference,
        transcript: [
          await hsdResponseTranscriptEntry("owner_authoritative_dns_txt"),
          {
            driver_reference: terminalConfiguration.authoritative_dns.driver_reference,
            ownership_source: "owner_authoritative_dns_txt" as const,
            method_or_view_id: "dns-view-a",
            request_bytes: dnskeyRequest,
            request_sha256: dnskeyRequestSha256,
            transport_outcome: "response" as const,
            transport_status: null,
            response_bytes: dnskeyResponse,
            response_sha256: dnskeyResponseSha256,
          },
          {
            driver_reference: terminalConfiguration.authoritative_dns.driver_reference,
            ownership_source: "owner_authoritative_dns_txt" as const,
            method_or_view_id: "dns-view-a",
            request_bytes: controlRequest,
            request_sha256: controlRequestSha256,
            transport_outcome: "response" as const,
            transport_status: null,
            response_bytes: controlResponse,
            response_sha256: controlResponseSha256,
          },
          {
            driver_reference: terminalConfiguration.authoritative_dns.driver_reference,
            ownership_source: "owner_authoritative_dns_txt" as const,
            method_or_view_id: "dns-view-b",
            request_bytes: terminalRequest,
            request_sha256: terminalRequestSha256,
            transport_outcome:
              reason === "authoritative_dns_timeout" ? ("timeout" as const) : ("response" as const),
            transport_status: null,
            response_bytes: terminalResponse,
            response_sha256: terminalResponseSha256,
          },
        ],
        semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([
          {
            view_id: "dns-view-a",
            authority_nameserver: "ns1.pgobserver",
            authority_address_family: "GLUE4",
            authority_address: "192.0.2.53",
            dnskey_request_sha256: dnskeyRequestSha256,
            dnskey_response_sha256: dnskeyResponseSha256,
            control_request_sha256: controlRequestSha256,
            control_response_sha256: controlResponseSha256,
            chain_authority_digest: chainAuthorityDigest,
            validation_database_time: authority.reservation_database_time,
            dnssec_validation: "secure",
            semantic_class: "txt_values",
            observed_txt_values_digest: observedTxtValuesDigest,
          },
        ]),
      };
      if (reason === "authoritative_dns_timeout") {
        const contradictoryResultBytes = encoder.encode(
          JSON.stringify({
            version: "pirate-hns-control-observation-result-v1",
            observation_id: input.observation_id,
            request_sha256: input.request_sha256,
            status: "unavailable",
            reason_code: "chain_transport_unavailable",
            retry_after_seconds: null,
            diagnostic_ref: authority.snapshot_reference,
          }),
        );
        const contradictoryResult =
          await decodeHnsControlObservationResultBytes(contradictoryResultBytes);
        await expect(
          store.finalize(
            {
              ...retainedAuthority,
              result_bytes: contradictoryResultBytes,
              result_sha256: contradictoryResult.result_sha256,
            },
            runOptions(),
          ),
        ).rejects.toThrow("strict decoding");
      }
      await expect(
        store.finalize(
          {
            ...retainedAuthority,
            result_bytes: resultBytes,
            result_sha256: decodedResult.result_sha256,
          },
          runOptions(),
        ),
      ).resolves.toMatchObject({ kind: "retained" });
    }
    expect(await rowCount("hns_control_observer_snapshots")).toBe(3);
    completedTestCount += 1;
  });

  test("does not invent semantic facts from a classifiable DNS capacity prefix", async () => {
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 11,
      query_kind: "dnskey",
      root_label: "pgobserver",
    });
    const controlRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 12,
      query_kind: "control_txt",
      root_label: "pgobserver",
    });
    const dnskeyResponse = signedDnsResponse(dnskeyRequest, 48, new Uint8Array([1]));
    const controlTxtBytes = encoder.encode("pirate-verification=capacity-prefix");
    const controlResponse = signedDnsResponse(
      controlRequest,
      16,
      concatBytes([new Uint8Array([controlTxtBytes.byteLength]), controlTxtBytes]),
    );
    const capacityConfiguration = {
      ...dnsConfigurationValue,
      provider_configuration_reference: "hns-observer-pg-dns-capacity",
      authoritative_dns: {
        ...dnsConfigurationValue.authoritative_dns,
        response_max_bytes: controlResponse.byteLength,
      },
    } as const satisfies HnsControlObserverConfigurationV1;
    const input = await reservationInput(
      "observer-pg-dns-capacity-01",
      "pirate-verification=pg-observer-capacity-01",
      capacityConfiguration,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "observer_capacity",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(resultBytes);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript: [
            {
              driver_reference: capacityConfiguration.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: dnskeyRequest,
              request_sha256: await rawSha256(dnskeyRequest),
              transport_outcome: "response",
              transport_status: null,
              response_bytes: dnskeyResponse,
              response_sha256: await rawSha256(dnskeyResponse),
            },
            {
              driver_reference: capacityConfiguration.authoritative_dns.driver_reference,
              ownership_source: "owner_authoritative_dns_txt",
              method_or_view_id: "getblockchaininfo",
              request_bytes: controlRequest,
              request_sha256: await rawSha256(controlRequest),
              transport_outcome: "response",
              transport_status: null,
              response_bytes: controlResponse,
              response_sha256: await rawSha256(controlResponse),
            },
          ],
          semantic_facts_bytes: encodeHnsAuthoritativeDnsSemanticFactsV1([]),
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).resolves.toMatchObject({ kind: "retained" });
    expect(await rowCount("hns_control_observer_snapshots")).toBe(1);
    completedTestCount += 1;
  });

  test("rejects owner-DNS semantic facts that contradict the terminal result", async () => {
    const expectedTxtValue = "pirate-verification=pg-observer-dns-digest-01";
    const input = await reservationInput(
      "observer-pg-dns-digest-drift-01",
      expectedTxtValue,
      dnsConfigurationValue,
      "owner_authoritative_dns_txt",
    );
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const decodedRequest = await decodeHnsControlObservationRequestBytes(input.request_bytes);
    const dnskeyRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 3,
      query_kind: "dnskey",
      root_label: decodedRequest.request.root_label,
    });
    const controlRequest = buildHnsAuthoritativeDnsQueryV1({
      message_id: 4,
      query_kind: "control_txt",
      root_label: decodedRequest.request.root_label,
    });
    const dnskeyResponse = signedDnsResponse(dnskeyRequest, 48, new Uint8Array([1]));
    const controlTxtBytes = encoder.encode("pirate-verification=other");
    const controlResponse = signedDnsResponse(
      controlRequest,
      16,
      concatBytes([new Uint8Array([controlTxtBytes.byteLength]), controlTxtBytes]),
    );
    const resultChainDigest = "5".repeat(64) as Sha256HexValue;
    const forgedFactsChainDigest = "6".repeat(64) as Sha256HexValue;
    const observedTxtValuesDigest = await hnsObservedTxtValuesDigest([
      { chunks: ["pirate-verification=other"] },
    ]);
    if (observedTxtValuesDigest === null) {
      throw new Error("expected an observed TXT digest");
    }
    const resultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "rejected",
        reason_code: "txt_value_mismatch",
        provider_id: decodedRequest.request.provider_id,
        provider_configuration_reference: decodedRequest.request.provider_configuration_reference,
        provider_configuration_version: decodedRequest.request.provider_configuration_version,
        provider_configuration_digest: decodedRequest.request.provider_configuration_digest,
        environment: decodedRequest.request.environment,
        ownership_source: decodedRequest.request.ownership_source,
        root_label: decodedRequest.request.root_label,
        txt_name: decodedRequest.request.txt_name,
        expected_txt_value_sha256: await rawSha256(encoder.encode(expectedTxtValue)),
        observed_txt_values_digest: observedTxtValuesDigest,
        chain_authority_digest: resultChainDigest,
        chain_network: dnsConfigurationValue.chain.network,
        chain_genesis_block_hash: dnsConfigurationValue.chain.genesis_block_hash,
        chain_anchor_height: 10,
        chain_anchor_block_hash: "8".repeat(64),
        chain_anchor_median_time: 1_700_000_000,
        expiry_height: 1_000,
        provider_evidence_ref: authority.snapshot_reference,
      }),
    );
    const decodedResult = await decodeHnsControlObservationResultBytes(
      resultBytes,
      decodedRequest.request,
    );
    const transcript = [
      {
        driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
        ownership_source: "owner_authoritative_dns_txt" as const,
        method_or_view_id: "getblockchaininfo",
        request_bytes: dnskeyRequest,
        request_sha256: await rawSha256(dnskeyRequest),
        transport_outcome: "response" as const,
        transport_status: null,
        response_bytes: dnskeyResponse,
        response_sha256: await rawSha256(dnskeyResponse),
      },
      {
        driver_reference: dnsConfigurationValue.authoritative_dns.driver_reference,
        ownership_source: "owner_authoritative_dns_txt" as const,
        method_or_view_id: "getblockchaininfo",
        request_bytes: controlRequest,
        request_sha256: await rawSha256(controlRequest),
        transport_outcome: "response" as const,
        transport_status: null,
        response_bytes: controlResponse,
        response_sha256: await rawSha256(controlResponse),
      },
    ];
    const dnskeyTranscript = transcript[0];
    const controlTranscript = transcript[1];
    if (dnskeyTranscript === undefined || controlTranscript === undefined) {
      throw new Error("expected complete DNS transcript pair");
    }
    const semanticFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "getblockchaininfo",
        authority_nameserver: "ns1.pgobserver",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: dnskeyTranscript.request_sha256,
        dnskey_response_sha256: dnskeyTranscript.response_sha256,
        control_request_sha256: controlTranscript.request_sha256,
        control_response_sha256: controlTranscript.response_sha256,
        chain_authority_digest: forgedFactsChainDigest,
        validation_database_time: authority.reservation_database_time,
        dnssec_validation: "secure",
        semantic_class: "txt_values",
        observed_txt_values_digest: observedTxtValuesDigest,
      },
    ]);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript,
          semantic_facts_bytes: semanticFacts,
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("semantic facts");
    const contradictoryNegativeFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "getblockchaininfo",
        authority_nameserver: "ns1.pgobserver",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: dnskeyTranscript.request_sha256,
        dnskey_response_sha256: dnskeyTranscript.response_sha256,
        control_request_sha256: controlTranscript.request_sha256,
        control_response_sha256: controlTranscript.response_sha256,
        chain_authority_digest: resultChainDigest,
        validation_database_time: authority.reservation_database_time,
        dnssec_validation: "secure",
        semantic_class: "nxdomain",
        observed_txt_values_digest: null,
      },
    ]);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript,
          semantic_facts_bytes: contradictoryNegativeFacts,
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("semantic facts");
    const contradictoryTxtDigestFacts = encodeHnsAuthoritativeDnsSemanticFactsV1([
      {
        view_id: "getblockchaininfo",
        authority_nameserver: "ns1.pgobserver",
        authority_address_family: "GLUE4",
        authority_address: "192.0.2.53",
        dnskey_request_sha256: dnskeyTranscript.request_sha256,
        dnskey_response_sha256: dnskeyTranscript.response_sha256,
        control_request_sha256: controlTranscript.request_sha256,
        control_response_sha256: controlTranscript.response_sha256,
        chain_authority_digest: resultChainDigest,
        validation_database_time: authority.reservation_database_time,
        dnssec_validation: "secure",
        semantic_class: "txt_values",
        observed_txt_values_digest: "9".repeat(64) as Sha256HexValue,
      },
    ]);
    await expect(
      store.finalize(
        {
          observation_id: input.observation_id,
          observer_fence: authority.observer_fence,
          request_sha256: input.request_sha256,
          provider_configuration_digest: input.provider_configuration_digest,
          snapshot_reference: authority.snapshot_reference,
          transcript,
          semantic_facts_bytes: contradictoryTxtDigestFacts,
          result_bytes: resultBytes,
          result_sha256: decodedResult.result_sha256,
        },
        runOptions(),
      ),
    ).rejects.toThrow("semantic facts");
    const inconclusiveResultBytes = encoder.encode(
      JSON.stringify({
        version: "pirate-hns-control-observation-result-v1",
        observation_id: input.observation_id,
        request_sha256: input.request_sha256,
        status: "unavailable",
        reason_code: "authoritative_dns_inconclusive",
        retry_after_seconds: null,
        diagnostic_ref: authority.snapshot_reference,
      }),
    );
    const decodedInconclusiveResult =
      await decodeHnsControlObservationResultBytes(inconclusiveResultBytes);
    for (const incompleteOrAgreeingFacts of [
      encodeHnsAuthoritativeDnsSemanticFactsV1([]),
      encodeHnsAuthoritativeDnsSemanticFactsV1([
        {
          view_id: "getblockchaininfo",
          authority_nameserver: "ns1.pgobserver",
          authority_address_family: "GLUE4",
          authority_address: "192.0.2.53",
          dnskey_request_sha256: dnskeyTranscript.request_sha256,
          dnskey_response_sha256: dnskeyTranscript.response_sha256,
          control_request_sha256: controlTranscript.request_sha256,
          control_response_sha256: controlTranscript.response_sha256,
          chain_authority_digest: resultChainDigest,
          validation_database_time: authority.reservation_database_time,
          dnssec_validation: "secure",
          semantic_class: "txt_values",
          observed_txt_values_digest: observedTxtValuesDigest,
        },
      ]),
    ]) {
      await expect(
        store.finalize(
          {
            observation_id: input.observation_id,
            observer_fence: authority.observer_fence,
            request_sha256: input.request_sha256,
            provider_configuration_digest: input.provider_configuration_digest,
            snapshot_reference: authority.snapshot_reference,
            transcript,
            semantic_facts_bytes: incompleteOrAgreeingFacts,
            result_bytes: inconclusiveResultBytes,
            result_sha256: decodedInconclusiveResult.result_sha256,
          },
          runOptions(),
        ),
      ).rejects.toThrow("semantic facts");
    }
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    completedTestCount += 1;
  });

  test("aborting lock-blocked reserve and finalize transactions leaves no late write", async () => {
    if (admin === undefined) throw new Error("Postgres test schema is unavailable");
    const input = await reservationInput("observer-pg-abort-01");
    const store = makeControlPlaneHnsControlObserverSnapshotStore(runtime());
    const authority = acquired(await store.reserve(input, runOptions()));
    const terminal = await finalizeInput(input, authority);
    await admin.query("BEGIN");
    await admin.query({
      text: "SELECT observation_id FROM hns_control_observer_operations WHERE observation_id = $1 FOR UPDATE",
      values: [input.observation_id],
    });
    const reserveController = new AbortController();
    const blockedReserve = store.reserve(input, runOptions(reserveController.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    reserveController.abort();
    await expect(blockedReserve).rejects.toThrow();
    await admin.query("COMMIT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterReserve = await admin.query<{ state: string; observer_fence: string }>({
      text: `SELECT state, observer_fence::text
               FROM hns_control_observer_reservations
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(afterReserve.rows).toEqual([{ state: "reserved", observer_fence: "1" }]);

    await admin.query("BEGIN");
    await admin.query({
      text: "SELECT observation_id FROM hns_control_observer_operations WHERE observation_id = $1 FOR UPDATE",
      values: [input.observation_id],
    });
    const finalizeController = new AbortController();
    const blockedFinalize = store.finalize(terminal, runOptions(finalizeController.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    finalizeController.abort();
    await expect(blockedFinalize).rejects.toThrow();
    await admin.query("COMMIT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await rowCount("hns_control_observer_snapshots")).toBe(0);
    const afterFinalize = await admin.query<{ state: string; observer_fence: string }>({
      text: `SELECT state, observer_fence::text
               FROM hns_control_observer_reservations
              WHERE observation_id = $1`,
      values: [input.observation_id],
    });
    expect(afterFinalize.rows).toEqual([{ state: "reserved", observer_fence: "1" }]);
    completedTestCount += 1;
  }, 15_000);

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    if (connectionString !== undefined && completedTestCount === testCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
