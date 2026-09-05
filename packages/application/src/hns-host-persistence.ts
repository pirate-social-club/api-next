import type { Effect } from "effect";
import {
  decodeHnsAuthorityInventoryBytes,
  encodeHnsAuthorityInventory,
} from "./namespace-ownership/hns-authority-inventory.ts";
import {
  type HnsChainAuthorityRecord,
  hnsChainAuthorityDigest,
  hnsChainAuthorityRecords,
  hnsControlIdentityDigest,
} from "./namespace-ownership/hns-control-observer.ts";
import { decodeStrictHnsJsonBytes } from "./namespace-ownership/hns-evidence.ts";
import type { ControlPlaneError } from "./ports.ts";

export type HnsDnsZoneActivationLifecycleStatusV1 = "active" | "suspended" | "revoked";

export const HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION =
  "pirate-hns-dns-zone-activation-document-v1" as const;
export const HNS_DNS_ZONE_PERSISTENCE_DOCUMENT_VERSION =
  "pirate-hns-dns-zone-persistence-document-v1" as const;

export type HnsAuthoritySuccessorGenerationSnapshotV1 = Readonly<{
  dns_zone_activation_id: string;
  dns_current_generation: number;
  app_host_activation_id: string;
  app_host_current_generation: number;
  successor_dns_latest_health_generation: number;
}>;

export type HnsAuthoritySuccessorGenerationReaderV1 = Readonly<{
  read: (
    identity: Readonly<{ canonical_root: string; normalized_app_host: string }>,
    options: Readonly<{ signal: AbortSignal }>,
  ) =>
    | Promise<
        Readonly<{
          database_time: string;
          snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
        }>
      >
    | Readonly<{
        database_time: string;
        snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
      }>;
}>;

export type HnsAuthoritySuccessorInventoryReaderV1 = Readonly<{
  read: (options: Readonly<{ signal: AbortSignal }>) => Promise<Uint8Array>;
}>;

export type HnsAuthoritySuccessorGenerationsV1 = Readonly<{
  dns_activation_generation: number;
  app_host_activation_generation: number;
  health_generation: number;
}>;

export type HnsAuthorityEmitDsV1 = readonly [number, 13, 2 | 4, string];
export type HnsAuthorityEmitChainRecordV1 = HnsChainAuthorityRecord;
export type HnsAuthorityEmitViewV1 = Readonly<{
  attestation_kind: "operator_attested_authority_view_v1";
  authority_address: string;
  outcome: "observed" | "unavailable";
  zone_bytes_digest: string | null;
  dnskey_key_tag: number | null;
  derived_ds: ReadonlyArray<HnsAuthorityEmitDsV1> | null;
}>;

export type HnsAuthorityAddressRecordV1 = readonly ["A" | "AAAA", string, string];
export type HnsAuthorityAddressProvenanceV1 =
  | Readonly<{ readonly source_kind: "chain_glue_v1" }>
  | Readonly<{
      readonly source_kind: "detached_parent_authority_attestation_v1";
      readonly parent_zone: string;
      readonly parent_chain_authority_digest: string;
      readonly parent_chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
      readonly views: readonly [
        Readonly<{
          readonly view_id: string;
          readonly vantage_reference: string;
          readonly outcome: "observed" | "unavailable";
          readonly validation_attestation:
            | "operator_attested_dnssec_secure"
            | "operator_attested_insecure"
            | "operator_attested_bogus"
            | "operator_attested_indeterminate";
          readonly attested_dnskey_key_tag: number | null;
          readonly attested_derived_ds: ReadonlyArray<HnsAuthorityEmitDsV1> | null;
          readonly records: ReadonlyArray<HnsAuthorityAddressRecordV1> | null;
        }>,
        Readonly<{
          readonly view_id: string;
          readonly vantage_reference: string;
          readonly outcome: "observed" | "unavailable";
          readonly validation_attestation:
            | "operator_attested_dnssec_secure"
            | "operator_attested_insecure"
            | "operator_attested_bogus"
            | "operator_attested_indeterminate";
          readonly attested_dnskey_key_tag: number | null;
          readonly attested_derived_ds: ReadonlyArray<HnsAuthorityEmitDsV1> | null;
          readonly records: ReadonlyArray<HnsAuthorityAddressRecordV1> | null;
        }>,
      ];
    }>;

export class HnsAuthorityEmitRefusal extends Error {
  readonly name = "HnsAuthorityEmitRefusal";
  constructor(
    readonly reason:
      | "incomplete_authority_views"
      | "unavailable_authority_view"
      | "authority_view_mismatch"
      | "dnskey_ds_mismatch"
      | "candidate_metadata_invalid"
      | "incomplete_candidate_artifacts"
      | "noncanonical_candidate_artifact"
      | "observer_evidence_not_verified"
      | "observer_evidence_mismatch"
      | "control_identity_mismatch"
      | "parent_chain_anchor_mismatch"
      | "parent_delegation_mismatch"
      | "parent_address_mismatch"
      | "parent_view_identity_mismatch"
      | "parent_view_unavailable"
      | "parent_view_attestation_mismatch"
      | "artifact_semantics_mismatch",
  ) {
    super(`HNS authority candidate emission refused: ${reason}`);
  }
}

export const HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION =
  "pirate-hns-authority-successor-candidate-v1" as const;
export const HNS_AUTHORITY_DETACHED_OBSERVER_EVIDENCE_VERSION =
  "pirate-hns-authority-detached-observer-evidence-v1" as const;
export const HNS_AUTHORITY_SUCCESSOR_CHAIN_NETWORK = "main" as const;
// HSD mainnet block 0 `hash` from handshake-org/hsd lib/protocol/genesis.js.
export const HNS_MAINNET_GENESIS_BLOCK_HASH =
  "5b6ef2d3c1f3cdcadfd9a030ba1811efdd17740f14e166489760741d075992e0" as const;

export type HnsAuthorityDetachedTranscriptEntryV1 = Readonly<{
  exchange_kind: "hns_rpc" | "child_authority_dns" | "parent_authority_dns";
  vantage_reference: string;
  subject_reference: string;
  query_reference: string;
  request_bytes: Uint8Array;
  response_bytes: Uint8Array;
}>;

export type HnsAuthorityEncodedTranscriptEntryV1 = Readonly<{
  exchange_kind: HnsAuthorityDetachedTranscriptEntryV1["exchange_kind"];
  vantage_reference: string;
  subject_reference: string;
  query_reference: string;
  request_sha256: string;
  response_sha256: string;
  request_hex: string;
  response_hex: string;
}>;

export type HnsAuthorityDetachedObserverFactsV1 = Readonly<{
  observation_id: string;
  request_sha256: string;
  provider_id: string;
  provider_configuration_reference: string;
  provider_configuration_version: string;
  provider_configuration_digest: string;
  environment: string;
  ownership_source: "owner_authoritative_dns_txt";
  root_label: string;
  txt_name: string;
  expected_txt_value: string;
  chain_authority_digest: string;
  root_exists: true;
  root_control_verified: true;
  expiry_horizon_sufficient: true;
  chain_anchor_height: number;
  chain_anchor_block_hash: string;
  chain_anchor_median_time: number;
  expiry_height: number;
  evidence_reference: string;
}>;

export type HnsAuthorityDetachedObserverEvidenceV1 = Readonly<{
  version: typeof HNS_AUTHORITY_DETACHED_OBSERVER_EVIDENCE_VERSION;
  observation_id: string;
  request_sha256: string;
  status: "verified";
  provider_id: string;
  provider_configuration_reference: string;
  provider_configuration_version: string;
  provider_configuration_digest: string;
  environment: string;
  ownership_source: "owner_authoritative_dns_txt";
  root_label: string;
  txt_name: string;
  expected_txt_value: string;
  expected_txt_value_sha256: string;
  control_identity_digest: string;
  chain_authority_digest: string;
  root_exists: true;
  root_control_verified: true;
  expiry_horizon_sufficient: true;
  chain_network: string;
  chain_genesis_block_hash: string;
  chain_anchor_height: number;
  chain_anchor_block_hash: string;
  chain_anchor_median_time: number;
  expiry_height: number;
  evidence_reference: string;
  detached_transcript_sha256: string;
  detached_transcript: ReadonlyArray<HnsAuthorityEncodedTranscriptEntryV1>;
}>;

type HnsAuthorityCandidateArtifactName =
  | "authority_inventory"
  | "dns_zone_activation"
  | "app_host_activation"
  | "health_observation"
  | "observer_evidence";

export type HnsAuthoritySuccessorCandidateV1 = Readonly<{
  version: typeof HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION;
  source_commit: string;
  root_label: string;
  observed_at: string;
  chain_height: number;
  chain_network: string;
  chain_genesis_block_hash: string;
  chain_authority_digest: string;
  chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  authority_address_provenance: HnsAuthorityAddressProvenanceV1;
  generations: HnsAuthoritySuccessorGenerationsV1;
  dnskey_key_tag: number;
  authority_views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
  chain_ds: ReadonlyArray<HnsAuthorityEmitDsV1>;
  artifacts: ReadonlyArray<
    Readonly<{
      name: HnsAuthorityCandidateArtifactName;
      sha256: string;
      bytes_hex: string;
    }>
  >;
}>;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

const detachedObserverEvidenceKeys = [
  "version",
  "observation_id",
  "request_sha256",
  "status",
  "provider_id",
  "provider_configuration_reference",
  "provider_configuration_version",
  "provider_configuration_digest",
  "environment",
  "ownership_source",
  "root_label",
  "txt_name",
  "expected_txt_value",
  "expected_txt_value_sha256",
  "control_identity_digest",
  "chain_authority_digest",
  "root_exists",
  "root_control_verified",
  "expiry_horizon_sufficient",
  "chain_network",
  "chain_genesis_block_hash",
  "chain_anchor_height",
  "chain_anchor_block_hash",
  "chain_anchor_median_time",
  "expiry_height",
  "evidence_reference",
  "detached_transcript_sha256",
  "detached_transcript",
] as const;

export async function decodeHnsAuthorityDetachedObserverEvidenceV1(
  bytes: Uint8Array,
): Promise<HnsAuthorityDetachedObserverEvidenceV1> {
  const value = decodeCanonicalDocument(bytes);
  if (
    !exactObject(value, detachedObserverEvidenceKeys) ||
    value.version !== HNS_AUTHORITY_DETACHED_OBSERVER_EVIDENCE_VERSION ||
    !validIdentity(value.observation_id) ||
    !validHash(value.request_sha256) ||
    value.status !== "verified" ||
    !validIdentity(value.provider_id) ||
    !validIdentity(value.provider_configuration_reference) ||
    !validIdentity(value.provider_configuration_version) ||
    !validHash(value.provider_configuration_digest) ||
    !validIdentity(value.environment) ||
    value.ownership_source !== "owner_authoritative_dns_txt" ||
    typeof value.root_label !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value.root_label) ||
    !validIdentity(value.txt_name) ||
    !validIdentity(value.expected_txt_value) ||
    new TextEncoder().encode(value.expected_txt_value).byteLength > 4_096 ||
    !validHash(value.expected_txt_value_sha256) ||
    !validHash(value.control_identity_digest) ||
    !validHash(value.chain_authority_digest) ||
    value.root_exists !== true ||
    value.root_control_verified !== true ||
    value.expiry_horizon_sufficient !== true ||
    value.chain_network !== HNS_AUTHORITY_SUCCESSOR_CHAIN_NETWORK ||
    value.chain_genesis_block_hash !== HNS_MAINNET_GENESIS_BLOCK_HASH ||
    !Number.isSafeInteger(value.chain_anchor_height) ||
    Number(value.chain_anchor_height) <= 0 ||
    !validHash(value.chain_anchor_block_hash) ||
    !Number.isSafeInteger(value.chain_anchor_median_time) ||
    Number(value.chain_anchor_median_time) <= 0 ||
    !Number.isSafeInteger(value.expiry_height) ||
    Number(value.expiry_height) <= Number(value.chain_anchor_height) ||
    !validIdentity(value.evidence_reference) ||
    !validHash(value.detached_transcript_sha256) ||
    !Array.isArray(value.detached_transcript) ||
    value.detached_transcript.length < 6 ||
    value.detached_transcript.length > 64
  ) {
    throw new TypeError("HNS detached observer evidence is invalid");
  }
  for (const entry of value.detached_transcript) {
    if (
      !exactObject(entry, [
        "exchange_kind",
        "vantage_reference",
        "subject_reference",
        "query_reference",
        "request_sha256",
        "response_sha256",
        "request_hex",
        "response_hex",
      ]) ||
      (entry.exchange_kind !== "hns_rpc" &&
        entry.exchange_kind !== "child_authority_dns" &&
        entry.exchange_kind !== "parent_authority_dns") ||
      !validIdentity(entry.vantage_reference) ||
      !validIdentity(entry.subject_reference) ||
      !validIdentity(entry.query_reference) ||
      !validHash(entry.request_sha256) ||
      !validHash(entry.response_sha256)
    ) {
      throw new TypeError("HNS detached observer transcript is invalid");
    }
    const request = bytesFromHex(entry.request_hex);
    const response = bytesFromHex(entry.response_hex);
    if (
      request.byteLength === 0 ||
      response.byteLength === 0 ||
      (await sha256Hex(request)) !== entry.request_sha256 ||
      (await sha256Hex(response)) !== entry.response_sha256
    ) {
      throw new TypeError("HNS detached observer transcript digest is invalid");
    }
  }
  const transcriptDigest = await sha256Hex(
    canonicalDocumentBytes([
      "pirate-hns-authority-detached-transcript-v1",
      value.detached_transcript,
    ]),
  );
  if (transcriptDigest !== value.detached_transcript_sha256) {
    throw new TypeError("HNS detached observer transcript binding is invalid");
  }
  const expectedTxtValueSha256 = await sha256Hex(
    new TextEncoder().encode(value.expected_txt_value),
  );
  const controlIdentityDigest = await hnsControlIdentityDigest({
    ownership_source: value.ownership_source,
    txt_name: value.txt_name,
    expected_txt_value: value.expected_txt_value,
    root_label: value.root_label,
    chain_authority_digest: value.chain_authority_digest as Parameters<
      typeof hnsControlIdentityDigest
    >[0]["chain_authority_digest"],
  });
  if (
    expectedTxtValueSha256 !== value.expected_txt_value_sha256 ||
    controlIdentityDigest !== value.control_identity_digest
  ) {
    throw new TypeError("HNS detached observer control identity binding is invalid");
  }
  return value as HnsAuthorityDetachedObserverEvidenceV1;
}

export async function encodeHnsAuthorityDetachedObserverEvidenceV1(
  input: HnsAuthorityDetachedObserverFactsV1 &
    Readonly<{ detached_transcript: ReadonlyArray<HnsAuthorityDetachedTranscriptEntryV1> }>,
): Promise<Uint8Array> {
  const expectedTxtValueSha256 = await sha256Hex(
    new TextEncoder().encode(input.expected_txt_value),
  );
  const controlIdentityDigest = await hnsControlIdentityDigest({
    ownership_source: input.ownership_source,
    txt_name: input.txt_name,
    expected_txt_value: input.expected_txt_value,
    root_label: input.root_label,
    chain_authority_digest: input.chain_authority_digest as Parameters<
      typeof hnsControlIdentityDigest
    >[0]["chain_authority_digest"],
  });
  const detachedTranscript = await Promise.all(
    input.detached_transcript.map(async (entry) => ({
      exchange_kind: entry.exchange_kind,
      vantage_reference: entry.vantage_reference,
      subject_reference: entry.subject_reference,
      query_reference: entry.query_reference,
      request_sha256: await sha256Hex(entry.request_bytes),
      response_sha256: await sha256Hex(entry.response_bytes),
      request_hex: hex(entry.request_bytes),
      response_hex: hex(entry.response_bytes),
    })),
  );
  const detachedTranscriptSha256 = await sha256Hex(
    canonicalDocumentBytes(["pirate-hns-authority-detached-transcript-v1", detachedTranscript]),
  );
  const bytes = canonicalDocumentBytes({
    version: HNS_AUTHORITY_DETACHED_OBSERVER_EVIDENCE_VERSION,
    observation_id: input.observation_id,
    request_sha256: input.request_sha256,
    status: "verified",
    provider_id: input.provider_id,
    provider_configuration_reference: input.provider_configuration_reference,
    provider_configuration_version: input.provider_configuration_version,
    provider_configuration_digest: input.provider_configuration_digest,
    environment: input.environment,
    ownership_source: input.ownership_source,
    root_label: input.root_label,
    txt_name: input.txt_name,
    expected_txt_value: input.expected_txt_value,
    expected_txt_value_sha256: expectedTxtValueSha256,
    control_identity_digest: controlIdentityDigest,
    chain_authority_digest: input.chain_authority_digest,
    root_exists: input.root_exists,
    root_control_verified: input.root_control_verified,
    expiry_horizon_sufficient: input.expiry_horizon_sufficient,
    chain_network: HNS_AUTHORITY_SUCCESSOR_CHAIN_NETWORK,
    chain_genesis_block_hash: HNS_MAINNET_GENESIS_BLOCK_HASH,
    chain_anchor_height: input.chain_anchor_height,
    chain_anchor_block_hash: input.chain_anchor_block_hash,
    chain_anchor_median_time: input.chain_anchor_median_time,
    expiry_height: input.expiry_height,
    evidence_reference: input.evidence_reference,
    detached_transcript_sha256: detachedTranscriptSha256,
    detached_transcript: detachedTranscript,
  });
  await decodeHnsAuthorityDetachedObserverEvidenceV1(bytes);
  return bytes;
}

function canonicalHsdName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.toLowerCase() ||
    !value.endsWith(".") ||
    value.endsWith("..")
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  const canonical = value.slice(0, -1);
  try {
    hnsChainAuthorityRecords("owner_authoritative_dns_txt", [["NS", canonical]]);
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  return canonical;
}

function decodeHsdTranscriptResponse(responseHex: string): unknown {
  const wire = bytesFromHex(responseHex);
  // HSD terminates its HTTP JSON body with one LF. Retain it in the transcript.
  const json = wire[wire.byteLength - 1] === 0x0a ? wire.subarray(0, -1) : wire;
  return decodeStrictHnsJsonBytes(json, 8 * 1_024 * 1_024);
}

function decodeHsdTranscriptAuthorityRecords(
  entry: HnsAuthorityEncodedTranscriptEntryV1,
): Readonly<{
  authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  txt_values: ReadonlyArray<string>;
}> {
  let request: unknown;
  let response: unknown;
  try {
    request = decodeStrictHnsJsonBytes(bytesFromHex(entry.request_hex), 1_048_576);
    response = decodeHsdTranscriptResponse(entry.response_hex);
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  // This is the canonical request/response envelope enforced by the existing
  // HSD private transport; a live transcript remains a separate ceremony input.
  if (
    !hasExactKeys(request, ["method", "params"]) ||
    request.method !== "getnameresource" ||
    !Array.isArray(request.params) ||
    request.params.length !== 2 ||
    request.params[0] !== entry.subject_reference ||
    request.params[1] !== false ||
    !hasExactKeys(response, ["result", "error", "id"]) ||
    response.error !== null ||
    response.id !== null ||
    !hasExactKeys(response.result, ["records"]) ||
    !Array.isArray(response.result.records)
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  const authorityRecords: HnsChainAuthorityRecord[] = [];
  const txtValues: string[] = [];
  for (const unknownRecord of response.result.records) {
    if (
      unknownRecord === null ||
      typeof unknownRecord !== "object" ||
      Array.isArray(unknownRecord) ||
      !("type" in unknownRecord)
    ) {
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
    const record = unknownRecord as Record<string, unknown>;
    if (record.type === "TXT") {
      if (
        !hasExactKeys(record, ["type", "txt"]) ||
        !Array.isArray(record.txt) ||
        record.txt.length === 0 ||
        record.txt.some(
          (chunk) =>
            typeof chunk !== "string" ||
            new TextEncoder().encode(chunk).byteLength > 255 ||
            [...chunk].some((character) => {
              const point = character.codePointAt(0) ?? 0;
              return point >= 0xd800 && point <= 0xdfff;
            }),
        )
      ) {
        throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
      }
      txtValues.push(record.txt.join(""));
      continue;
    }
    if (record.type === "NS") {
      if (!hasExactKeys(record, ["type", "ns"])) {
        throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
      }
      authorityRecords.push(["NS", canonicalHsdName(record.ns)]);
      continue;
    }
    if (record.type === "GLUE4" || record.type === "GLUE6") {
      if (!hasExactKeys(record, ["type", "ns", "address"]) || typeof record.address !== "string") {
        throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
      }
      authorityRecords.push([record.type, canonicalHsdName(record.ns), record.address]);
      continue;
    }
    if (record.type === "SYNTH4" || record.type === "SYNTH6") {
      // Synthetic records do not have an owner name and therefore cannot be
      // represented in the authority-record digest without inventing one.
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
    if (record.type === "DS") {
      if (
        !hasExactKeys(record, ["type", "keyTag", "algorithm", "digestType", "digest"]) ||
        typeof record.keyTag !== "number" ||
        typeof record.algorithm !== "number" ||
        typeof record.digestType !== "number" ||
        typeof record.digest !== "string"
      ) {
        throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
      }
      authorityRecords.push([
        "DS",
        record.keyTag,
        record.algorithm,
        record.digestType,
        record.digest.toLowerCase(),
      ]);
      continue;
    }
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  try {
    return {
      authority_records: hnsChainAuthorityRecords("owner_authoritative_dns_txt", authorityRecords),
      txt_values: txtValues,
    };
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
}

function decodeHsdTranscriptRpcResult(
  entry: HnsAuthorityEncodedTranscriptEntryV1,
  method: "getblockchaininfo" | "getblockheader" | "getnameinfo",
  params: ReadonlyArray<unknown>,
): unknown {
  let request: unknown;
  let response: unknown;
  const requestBytes = bytesFromHex(entry.request_hex);
  try {
    request = decodeStrictHnsJsonBytes(requestBytes, 1_048_576);
    response = decodeHsdTranscriptResponse(entry.response_hex);
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  if (
    !hasExactKeys(request, ["method", "params"]) ||
    request.method !== method ||
    JSON.stringify(request.params) !== JSON.stringify(params) ||
    !equalBytes(requestBytes, new TextEncoder().encode(JSON.stringify({ method, params }))) ||
    !hasExactKeys(response, ["result", "error", "id"]) ||
    response.error !== null ||
    response.id !== null ||
    response.result === null
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  return response.result;
}

function hsdResultRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  return value as Record<string, unknown>;
}

function safeRpcInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireDetachedChainAnchorSemantics(
  evidence: HnsAuthorityDetachedObserverEvidenceV1,
  rootLabel: string,
  parentZone: string | undefined,
): void {
  const expectedReferences = [
    "getblockchaininfo:before",
    "getblockheader:tip-before",
    "getblockheader:genesis",
    `getnameinfo:${rootLabel}`,
    `getnameresource:${rootLabel}`,
    ...(parentZone === undefined ? [] : [`getnameresource:${parentZone}`]),
    "getblockchaininfo:after",
    "getblockheader:tip-after",
  ];
  const entries = evidence.detached_transcript.filter((entry) => entry.exchange_kind === "hns_rpc");
  if (
    entries.length !== expectedReferences.length ||
    entries.some((entry, index) => entry.query_reference !== expectedReferences[index]) ||
    new Set(entries.map((entry) => entry.vantage_reference)).size !== 1 ||
    entries.some(
      (entry) =>
        entry.subject_reference !== rootLabel &&
        !(
          entry.query_reference === `getnameresource:${parentZone}` &&
          entry.subject_reference === parentZone
        ),
    )
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  const byReference = new Map(entries.map((entry) => [entry.query_reference, entry]));
  const requiredEntry = (reference: string): HnsAuthorityEncodedTranscriptEntryV1 => {
    const entry = byReference.get(reference);
    if (entry === undefined) {
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
    return entry;
  };
  const chainInfo = (reference: "getblockchaininfo:before" | "getblockchaininfo:after") => {
    const result = hsdResultRecord(
      decodeHsdTranscriptRpcResult(requiredEntry(reference), "getblockchaininfo", []),
    );
    if (
      result.chain !== HNS_AUTHORITY_SUCCESSOR_CHAIN_NETWORK ||
      result.blocks !== evidence.chain_anchor_height ||
      result.headers !== evidence.chain_anchor_height ||
      result.bestblockhash !== evidence.chain_anchor_block_hash ||
      result.mediantime !== evidence.chain_anchor_median_time ||
      typeof result.verificationprogress !== "number" ||
      !Number.isFinite(result.verificationprogress) ||
      result.verificationprogress < 0.999_999 ||
      result.verificationprogress > 1
    ) {
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
  };
  const tipHeader = (
    reference: "getblockheader:tip-before" | "getblockheader:tip-after",
  ): Readonly<{ time: number; confirmations: number }> => {
    const result = hsdResultRecord(
      decodeHsdTranscriptRpcResult(requiredEntry(reference), "getblockheader", [
        evidence.chain_anchor_block_hash,
        true,
      ]),
    );
    if (
      result.hash !== evidence.chain_anchor_block_hash ||
      result.height !== evidence.chain_anchor_height ||
      result.mediantime !== evidence.chain_anchor_median_time ||
      !safeRpcInteger(result.time) ||
      !safeRpcInteger(result.confirmations) ||
      result.confirmations < 1
    ) {
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
    return { time: result.time, confirmations: result.confirmations };
  };
  chainInfo("getblockchaininfo:before");
  const beforeHeader = tipHeader("getblockheader:tip-before");
  const genesis = hsdResultRecord(
    decodeHsdTranscriptRpcResult(requiredEntry("getblockheader:genesis"), "getblockheader", [
      HNS_MAINNET_GENESIS_BLOCK_HASH,
      true,
    ]),
  );
  if (genesis.hash !== HNS_MAINNET_GENESIS_BLOCK_HASH || genesis.height !== 0) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  const nameInfo = hsdResultRecord(
    decodeHsdTranscriptRpcResult(requiredEntry(`getnameinfo:${rootLabel}`), "getnameinfo", [
      rootLabel,
      false,
    ]),
  );
  const info = hsdResultRecord(nameInfo.info);
  const stats = hsdResultRecord(info.stats);
  if (
    info.state !== "CLOSED" ||
    info.registered !== true ||
    info.expired !== false ||
    stats.renewalPeriodEnd !== evidence.expiry_height ||
    stats.blocksUntilExpire !== evidence.expiry_height - evidence.chain_anchor_height
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  chainInfo("getblockchaininfo:after");
  const afterHeader = tipHeader("getblockheader:tip-after");
  if (
    beforeHeader.time !== afterHeader.time ||
    beforeHeader.confirmations !== afterHeader.confirmations
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
}

function sameChainAuthorityRecords(
  left: ReadonlyArray<HnsChainAuthorityRecord>,
  right: ReadonlyArray<HnsChainAuthorityRecord>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireDetachedTranscriptSemantics(
  evidence: HnsAuthorityDetachedObserverEvidenceV1,
  input: Readonly<{
    root_label: string;
    expected_txt_value: string;
    chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
    expected_authority_addresses: readonly [string, string];
    authority_address_provenance: HnsAuthorityAddressProvenanceV1;
  }>,
): void {
  const identities = new Set<string>();
  const childVantages = new Set<string>();
  const parentVantages = new Set(
    input.authority_address_provenance.source_kind === "detached_parent_authority_attestation_v1"
      ? input.authority_address_provenance.views.map((view) => view.vantage_reference)
      : [],
  );
  const parentZone =
    input.authority_address_provenance.source_kind === "detached_parent_authority_attestation_v1"
      ? input.authority_address_provenance.parent_zone
      : undefined;
  requireDetachedChainAnchorSemantics(evidence, input.root_label, parentZone);
  for (const entry of evidence.detached_transcript) {
    const identity = JSON.stringify([
      entry.exchange_kind,
      entry.vantage_reference,
      entry.subject_reference,
      entry.query_reference,
    ]);
    if (identities.has(identity)) {
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
    identities.add(identity);
    if (entry.exchange_kind === "hns_rpc") {
      if (!entry.query_reference.startsWith("getnameresource:")) continue;
      if (
        (entry.subject_reference !== input.root_label && entry.subject_reference !== parentZone) ||
        entry.query_reference !== `getnameresource:${entry.subject_reference}`
      ) {
        throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
      }
      const transcriptResource = decodeHsdTranscriptAuthorityRecords(entry);
      const expectedRecords =
        entry.subject_reference === input.root_label
          ? input.chain_authority_records
          : input.authority_address_provenance.source_kind ===
              "detached_parent_authority_attestation_v1"
            ? input.authority_address_provenance.parent_chain_authority_records
            : [];
      if (
        !sameChainAuthorityRecords(transcriptResource.authority_records, expectedRecords) ||
        (entry.subject_reference === input.root_label &&
          (transcriptResource.txt_values.length !== 1 ||
            transcriptResource.txt_values[0] !== input.expected_txt_value))
      ) {
        throw new HnsAuthorityEmitRefusal(
          entry.subject_reference === input.root_label
            ? "observer_evidence_mismatch"
            : "parent_chain_anchor_mismatch",
        );
      }
    } else if (entry.exchange_kind === "child_authority_dns") {
      if (!input.expected_authority_addresses.includes(entry.subject_reference)) {
        throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
      }
      childVantages.add(entry.vantage_reference);
    } else if (
      input.authority_address_provenance.source_kind !==
        "detached_parent_authority_attestation_v1" ||
      entry.subject_reference !== input.authority_address_provenance.parent_zone ||
      !parentVantages.has(entry.vantage_reference)
    ) {
      throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
    }
  }
  if (
    !evidence.detached_transcript.some(
      (entry) => entry.exchange_kind === "hns_rpc" && entry.subject_reference === input.root_label,
    ) ||
    (parentZone !== undefined &&
      !evidence.detached_transcript.some(
        (entry) => entry.exchange_kind === "hns_rpc" && entry.subject_reference === parentZone,
      )) ||
    childVantages.size !== input.expected_authority_addresses.length ||
    input.expected_authority_addresses.some(
      (address) =>
        !evidence.detached_transcript.some(
          (entry) =>
            entry.exchange_kind === "child_authority_dns" && entry.subject_reference === address,
        ),
    ) ||
    [...parentVantages].some(
      (vantage) =>
        !evidence.detached_transcript.some(
          (entry) =>
            entry.exchange_kind === "parent_authority_dns" && entry.vantage_reference === vantage,
        ),
    )
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
}

async function canonicalAuthorityAddressProvenance(
  provenance: HnsAuthorityAddressProvenanceV1,
  chain: Readonly<{ chain_network: string; chain_genesis_block_hash: string }>,
): Promise<HnsAuthorityAddressProvenanceV1> {
  if (provenance?.source_kind === "chain_glue_v1") return { source_kind: "chain_glue_v1" };
  if (
    provenance?.source_kind !== "detached_parent_authority_attestation_v1" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(provenance.parent_zone) ||
    !/^[0-9a-f]{64}$/u.test(provenance.parent_chain_authority_digest) ||
    !Array.isArray(provenance.parent_chain_authority_records) ||
    !Array.isArray(provenance.views) ||
    provenance.views.length !== 2
  ) {
    throw new HnsAuthorityEmitRefusal("parent_chain_anchor_mismatch");
  }
  let parentChainAuthorityRecords: ReadonlyArray<HnsChainAuthorityRecord>;
  let parentChainAuthorityDigest: string;
  try {
    parentChainAuthorityRecords = hnsChainAuthorityRecords(
      "owner_authoritative_dns_txt",
      provenance.parent_chain_authority_records,
    );
    parentChainAuthorityDigest = await hnsChainAuthorityDigest({
      chain_network: chain.chain_network,
      chain_genesis_block_hash: chain.chain_genesis_block_hash,
      root_label: provenance.parent_zone,
      ownership_source: "owner_authoritative_dns_txt",
      authority_records: parentChainAuthorityRecords,
    });
  } catch {
    throw new HnsAuthorityEmitRefusal("parent_chain_anchor_mismatch");
  }
  if (parentChainAuthorityDigest !== provenance.parent_chain_authority_digest) {
    throw new HnsAuthorityEmitRefusal("parent_chain_anchor_mismatch");
  }
  return {
    source_kind: "detached_parent_authority_attestation_v1",
    parent_zone: provenance.parent_zone,
    parent_chain_authority_digest: parentChainAuthorityDigest,
    parent_chain_authority_records: parentChainAuthorityRecords,
    views: provenance.views,
  };
}

/** Produces one complete canonical review package or refuses without output. */
export async function prepareHnsAuthoritySuccessorCandidateV1(
  input: Readonly<{
    source_commit: string;
    root_label: string;
    observed_at: string;
    chain_height: number;
    chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
    authority_address_provenance: HnsAuthorityAddressProvenanceV1;
    generation_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
    expected_authority_addresses: readonly [string, string];
    authority_views: ReadonlyArray<HnsAuthorityEmitViewV1>;
    artifacts: Readonly<Record<HnsAuthorityCandidateArtifactName, Uint8Array>>;
  }>,
): Promise<
  Readonly<{
    candidate: HnsAuthoritySuccessorCandidateV1;
    candidate_bytes: Uint8Array;
    candidate_sha256: string;
  }>
> {
  if (
    !/^[0-9a-f]{40}$/u.test(input.source_commit) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(input.root_label) ||
    !Number.isSafeInteger(input.chain_height) ||
    input.chain_height <= 0 ||
    !Number.isFinite(Date.parse(input.observed_at)) ||
    new Date(Date.parse(input.observed_at)).toISOString() !== input.observed_at
  ) {
    throw new HnsAuthorityEmitRefusal("candidate_metadata_invalid");
  }
  const artifactNames = [
    "authority_inventory",
    "dns_zone_activation",
    "app_host_activation",
    "health_observation",
    "observer_evidence",
  ] as const;
  if (artifactNames.some((name) => input.artifacts[name].byteLength === 0)) {
    throw new HnsAuthorityEmitRefusal("incomplete_candidate_artifacts");
  }
  const inventory = await decodeHnsAuthorityInventoryBytes(input.artifacts.authority_inventory);
  const canonicalInventory = await encodeHnsAuthorityInventory(inventory.inventory);
  const dnsZoneActivation = await decodeHnsDnsZonePersistenceDocumentV1(
    input.artifacts.dns_zone_activation,
  );
  const canonicalDnsZoneActivation = encodeHnsDnsZonePersistenceDocumentV1(dnsZoneActivation);
  const appHostTransition = decodeHnsAppHostTransitionDocumentV1(
    input.artifacts.app_host_activation,
  );
  const canonicalAppHostTransition = encodeHnsAppHostTransitionDocumentV1(appHostTransition);
  const healthObservation = decodeHnsDnsHealthDocumentV1(input.artifacts.health_observation);
  const canonicalHealthObservation = encodeHnsDnsHealthDocumentV1(healthObservation);
  let observation: HnsAuthorityDetachedObserverEvidenceV1;
  try {
    observation = await decodeHnsAuthorityDetachedObserverEvidenceV1(
      input.artifacts.observer_evidence,
    );
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_not_verified");
  }
  if (
    observation.root_label !== input.root_label ||
    observation.chain_anchor_height !== input.chain_height ||
    observation.chain_network !== HNS_AUTHORITY_SUCCESSOR_CHAIN_NETWORK ||
    observation.chain_genesis_block_hash !== HNS_MAINNET_GENESIS_BLOCK_HASH ||
    observation.ownership_source !== "owner_authoritative_dns_txt"
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  let chainAuthorityRecords: ReadonlyArray<HnsChainAuthorityRecord>;
  let chainAuthorityDigest: string;
  try {
    chainAuthorityRecords = hnsChainAuthorityRecords(
      observation.ownership_source,
      input.chain_authority_records,
    );
    chainAuthorityDigest = await hnsChainAuthorityDigest({
      chain_network: observation.chain_network,
      chain_genesis_block_hash: observation.chain_genesis_block_hash,
      root_label: observation.root_label,
      ownership_source: observation.ownership_source,
      authority_records: chainAuthorityRecords,
    });
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  if (chainAuthorityDigest !== observation.chain_authority_digest) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  const authorityAddressProvenance = await canonicalAuthorityAddressProvenance(
    input.authority_address_provenance,
    {
      chain_network: observation.chain_network,
      chain_genesis_block_hash: observation.chain_genesis_block_hash,
    },
  );
  const chainDs = chainAuthorityRecords
    .filter(
      (record): record is readonly ["DS", number, number, number, string] => record[0] === "DS",
    )
    .map(([, keyTag, algorithm, digestType, digest]) => [
      keyTag,
      algorithm,
      digestType,
      digest,
    ]) as ReadonlyArray<HnsAuthorityEmitDsV1>;
  const views = requireHnsAuthorityEmitObservationV1({
    expected_authority_addresses: input.expected_authority_addresses,
    views: input.authority_views,
    chain_ds: chainDs,
  });
  const canonicalObservation = canonicalDocumentBytes(observation);
  if (
    !equalBytes(canonicalInventory, input.artifacts.authority_inventory) ||
    !equalBytes(canonicalDnsZoneActivation, input.artifacts.dns_zone_activation) ||
    !equalBytes(canonicalAppHostTransition, input.artifacts.app_host_activation) ||
    !equalBytes(canonicalHealthObservation, input.artifacts.health_observation) ||
    !equalBytes(canonicalObservation, input.artifacts.observer_evidence)
  ) {
    throw new HnsAuthorityEmitRefusal("noncanonical_candidate_artifact");
  }
  const generations = deriveHnsAuthoritySuccessorGenerationsV1(input.generation_snapshot);
  requireHnsAuthorityCandidateArtifactSemanticsV1({
    root_label: input.root_label,
    observed_at: input.observed_at,
    chain_authority_digest: chainAuthorityDigest,
    chain_authority_records: chainAuthorityRecords,
    authority_address_provenance: authorityAddressProvenance,
    generation_snapshot: input.generation_snapshot,
    generations,
    expected_authority_addresses: input.expected_authority_addresses,
    views,
    inventory,
    dns_zone_activation: dnsZoneActivation,
    app_host_transition: appHostTransition,
    health_observation: healthObservation,
    observer_evidence: observation,
  });
  requireDetachedTranscriptSemantics(observation, {
    root_label: input.root_label,
    expected_txt_value: observation.expected_txt_value,
    chain_authority_records: chainAuthorityRecords,
    expected_authority_addresses: input.expected_authority_addresses,
    authority_address_provenance: authorityAddressProvenance,
  });
  const artifacts = await Promise.all(
    artifactNames.map(async (name) => {
      const bytes = new Uint8Array(input.artifacts[name]);
      return { name, sha256: await sha256Hex(bytes), bytes_hex: hex(bytes) } as const;
    }),
  );
  const candidate: HnsAuthoritySuccessorCandidateV1 = {
    version: HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION,
    source_commit: input.source_commit,
    root_label: input.root_label,
    observed_at: input.observed_at,
    chain_height: input.chain_height,
    chain_network: observation.chain_network,
    chain_genesis_block_hash: observation.chain_genesis_block_hash,
    chain_authority_digest: chainAuthorityDigest,
    chain_authority_records: chainAuthorityRecords,
    authority_address_provenance: authorityAddressProvenance,
    generations,
    dnskey_key_tag: views[0].dnskey_key_tag as number,
    authority_views: views,
    chain_ds: chainDs,
    artifacts,
  };
  const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate));
  return {
    candidate,
    candidate_bytes: candidateBytes,
    candidate_sha256: await sha256Hex(candidateBytes),
  };
}

function requireHnsAuthorityCandidateArtifactSemanticsV1(
  input: Readonly<{
    root_label: string;
    observed_at: string;
    chain_authority_digest: string;
    chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
    authority_address_provenance: HnsAuthorityAddressProvenanceV1;
    generation_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
    generations: HnsAuthoritySuccessorGenerationsV1;
    expected_authority_addresses: readonly [string, string];
    views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
    inventory: Awaited<ReturnType<typeof decodeHnsAuthorityInventoryBytes>>;
    dns_zone_activation: HnsDnsZoneActivationDocumentV1;
    app_host_transition: HnsCommunityAppHostStatusChangeInputV1;
    health_observation: HnsDnsZoneHealthInputV1;
    observer_evidence: Readonly<{
      status: "verified";
      environment: string;
      chain_anchor_median_time: number;
    }>;
  }>,
): void {
  const inventory = input.inventory.inventory;
  const dns = input.dns_zone_activation;
  const app = input.app_host_transition;
  const health = input.health_observation;
  const activeAuthorityEndpoints = inventory.authoritative_nameserver_glue.filter(
    (entry) => entry.active,
  );
  const activeAuthorityAddresses = new Set(
    activeAuthorityEndpoints.map((entry) => entry.authority_address),
  );
  const activeAuthorityNameservers = new Set(
    activeAuthorityEndpoints.map((entry) => entry.authority_nameserver),
  );
  const chainNameservers = new Set(
    input.chain_authority_records.flatMap((record) => (record[0] === "NS" ? [record[1]] : [])),
  );
  const chainGlue = new Set(
    input.chain_authority_records.flatMap((record) =>
      record[0] === "GLUE4" || record[0] === "GLUE6"
        ? [JSON.stringify([record[1], record[0], record[2]])]
        : [],
    ),
  );
  const chainDelegationIsInBailiwick = [...chainNameservers].every((nameserver) =>
    nameserver.endsWith(`.${input.root_label}`),
  );
  const chainDelegationIsOutOfBailiwick = [...chainNameservers].every(
    (nameserver) => nameserver !== input.root_label && !nameserver.endsWith(`.${input.root_label}`),
  );
  const expectedAuthorityAddresses = new Set(input.expected_authority_addresses);
  // jazleeuw delegates to out-of-bailiwick ns1.pirate and ns2.pirate. Its
  // Handshake resource attests only those NS names; it correctly carries no
  // address glue. Address authority instead comes from the exact reviewed
  // inventory bytes, the pirate chain transcript, and two explicitly labelled
  // operator attestations. A concrete adapter must perform actual DNSSEC
  // validation before it is permitted to make those attestations.
  // Chain records have already passed canonical DNS-name decoding, so neither
  // the digest nor this comparison admits presentation-only trailing dots.
  const provenance = input.authority_address_provenance;
  if (provenance === null || typeof provenance !== "object") {
    throw new HnsAuthorityEmitRefusal("artifact_semantics_mismatch");
  }
  const expectedParentZone = [...chainNameservers]
    .map((nameserver) => nameserver.split(".").at(-1))
    .find((parentZone) => parentZone !== undefined);
  const parentViews =
    provenance.source_kind === "detached_parent_authority_attestation_v1" ? provenance.views : [];
  const parentChainRecords =
    provenance.source_kind === "detached_parent_authority_attestation_v1"
      ? provenance.parent_chain_authority_records
      : [];
  const parentChainNameservers = new Set(
    parentChainRecords.flatMap((record) => (record[0] === "NS" ? [record[1]] : [])),
  );
  const parentChainGlue = new Set(
    parentChainRecords.flatMap((record) =>
      record[0] === "GLUE4" || record[0] === "GLUE6"
        ? [JSON.stringify([record[1], record[0], record[2]])]
        : [],
    ),
  );
  const parentChainDs = parentChainRecords
    .filter(
      (record): record is readonly ["DS", number, number, number, string] => record[0] === "DS",
    )
    .map(([, keyTag, algorithm, digestType, digest]) => [
      keyTag,
      algorithm,
      digestType,
      digest,
    ]) as ReadonlyArray<HnsAuthorityEmitDsV1>;
  const canonicalParentRecords = activeAuthorityEndpoints.map(
    (entry) =>
      [
        entry.authority_address_family === "GLUE4" ? "A" : "AAAA",
        entry.authority_nameserver,
        entry.authority_address,
      ] as HnsAuthorityAddressRecordV1,
  );
  if (chainDelegationIsOutOfBailiwick) {
    if (
      provenance.source_kind !== "detached_parent_authority_attestation_v1" ||
      provenance.parent_zone !== expectedParentZone ||
      ![...chainNameservers].every((nameserver) =>
        nameserver.endsWith(`.${provenance.parent_zone}`),
      )
    ) {
      throw new HnsAuthorityEmitRefusal("parent_delegation_mismatch");
    }
    if (
      parentChainNameservers.size !== activeAuthorityNameservers.size ||
      ![...activeAuthorityNameservers].every((nameserver) =>
        parentChainNameservers.has(nameserver),
      ) ||
      parentChainGlue.size !== activeAuthorityEndpoints.length ||
      !activeAuthorityEndpoints.every((entry) =>
        parentChainGlue.has(
          JSON.stringify([
            entry.authority_nameserver,
            entry.authority_address_family,
            entry.authority_address,
          ]),
        ),
      )
    ) {
      throw new HnsAuthorityEmitRefusal("parent_address_mismatch");
    }
    if (
      parentViews.length !== 2 ||
      new Set(parentViews.map((view) => view.view_id)).size !== parentViews.length ||
      new Set(parentViews.map((view) => view.vantage_reference)).size !== parentViews.length ||
      parentViews.some(
        (view) =>
          !/^[a-z][a-z0-9-]{0,63}$/u.test(view.view_id) ||
          !/^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(view.vantage_reference),
      )
    ) {
      throw new HnsAuthorityEmitRefusal("parent_view_identity_mismatch");
    }
    if (parentViews.some((view) => view.outcome !== "observed")) {
      throw new HnsAuthorityEmitRefusal("parent_view_unavailable");
    }
    if (
      parentViews.some(
        (view) =>
          view.validation_attestation !== "operator_attested_dnssec_secure" ||
          view.attested_dnskey_key_tag === null ||
          !Array.isArray(view.attested_derived_ds) ||
          !sameDs(view.attested_derived_ds, parentChainDs) ||
          !validDsForKeyTag(parentChainDs, view.attested_dnskey_key_tag),
      )
    ) {
      throw new HnsAuthorityEmitRefusal("parent_view_attestation_mismatch");
    }
    if (
      parentViews.some((view) => {
        if (!Array.isArray(view.records)) return true;
        const records = new Set(view.records.map((record) => JSON.stringify(record)));
        return (
          view.records.length !== canonicalParentRecords.length ||
          records.size !== canonicalParentRecords.length ||
          !canonicalParentRecords.every((record) => records.has(JSON.stringify(record)))
        );
      })
    ) {
      throw new HnsAuthorityEmitRefusal("parent_address_mismatch");
    }
  }
  const chainAddressBindingMatchesInventory = chainDelegationIsOutOfBailiwick
    ? chainGlue.size === 0
    : chainDelegationIsInBailiwick &&
      provenance.source_kind === "chain_glue_v1" &&
      chainGlue.size === activeAuthorityEndpoints.length &&
      activeAuthorityEndpoints.every((entry) =>
        chainGlue.has(
          JSON.stringify([
            entry.authority_nameserver,
            entry.authority_address_family,
            entry.authority_address,
          ]),
        ),
      );
  const chainAuthorityMatchesInventory =
    expectedAuthorityAddresses.size === input.expected_authority_addresses.length &&
    activeAuthorityEndpoints.length === input.expected_authority_addresses.length &&
    activeAuthorityNameservers.size === activeAuthorityEndpoints.length &&
    chainNameservers.size === activeAuthorityNameservers.size &&
    chainAddressBindingMatchesInventory &&
    activeAuthorityEndpoints.every(
      (entry) =>
        expectedAuthorityAddresses.has(entry.authority_address) &&
        chainNameservers.has(entry.authority_nameserver),
    );
  const inventoryCoversRoot = inventory.dns_write_capabilities.some(
    (entry) =>
      entry.active && entry.scope_kind === "exact_root" && entry.root_label === input.root_label,
  );
  const observedAt = Date.parse(input.observed_at);
  const anchorMedianTime = input.observer_evidence.chain_anchor_median_time * 1_000;
  const inventoryIsCurrent =
    Date.parse(inventory.published_at) <= observedAt &&
    observedAt < Date.parse(inventory.expires_at);
  const observedDnsKeyTag = input.views[0].dnskey_key_tag;
  const healthChecksPassed =
    health.delegation_matches &&
    health.ds_authenticates_zone &&
    health.retained_zone_digest_matches &&
    health.gateway_healthy;

  if (
    !inventoryCoversRoot ||
    !inventoryIsCurrent ||
    !Number.isSafeInteger(input.observer_evidence.chain_anchor_median_time) ||
    input.observer_evidence.chain_anchor_median_time < 0 ||
    observedAt < anchorMedianTime ||
    inventory.environment !== input.observer_evidence.environment ||
    !chainAuthorityMatchesInventory ||
    input.expected_authority_addresses.some((address) => !activeAuthorityAddresses.has(address)) ||
    dns.canonical_root !== input.root_label ||
    dns.dns_zone_activation_id !== input.generation_snapshot.dns_zone_activation_id ||
    dns.pirate_dns_authority_inventory_reference !== inventory.authority_inventory_reference ||
    dns.pirate_dns_authority_inventory_version !== inventory.authority_inventory_version ||
    dns.pirate_dns_authority_inventory_digest !== input.inventory.inventory_digest ||
    dns.dns_authority_generation !== input.generations.dns_activation_generation ||
    dns.zone_revision !== input.generations.dns_activation_generation ||
    observedDnsKeyTag === null ||
    dns.dnssec_keyset_version !== `key-tag-${observedDnsKeyTag}` ||
    input.views.some(
      (view) =>
        view.zone_bytes_digest !== dns.zone_bytes_digest ||
        view.dnskey_key_tag !== observedDnsKeyTag,
    ) ||
    app.expected_activation_generation !== input.generation_snapshot.app_host_current_generation ||
    app.app_host_activation_id !== input.generation_snapshot.app_host_activation_id ||
    app.expected_activation_generation + 1 !== input.generations.app_host_activation_generation ||
    app.target_status !== "active" ||
    health.dns_zone_activation_id !== dns.dns_zone_activation_id ||
    health.activation_generation !== input.generations.dns_activation_generation ||
    health.expected_health_generation !==
      input.generation_snapshot.successor_dns_latest_health_generation ||
    health.expected_health_generation + 1 !== input.generations.health_generation ||
    health.stable_chain_delegation_snapshot_reference !==
      dns.stable_chain_delegation_snapshot_reference ||
    health.stable_chain_delegation_snapshot_digest !==
      dns.stable_chain_delegation_snapshot_digest ||
    dns.stable_chain_delegation_snapshot_digest !== input.chain_authority_digest ||
    health.observed_zone_bytes_digest !== dns.zone_bytes_digest ||
    health.observed_dnssec_keyset_reference !== dns.dnssec_keyset_reference ||
    health.observed_dnssec_keyset_version !== dns.dnssec_keyset_version ||
    health.observed_gateway_deployment_reference !== dns.gateway_deployment_reference ||
    health.observed_gateway_certificate_spki_sha256 !== dns.gateway_certificate_spki_sha256 ||
    !healthChecksPassed
  ) {
    throw new HnsAuthorityEmitRefusal("artifact_semantics_mismatch");
  }
}

export class HnsAuthorityCandidateCommitRefusal extends Error {
  readonly name = "HnsAuthorityCandidateCommitRefusal";
  constructor(readonly reason: "generation_fence_changed" | "candidate_bytes_mismatch") {
    super(`HNS authority candidate commit refused: ${reason}`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * Final reversible gate before the fenced append-only transaction. The caller
 * must supply a freshly read snapshot and freshly recomputed candidate bytes.
 */
export function requireReviewedHnsAuthorityCandidateV1(
  input: Readonly<{
    emitted_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
    current_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
    reviewed_candidate_bytes: Uint8Array;
    recomputed_candidate_bytes: Uint8Array;
  }>,
): void {
  const emitted = input.emitted_snapshot;
  const current = input.current_snapshot;
  if (
    emitted.dns_current_generation !== current.dns_current_generation ||
    emitted.dns_zone_activation_id !== current.dns_zone_activation_id ||
    emitted.app_host_current_generation !== current.app_host_current_generation ||
    emitted.app_host_activation_id !== current.app_host_activation_id ||
    emitted.successor_dns_latest_health_generation !==
      current.successor_dns_latest_health_generation
  ) {
    throw new HnsAuthorityCandidateCommitRefusal("generation_fence_changed");
  }
  if (!equalBytes(input.reviewed_candidate_bytes, input.recomputed_candidate_bytes)) {
    throw new HnsAuthorityCandidateCommitRefusal("candidate_bytes_mismatch");
  }
}

function sameDs(
  left: ReadonlyArray<HnsAuthorityEmitDsV1>,
  right: ReadonlyArray<HnsAuthorityEmitDsV1>,
) {
  return JSON.stringify(canonicalDs(left)) === JSON.stringify(canonicalDs(right));
}

function canonicalDs(
  records: ReadonlyArray<HnsAuthorityEmitDsV1>,
): ReadonlyArray<HnsAuthorityEmitDsV1> {
  return [...records].sort((first, second) => {
    const encodedFirst = JSON.stringify(first);
    const encodedSecond = JSON.stringify(second);
    return encodedFirst < encodedSecond ? -1 : encodedFirst > encodedSecond ? 1 : 0;
  });
}

function validDsForKeyTag(records: ReadonlyArray<HnsAuthorityEmitDsV1>, keyTag: number): boolean {
  const digestTypes = new Set<number>();
  return (
    records.length > 0 &&
    records.every(([recordKeyTag, algorithm, digestType, digest]) => {
      if (digestTypes.has(digestType)) return false;
      digestTypes.add(digestType);
      return (
        recordKeyTag === keyTag &&
        algorithm === 13 &&
        (digestType === 2
          ? /^[0-9a-f]{64}$/u.test(digest)
          : digestType === 4 && /^[0-9a-f]{96}$/u.test(digest))
      );
    })
  );
}

/** Requires two complete, internally consistent operator-attested authority views. */
export function requireHnsAuthorityEmitObservationV1(
  input: Readonly<{
    expected_authority_addresses: readonly [string, string];
    views: ReadonlyArray<HnsAuthorityEmitViewV1>;
    chain_ds: ReadonlyArray<HnsAuthorityEmitDsV1>;
  }>,
): readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1] {
  const [firstAddress, secondAddress] = input.expected_authority_addresses;
  if (
    input.views.some(
      (view) =>
        !hasExactKeys(view, [
          "attestation_kind",
          "authority_address",
          "outcome",
          "zone_bytes_digest",
          "dnskey_key_tag",
          "derived_ds",
        ]) || view.attestation_kind !== "operator_attested_authority_view_v1",
    )
  ) {
    throw new HnsAuthorityEmitRefusal("authority_view_mismatch");
  }
  if (
    firstAddress === secondAddress ||
    input.views.length !== 2 ||
    new Set(input.views.map((view) => view.authority_address)).size !== 2
  ) {
    throw new HnsAuthorityEmitRefusal("incomplete_authority_views");
  }
  const first = input.views.find((view) => view.authority_address === firstAddress);
  const second = input.views.find((view) => view.authority_address === secondAddress);
  if (first === undefined || second === undefined) {
    throw new HnsAuthorityEmitRefusal("incomplete_authority_views");
  }
  if (first.outcome !== "observed" || second.outcome !== "observed") {
    throw new HnsAuthorityEmitRefusal("unavailable_authority_view");
  }
  if (
    first.zone_bytes_digest === null ||
    first.dnskey_key_tag === null ||
    first.derived_ds === null ||
    second.zone_bytes_digest === null ||
    second.dnskey_key_tag === null ||
    second.derived_ds === null ||
    first.zone_bytes_digest !== second.zone_bytes_digest ||
    first.dnskey_key_tag !== second.dnskey_key_tag ||
    !sameDs(first.derived_ds, second.derived_ds)
  ) {
    throw new HnsAuthorityEmitRefusal("authority_view_mismatch");
  }
  if (!sameDs(first.derived_ds, input.chain_ds)) {
    throw new HnsAuthorityEmitRefusal("dnskey_ds_mismatch");
  }
  if (
    !validDsForKeyTag(first.derived_ds, first.dnskey_key_tag) ||
    !validDsForKeyTag(input.chain_ds, first.dnskey_key_tag)
  ) {
    throw new HnsAuthorityEmitRefusal("dnskey_ds_mismatch");
  }
  const canonicalDerivedDs = canonicalDs(first.derived_ds);
  return [
    {
      attestation_kind: first.attestation_kind,
      authority_address: first.authority_address,
      outcome: first.outcome,
      zone_bytes_digest: first.zone_bytes_digest,
      dnskey_key_tag: first.dnskey_key_tag,
      derived_ds: canonicalDerivedDs,
    },
    {
      attestation_kind: second.attestation_kind,
      authority_address: second.authority_address,
      outcome: second.outcome,
      zone_bytes_digest: second.zone_bytes_digest,
      dnskey_key_tag: second.dnskey_key_tag,
      derived_ds: canonicalDerivedDs,
    },
  ];
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a nonnegative incrementable safe integer`);
  }
  return value;
}

/**
 * Predicts the exact generations that the fenced persistence functions will
 * derive from a read-only snapshot. This function never reserves or writes.
 */
export function deriveHnsAuthoritySuccessorGenerationsV1(
  snapshot: HnsAuthoritySuccessorGenerationSnapshotV1,
): HnsAuthoritySuccessorGenerationsV1 {
  return {
    dns_activation_generation:
      nonnegativeSafeInteger(snapshot.dns_current_generation, "DNS current generation") + 1,
    app_host_activation_generation:
      nonnegativeSafeInteger(snapshot.app_host_current_generation, "app-host current generation") +
      1,
    health_generation:
      nonnegativeSafeInteger(
        snapshot.successor_dns_latest_health_generation,
        "successor DNS latest health generation",
      ) + 1,
  };
}

export type HnsDnsZoneActivationDocumentPayloadV1 = Readonly<{
  version: typeof HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION;
  dns_zone_activation_id: string;
  canonical_root: string;
  dns_authority: readonly ["pirate_managed_dns_v1", string, number];
  pirate_dns_authority_inventory: readonly [string, string, string];
  zone: readonly [number, string];
  dnssec_keyset: readonly [string, string];
  gateway: readonly [string, string];
  stable_chain_delegation_snapshot: readonly [string, string];
}>;

export function encodeHnsDnsZoneActivationDocumentV1(
  payload: HnsDnsZoneActivationDocumentPayloadV1,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds the exact document consumed by both emit-only review and persistence. */
export async function prepareHnsDnsZoneActivationDocumentV1(
  input: Readonly<{
    payload: Omit<HnsDnsZoneActivationDocumentPayloadV1, "zone"> & {
      zone_revision: number;
    };
    zone_bytes: Uint8Array;
  }>,
): Promise<HnsDnsZoneActivationDocumentV1> {
  const zoneBytes = new Uint8Array(input.zone_bytes);
  const zoneDigest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", zoneBytes)));
  const payload: HnsDnsZoneActivationDocumentPayloadV1 = {
    version: input.payload.version,
    dns_zone_activation_id: input.payload.dns_zone_activation_id,
    canonical_root: input.payload.canonical_root,
    dns_authority: input.payload.dns_authority,
    pirate_dns_authority_inventory: input.payload.pirate_dns_authority_inventory,
    zone: [input.payload.zone_revision, zoneDigest],
    dnssec_keyset: input.payload.dnssec_keyset,
    gateway: input.payload.gateway,
    stable_chain_delegation_snapshot: input.payload.stable_chain_delegation_snapshot,
  };
  return {
    activation_document_bytes: encodeHnsDnsZoneActivationDocumentV1(payload),
    dns_zone_activation_id: payload.dns_zone_activation_id,
    canonical_root: payload.canonical_root,
    dns_authority_kind: payload.dns_authority[0],
    dns_authority_reference: payload.dns_authority[1],
    dns_authority_generation: payload.dns_authority[2],
    pirate_dns_authority_inventory_reference: payload.pirate_dns_authority_inventory[0],
    pirate_dns_authority_inventory_version: payload.pirate_dns_authority_inventory[1],
    pirate_dns_authority_inventory_digest: payload.pirate_dns_authority_inventory[2],
    zone_revision: payload.zone[0],
    zone_bytes: zoneBytes,
    zone_bytes_digest: payload.zone[1],
    dnssec_keyset_reference: payload.dnssec_keyset[0],
    dnssec_keyset_version: payload.dnssec_keyset[1],
    gateway_deployment_reference: payload.gateway[0],
    gateway_certificate_spki_sha256: payload.gateway[1],
    stable_chain_delegation_snapshot_reference: payload.stable_chain_delegation_snapshot[0],
    stable_chain_delegation_snapshot_digest: payload.stable_chain_delegation_snapshot[1],
  };
}

export type HnsDnsZoneActivationDocumentV1 = Readonly<{
  activation_document_bytes: Uint8Array;
  dns_zone_activation_id: string;
  canonical_root: string;
  dns_authority_kind: "pirate_managed_dns_v1";
  dns_authority_reference: string;
  dns_authority_generation: number;
  pirate_dns_authority_inventory_reference: string;
  pirate_dns_authority_inventory_version: string;
  pirate_dns_authority_inventory_digest: string;
  zone_revision: number;
  zone_bytes: Uint8Array;
  zone_bytes_digest: string;
  dnssec_keyset_reference: string;
  dnssec_keyset_version: string;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  stable_chain_delegation_snapshot_reference: string;
  stable_chain_delegation_snapshot_digest: string;
}>;

type HnsDnsZonePersistenceDocumentPayloadV1 = Readonly<{
  version: typeof HNS_DNS_ZONE_PERSISTENCE_DOCUMENT_VERSION;
  activation_document_bytes_hex: string;
  dns_zone_activation_id: string;
  canonical_root: string;
  dns_authority_kind: "pirate_managed_dns_v1";
  dns_authority_reference: string;
  dns_authority_generation: number;
  pirate_dns_authority_inventory_reference: string;
  pirate_dns_authority_inventory_version: string;
  pirate_dns_authority_inventory_digest: string;
  zone_revision: number;
  zone_bytes_hex: string;
  zone_bytes_digest: string;
  dnssec_keyset_reference: string;
  dnssec_keyset_version: string;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  stable_chain_delegation_snapshot_reference: string;
  stable_chain_delegation_snapshot_digest: string;
}>;

function bytesFromHex(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) {
    throw new TypeError("HNS persistence document byte field is invalid");
  }
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** Encodes every authority-controlled DNS finalization input into one review artifact. */
export function encodeHnsDnsZonePersistenceDocumentV1(
  document: HnsDnsZoneActivationDocumentV1,
): Uint8Array {
  return canonicalDocumentBytes({
    version: HNS_DNS_ZONE_PERSISTENCE_DOCUMENT_VERSION,
    activation_document_bytes_hex: hex(document.activation_document_bytes),
    dns_zone_activation_id: document.dns_zone_activation_id,
    canonical_root: document.canonical_root,
    dns_authority_kind: document.dns_authority_kind,
    dns_authority_reference: document.dns_authority_reference,
    dns_authority_generation: document.dns_authority_generation,
    pirate_dns_authority_inventory_reference: document.pirate_dns_authority_inventory_reference,
    pirate_dns_authority_inventory_version: document.pirate_dns_authority_inventory_version,
    pirate_dns_authority_inventory_digest: document.pirate_dns_authority_inventory_digest,
    zone_revision: document.zone_revision,
    zone_bytes_hex: hex(document.zone_bytes),
    zone_bytes_digest: document.zone_bytes_digest,
    dnssec_keyset_reference: document.dnssec_keyset_reference,
    dnssec_keyset_version: document.dnssec_keyset_version,
    gateway_deployment_reference: document.gateway_deployment_reference,
    gateway_certificate_spki_sha256: document.gateway_certificate_spki_sha256,
    stable_chain_delegation_snapshot_reference: document.stable_chain_delegation_snapshot_reference,
    stable_chain_delegation_snapshot_digest: document.stable_chain_delegation_snapshot_digest,
  } satisfies HnsDnsZonePersistenceDocumentPayloadV1);
}

/** Strictly decodes and internally revalidates a reviewed DNS finalization artifact. */
export async function decodeHnsDnsZonePersistenceDocumentV1(
  bytes: Uint8Array,
): Promise<HnsDnsZoneActivationDocumentV1> {
  const value = decodeCanonicalDocument(bytes);
  const keys = [
    "version",
    "activation_document_bytes_hex",
    "dns_zone_activation_id",
    "canonical_root",
    "dns_authority_kind",
    "dns_authority_reference",
    "dns_authority_generation",
    "pirate_dns_authority_inventory_reference",
    "pirate_dns_authority_inventory_version",
    "pirate_dns_authority_inventory_digest",
    "zone_revision",
    "zone_bytes_hex",
    "zone_bytes_digest",
    "dnssec_keyset_reference",
    "dnssec_keyset_version",
    "gateway_deployment_reference",
    "gateway_certificate_spki_sha256",
    "stable_chain_delegation_snapshot_reference",
    "stable_chain_delegation_snapshot_digest",
  ];
  if (!exactObject(value, keys) || value.version !== HNS_DNS_ZONE_PERSISTENCE_DOCUMENT_VERSION) {
    throw new TypeError("HNS DNS persistence document is invalid");
  }
  const payload = value as HnsDnsZonePersistenceDocumentPayloadV1;
  const activationBytes = bytesFromHex(payload.activation_document_bytes_hex);
  const zoneBytes = bytesFromHex(payload.zone_bytes_hex);
  const prepared = await prepareHnsDnsZoneActivationDocumentV1({
    payload: {
      version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
      dns_zone_activation_id: payload.dns_zone_activation_id,
      canonical_root: payload.canonical_root,
      dns_authority: [
        payload.dns_authority_kind,
        payload.dns_authority_reference,
        payload.dns_authority_generation,
      ],
      pirate_dns_authority_inventory: [
        payload.pirate_dns_authority_inventory_reference,
        payload.pirate_dns_authority_inventory_version,
        payload.pirate_dns_authority_inventory_digest,
      ],
      zone_revision: payload.zone_revision,
      dnssec_keyset: [payload.dnssec_keyset_reference, payload.dnssec_keyset_version],
      gateway: [payload.gateway_deployment_reference, payload.gateway_certificate_spki_sha256],
      stable_chain_delegation_snapshot: [
        payload.stable_chain_delegation_snapshot_reference,
        payload.stable_chain_delegation_snapshot_digest,
      ],
    },
    zone_bytes: zoneBytes,
  });
  if (
    !equalBytes(prepared.activation_document_bytes, activationBytes) ||
    prepared.zone_bytes_digest !== payload.zone_bytes_digest
  ) {
    throw new TypeError("HNS DNS persistence document is internally inconsistent");
  }
  return prepared;
}

export type HnsDnsZoneActivationReservationV1 = Readonly<{
  outcome: "reserved" | "replayed";
  operation_id: string;
  dns_zone_activation_id: string;
  fence_token: number;
  lease_expires_at: string;
  activation_generation: number | null;
}>;

export type HnsDnsZoneActivationOutcomeV1 = Readonly<{
  outcome: "activated" | "replayed";
  dns_zone_activation_id: string;
  activation_generation: number;
}>;

export type HnsLifecycleOutcomeV1 = Readonly<{
  outcome: "changed" | "replayed";
  activation_id: string;
  activation_generation: number;
  status: HnsDnsZoneActivationLifecycleStatusV1;
}>;

export type HnsDnsZoneHealthOutcomeV1 = Readonly<{
  outcome: "recorded" | "replayed";
  dns_zone_activation_id: string;
  activation_generation: number;
  health_generation: number;
}>;

export type HnsCommunityAppHostActivationOutcomeV1 = Readonly<{
  outcome: "activated" | "changed" | "replayed";
  app_host_activation_id: string;
  app_host_activation_generation: number;
  status: HnsDnsZoneActivationLifecycleStatusV1;
}>;

export const HNS_APP_HOST_TRANSITION_DOCUMENT_VERSION =
  "pirate-hns-app-host-transition-document-v1" as const;
export const HNS_DNS_HEALTH_DOCUMENT_VERSION = "pirate-hns-dns-health-document-v1" as const;

export type HnsCommunityAppHostStatusChangeInputV1 = Readonly<{
  operation_id: string;
  idempotency_key: string;
  request_hash: string;
  app_host_activation_id: string;
  expected_activation_generation: number;
  target_status: HnsDnsZoneActivationLifecycleStatusV1;
  reason_code: string;
}>;

export type HnsDnsZoneHealthInputV1 = Readonly<{
  operation_id: string;
  idempotency_key: string;
  request_hash: string;
  dns_zone_activation_id: string;
  activation_generation: number;
  expected_health_generation: number;
  stable_chain_delegation_snapshot_reference: string;
  stable_chain_delegation_snapshot_digest: string;
  observed_zone_bytes_digest: string;
  observed_dnssec_keyset_reference: string;
  observed_dnssec_keyset_version: string;
  observed_gateway_deployment_reference: string;
  observed_gateway_certificate_spki_sha256: string;
  delegation_matches: boolean;
  ds_authenticates_zone: boolean;
  retained_zone_digest_matches: boolean;
  gateway_healthy: boolean;
  valid_for_seconds: number;
}>;

function canonicalDocumentBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeCanonicalDocument(bytes: Uint8Array): unknown {
  const copy = new Uint8Array(bytes);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy));
  if (!equalBytes(copy, canonicalDocumentBytes(value)))
    throw new TypeError("HNS document is not canonical");
  return value;
}

function exactObject(
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function hasExactKeys(
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function encodeHnsAppHostTransitionDocumentV1(
  input: HnsCommunityAppHostStatusChangeInputV1,
): Uint8Array {
  return canonicalDocumentBytes({ version: HNS_APP_HOST_TRANSITION_DOCUMENT_VERSION, input });
}

export function decodeHnsAppHostTransitionDocumentV1(
  bytes: Uint8Array,
): HnsCommunityAppHostStatusChangeInputV1 {
  const document = decodeCanonicalDocument(bytes);
  const keys = [
    "operation_id",
    "idempotency_key",
    "request_hash",
    "app_host_activation_id",
    "expected_activation_generation",
    "target_status",
    "reason_code",
  ];
  if (
    !exactObject(document, ["version", "input"]) ||
    document.version !== HNS_APP_HOST_TRANSITION_DOCUMENT_VERSION ||
    !exactObject(document.input, keys)
  )
    throw new TypeError("HNS app-host transition document is invalid");
  const input = document.input;
  if (
    !validIdentity(input.operation_id) ||
    !validIdentity(input.idempotency_key) ||
    !validHash(input.request_hash) ||
    !validIdentity(input.app_host_activation_id) ||
    !Number.isSafeInteger(input.expected_activation_generation) ||
    (input.expected_activation_generation as number) < 0 ||
    (input.target_status !== "active" &&
      input.target_status !== "suspended" &&
      input.target_status !== "revoked") ||
    !validIdentity(input.reason_code)
  )
    throw new TypeError("HNS app-host transition input is invalid");
  return input as HnsCommunityAppHostStatusChangeInputV1;
}

export function encodeHnsDnsHealthDocumentV1(input: HnsDnsZoneHealthInputV1): Uint8Array {
  return canonicalDocumentBytes({ version: HNS_DNS_HEALTH_DOCUMENT_VERSION, input });
}

export function decodeHnsDnsHealthDocumentV1(bytes: Uint8Array): HnsDnsZoneHealthInputV1 {
  const document = decodeCanonicalDocument(bytes);
  const keys = [
    "operation_id",
    "idempotency_key",
    "request_hash",
    "dns_zone_activation_id",
    "activation_generation",
    "expected_health_generation",
    "stable_chain_delegation_snapshot_reference",
    "stable_chain_delegation_snapshot_digest",
    "observed_zone_bytes_digest",
    "observed_dnssec_keyset_reference",
    "observed_dnssec_keyset_version",
    "observed_gateway_deployment_reference",
    "observed_gateway_certificate_spki_sha256",
    "delegation_matches",
    "ds_authenticates_zone",
    "retained_zone_digest_matches",
    "gateway_healthy",
    "valid_for_seconds",
  ];
  if (
    !exactObject(document, ["version", "input"]) ||
    document.version !== HNS_DNS_HEALTH_DOCUMENT_VERSION ||
    !exactObject(document.input, keys)
  )
    throw new TypeError("HNS DNS health document is invalid");
  const input = document.input;
  if (
    !validIdentity(input.operation_id) ||
    !validIdentity(input.idempotency_key) ||
    !validHash(input.request_hash) ||
    !validIdentity(input.dns_zone_activation_id) ||
    !Number.isSafeInteger(input.activation_generation) ||
    (input.activation_generation as number) <= 0 ||
    !Number.isSafeInteger(input.expected_health_generation) ||
    (input.expected_health_generation as number) < 0 ||
    !validIdentity(input.stable_chain_delegation_snapshot_reference) ||
    !validHash(input.stable_chain_delegation_snapshot_digest) ||
    !validHash(input.observed_zone_bytes_digest) ||
    !validIdentity(input.observed_dnssec_keyset_reference) ||
    !validIdentity(input.observed_dnssec_keyset_version) ||
    !validIdentity(input.observed_gateway_deployment_reference) ||
    !validHash(input.observed_gateway_certificate_spki_sha256) ||
    typeof input.delegation_matches !== "boolean" ||
    typeof input.ds_authenticates_zone !== "boolean" ||
    typeof input.retained_zone_digest_matches !== "boolean" ||
    typeof input.gateway_healthy !== "boolean" ||
    !Number.isSafeInteger(input.valid_for_seconds) ||
    (input.valid_for_seconds as number) <= 0
  )
    throw new TypeError("HNS DNS health input is invalid");
  return input as HnsDnsZoneHealthInputV1;
}

export type HnsFirstPartyHostPersistenceStoreV1 = Readonly<{
  reserveDnsZoneActivation: (
    reviewed_document_bytes: Uint8Array,
    lease_seconds: number,
  ) => Effect.Effect<HnsDnsZoneActivationReservationV1, ControlPlaneError>;
  finalizeDnsZoneActivation: (
    input: Readonly<{
      reservation: HnsDnsZoneActivationReservationV1;
      reviewed_document_bytes: Uint8Array;
    }>,
  ) => Effect.Effect<HnsDnsZoneActivationOutcomeV1, ControlPlaneError>;
  recordDnsZoneHealth: (
    reviewed_document_bytes: Uint8Array,
  ) => Effect.Effect<HnsDnsZoneHealthOutcomeV1, ControlPlaneError>;
  changeCommunityAppHostStatus: (
    reviewed_document_bytes: Uint8Array,
  ) => Effect.Effect<HnsCommunityAppHostActivationOutcomeV1, ControlPlaneError>;
}>;
