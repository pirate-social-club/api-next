import {
  decodeHnsAuthorityDetachedObserverEvidenceV1,
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsAuthorityDetachedObserverEvidenceV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  type HnsAuthorityAddressProvenanceV1,
  type HnsAuthorityDetachedObserverFactsV1,
  type HnsAuthorityEmitChainRecordV1,
  type HnsAuthorityEmitViewV1,
  type HnsAuthoritySuccessorGenerationSnapshotV1,
  prepareHnsAuthoritySuccessorCandidateV1,
  prepareHnsDnsZoneActivationDocumentV1,
} from "@pirate/application/hns-host-persistence";
import { decodeHnsAuthorityInventoryBytes } from "@pirate/application/namespace-ownership";

export const HNS_AUTHORITY_SUCCESSOR_OBSERVATION_VERSION =
  "pirate-hns-authority-successor-observation-v1" as const;
export const HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES = 48 * 1_024 * 1_024;
export const HNS_JAZLEEUW_AUTHORITY_ROOT_LABEL = "jazleeuw" as const;

const artifactNames = [
  "authority_inventory",
  "dns_zone_activation",
  "app_host_activation",
  "health_observation",
  "observer_evidence",
] as const;

export type HnsAuthoritySuccessorArtifactNameV1 = (typeof artifactNames)[number];

export type HnsAuthoritySuccessorDetachedTranscriptEntryV1 = Readonly<{
  exchange_kind: "hns_rpc" | "child_authority_dns" | "parent_authority_dns";
  vantage_reference: string;
  subject_reference: string;
  query_reference: string;
  request_bytes: Uint8Array;
  response_bytes: Uint8Array;
}>;

type HnsAuthoritySuccessorEncodedTranscriptEntryV1 = Readonly<{
  exchange_kind: HnsAuthoritySuccessorDetachedTranscriptEntryV1["exchange_kind"];
  vantage_reference: string;
  subject_reference: string;
  query_reference: string;
  request_sha256: string;
  response_sha256: string;
  request_hex: string;
  response_hex: string;
}>;

export type HnsAuthoritySuccessorSourceObservationV1 = Readonly<{
  observer_evidence_reference: string;
  detached_transcript: ReadonlyArray<HnsAuthoritySuccessorDetachedTranscriptEntryV1>;
  generation_snapshot_database_time: string;
  source_commit: string;
  root_label: string;
  observed_at: string;
  chain_height: number;
  expected_chain_network: string;
  chain_authority_records: ReadonlyArray<HnsAuthorityEmitChainRecordV1>;
  authority_address_provenance: HnsAuthorityAddressProvenanceV1;
  generation_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
  expected_authority_addresses: readonly [string, string];
  authority_views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
  artifacts: Readonly<Record<HnsAuthoritySuccessorArtifactNameV1, Uint8Array>>;
}>;

export type HnsAuthoritySuccessorObservationDocumentV1 = Readonly<{
  version: typeof HNS_AUTHORITY_SUCCESSOR_OBSERVATION_VERSION;
  source_provenance: Readonly<{
    source_kind: "detached-read-only-observation-v1";
    observer_evidence_reference: string;
    detached_transcript_sha256: string;
    generation_snapshot_database_time: string;
    generation_snapshot_sha256: string;
  }>;
  source_commit: string;
  root_label: string;
  observed_at: string;
  chain_height: number;
  expected_chain_network: string;
  chain_authority_records: ReadonlyArray<HnsAuthorityEmitChainRecordV1>;
  authority_address_provenance: HnsAuthorityAddressProvenanceV1;
  generation_snapshot: HnsAuthoritySuccessorGenerationSnapshotV1;
  expected_authority_addresses: readonly [string, string];
  authority_views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
  detached_transcript: ReadonlyArray<HnsAuthoritySuccessorEncodedTranscriptEntryV1>;
  artifacts_hex: Readonly<Record<HnsAuthoritySuccessorArtifactNameV1, string>>;
}>;

export class HnsAuthoritySuccessorObservationHarnessError extends Error {
  readonly name = "HnsAuthoritySuccessorObservationHarnessError";

  constructor(
    readonly reason:
      | "invalid_arguments"
      | "source_unavailable"
      | "invalid_source_observation"
      | "invalid_observation_document"
      | "observation_too_large"
      | "observer_provenance_mismatch",
  ) {
    super(`HNS authority successor observation harness refused: ${reason}`);
  }
}

export type HnsAuthoritySuccessorObservationSourceV1 = Readonly<{
  observe: (
    options: Readonly<{ signal: AbortSignal }>,
  ) => Promise<HnsAuthoritySuccessorSourceObservationV1> | HnsAuthoritySuccessorSourceObservationV1;
}>;

export type HnsAuthoritySuccessorObservationHarnessIoV1 = Readonly<{
  emit: (observationBytes: Uint8Array) => Promise<void>;
}>;

export type HnsAuthoritySuccessorLiveAuthorityObservationV1 = Readonly<{
  source_commit: string;
  observer_facts: HnsAuthorityDetachedObserverFactsV1;
  chain_authority_records: ReadonlyArray<HnsAuthorityEmitChainRecordV1>;
  authority_address_provenance: HnsAuthorityAddressProvenanceV1;
  authority_views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
  detached_transcript: ReadonlyArray<HnsAuthoritySuccessorDetachedTranscriptEntryV1>;
  authority_inventory_bytes: Uint8Array;
  zone_bytes: Uint8Array;
  dns_authority_reference: string;
  dnssec_keyset_reference: string;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  gateway_healthy: boolean;
}>;

export type HnsAuthoritySuccessorLiveAuthorityPortV1 = Readonly<{
  observe: (
    options: Readonly<{ signal: AbortSignal }>,
  ) =>
    | Promise<HnsAuthoritySuccessorLiveAuthorityObservationV1>
    | HnsAuthoritySuccessorLiveAuthorityObservationV1;
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

function exactObject(
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function sha256HexValue(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function safeIdentity(value: unknown, maximumBytes = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function validAuthorityAddressProvenance(value: unknown): value is HnsAuthorityAddressProvenanceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (
    "source_kind" in value &&
    value.source_kind === "chain_glue_v1" &&
    exactObject(value, ["source_kind"])
  ) {
    return true;
  }
  if (
    !exactObject(value, [
      "source_kind",
      "parent_zone",
      "parent_chain_authority_digest",
      "parent_chain_authority_records",
      "views",
    ]) ||
    value.source_kind !== "dnssec_parent_authoritative_dns_v1" ||
    typeof value.parent_zone !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value.parent_zone) ||
    !sha256HexValue(value.parent_chain_authority_digest) ||
    !Array.isArray(value.parent_chain_authority_records) ||
    !Array.isArray(value.views) ||
    value.views.length !== 2
  ) {
    return false;
  }
  return value.views.every(
    (view) =>
      exactObject(view, [
        "view_id",
        "vantage_reference",
        "outcome",
        "dnssec_validation",
        "dnskey_key_tag",
        "derived_ds",
        "records",
      ]) &&
      safeIdentity(view.view_id) &&
      safeIdentity(view.vantage_reference) &&
      (view.outcome === "observed" || view.outcome === "unavailable") &&
      (view.dnssec_validation === "secure" ||
        view.dnssec_validation === "insecure" ||
        view.dnssec_validation === "bogus" ||
        view.dnssec_validation === "indeterminate") &&
      (view.dnskey_key_tag === null ||
        (Number.isSafeInteger(view.dnskey_key_tag) &&
          Number(view.dnskey_key_tag) >= 0 &&
          Number(view.dnskey_key_tag) <= 65_535)) &&
      (view.derived_ds === null || Array.isArray(view.derived_ds)) &&
      (view.records === null ||
        (Array.isArray(view.records) &&
          view.records.every(
            (record) =>
              Array.isArray(record) &&
              record.length === 3 &&
              (record[0] === "A" || record[0] === "AAAA") &&
              typeof record[1] === "string" &&
              typeof record[2] === "string",
          ))),
  );
}

function validArtifactsHex(
  value: unknown,
): value is Record<HnsAuthoritySuccessorArtifactNameV1, string> {
  return (
    exactObject(value, artifactNames) &&
    artifactNames.every((name) => typeof value[name] === "string")
  );
}

function validEncodedTranscriptEntry(
  value: unknown,
): value is HnsAuthoritySuccessorEncodedTranscriptEntryV1 {
  return (
    exactObject(value, [
      "exchange_kind",
      "vantage_reference",
      "subject_reference",
      "query_reference",
      "request_sha256",
      "response_sha256",
      "request_hex",
      "response_hex",
    ]) &&
    (value.exchange_kind === "hns_rpc" ||
      value.exchange_kind === "child_authority_dns" ||
      value.exchange_kind === "parent_authority_dns") &&
    safeIdentity(value.vantage_reference) &&
    safeIdentity(value.subject_reference) &&
    safeIdentity(value.query_reference) &&
    sha256HexValue(value.request_sha256) &&
    sha256HexValue(value.response_sha256) &&
    typeof value.request_hex === "string" &&
    typeof value.response_hex === "string"
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/u.test(value) ||
    value.length > 8 * 1_024 * 1_024
  ) {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_observation_document");
  }
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)));
}

async function encodeDetachedTranscript(
  transcript: ReadonlyArray<HnsAuthoritySuccessorDetachedTranscriptEntryV1>,
): Promise<ReadonlyArray<HnsAuthoritySuccessorEncodedTranscriptEntryV1>> {
  return Promise.all(
    transcript.map(async (entry) => ({
      exchange_kind: entry.exchange_kind,
      vantage_reference: entry.vantage_reference,
      subject_reference: entry.subject_reference,
      query_reference: entry.query_reference,
      request_sha256: await sha256(entry.request_bytes),
      response_sha256: await sha256(entry.response_bytes),
      request_hex: hex(entry.request_bytes),
      response_hex: hex(entry.response_bytes),
    })),
  );
}

async function detachedTranscriptSha256(
  transcript: ReadonlyArray<HnsAuthoritySuccessorEncodedTranscriptEntryV1>,
): Promise<string> {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify(["pirate-hns-authority-detached-transcript-v1", transcript]),
    ),
  );
}

async function decodeAndValidateDetachedTranscript(
  document: HnsAuthoritySuccessorObservationDocumentV1,
): Promise<ReadonlyArray<HnsAuthoritySuccessorDetachedTranscriptEntryV1>> {
  if (
    document.detached_transcript.length < 5 ||
    document.detached_transcript.length > 64 ||
    !document.detached_transcript.every(validEncodedTranscriptEntry)
  ) {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_observation_document");
  }
  const decoded: HnsAuthoritySuccessorDetachedTranscriptEntryV1[] = [];
  const identities = new Set<string>();
  for (const entry of document.detached_transcript) {
    const requestBytes = bytesFromHex(entry.request_hex);
    const responseBytes = bytesFromHex(entry.response_hex);
    if (
      (await sha256(requestBytes)) !== entry.request_sha256 ||
      (await sha256(responseBytes)) !== entry.response_sha256
    ) {
      throw new HnsAuthoritySuccessorObservationHarnessError("observer_provenance_mismatch");
    }
    const identity = JSON.stringify([
      entry.exchange_kind,
      entry.vantage_reference,
      entry.subject_reference,
      entry.query_reference,
    ]);
    if (identities.has(identity)) {
      throw new HnsAuthoritySuccessorObservationHarnessError("invalid_observation_document");
    }
    identities.add(identity);
    decoded.push({
      exchange_kind: entry.exchange_kind,
      vantage_reference: entry.vantage_reference,
      subject_reference: entry.subject_reference,
      query_reference: entry.query_reference,
      request_bytes: requestBytes,
      response_bytes: responseBytes,
    });
  }
  const expectedChildAddresses = new Set(document.expected_authority_addresses);
  const parentVantages = new Set(
    document.authority_address_provenance.source_kind === "dnssec_parent_authoritative_dns_v1"
      ? document.authority_address_provenance.views.map((view) => view.vantage_reference)
      : [],
  );
  const transcriptShapeIsBound = decoded.every((entry) => {
    if (entry.exchange_kind === "hns_rpc") {
      return entry.subject_reference === document.root_label;
    }
    if (entry.exchange_kind === "child_authority_dns") {
      return expectedChildAddresses.has(entry.subject_reference);
    }
    return (
      document.authority_address_provenance.source_kind === "dnssec_parent_authoritative_dns_v1" &&
      entry.subject_reference === document.authority_address_provenance.parent_zone &&
      parentVantages.has(entry.vantage_reference)
    );
  });
  if (
    !transcriptShapeIsBound ||
    !decoded.some((entry) => entry.exchange_kind === "hns_rpc") ||
    [...expectedChildAddresses].some(
      (address) =>
        !decoded.some(
          (entry) =>
            entry.exchange_kind === "child_authority_dns" && entry.subject_reference === address,
        ),
    ) ||
    [...parentVantages].some(
      (vantage) =>
        !decoded.some(
          (entry) =>
            entry.exchange_kind === "parent_authority_dns" && entry.vantage_reference === vantage,
        ),
    )
  ) {
    throw new HnsAuthoritySuccessorObservationHarnessError("observer_provenance_mismatch");
  }
  return decoded;
}

async function operationAuthority(
  kind: "app-host" | "health",
  semanticInput: unknown,
): Promise<Readonly<{ operation_id: string; idempotency_key: string; request_hash: string }>> {
  const requestHash = await sha256(
    new TextEncoder().encode(
      JSON.stringify(["pirate-hns-authority-successor-operation-v1", kind, semanticInput]),
    ),
  );
  return {
    operation_id: `hns-authority-successor:${kind}:${requestHash}`,
    idempotency_key: `hns-authority-successor:${kind}:${requestHash}`,
    request_hash: requestHash,
  };
}

/**
 * Composes the only production-shaped source accepted by the harness. Root,
 * row identities, generations, chain height, addresses, and observer
 * provenance are all derived from the two read-only ports rather than caller
 * arguments.
 */
export function makeHnsAuthoritySuccessorObservationSourceV1(input: {
  readonly live_authority: HnsAuthoritySuccessorLiveAuthorityPortV1;
  readonly generation_reader: HnsAuthoritySuccessorGenerationReaderV1;
  readonly health_valid_for_seconds: number;
}): HnsAuthoritySuccessorObservationSourceV1 {
  if (
    !Number.isSafeInteger(input.health_valid_for_seconds) ||
    input.health_valid_for_seconds < 1 ||
    input.health_valid_for_seconds > 86_400
  ) {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
  }
  return {
    observe: async ({ signal }) => {
      if (signal.aborted) {
        throw new HnsAuthoritySuccessorObservationHarnessError("source_unavailable");
      }
      const live = await input.live_authority.observe({ signal });
      const observerEvidenceBytes = await encodeHnsAuthorityDetachedObserverEvidenceV1({
        ...live.observer_facts,
        detached_transcript: live.detached_transcript,
      });
      const evidence = await decodeHnsAuthorityDetachedObserverEvidenceV1(observerEvidenceBytes);
      const rootLabel = evidence.root_label;
      if (rootLabel !== HNS_JAZLEEUW_AUTHORITY_ROOT_LABEL) {
        throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
      }
      const generation = await input.generation_reader.read(
        { canonical_root: rootLabel, normalized_app_host: `app.${rootLabel}` },
        { signal },
      );
      if (signal.aborted || !canonicalInstant(generation.database_time)) {
        throw new HnsAuthoritySuccessorObservationHarnessError("source_unavailable");
      }
      const inventory = await decodeHnsAuthorityInventoryBytes(live.authority_inventory_bytes);
      const activeGlue = inventory.inventory.authoritative_nameserver_glue.filter(
        (entry) => entry.active,
      );
      if (activeGlue.length !== 2) {
        throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
      }
      const firstAddress = activeGlue[0]?.authority_address;
      const secondAddress = activeGlue[1]?.authority_address;
      if (
        firstAddress === undefined ||
        secondAddress === undefined ||
        firstAddress === secondAddress
      ) {
        throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
      }
      const dnsGeneration = generation.snapshot.dns_current_generation + 1;
      if (!Number.isSafeInteger(dnsGeneration)) {
        throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
      }
      const observedKeyTag = live.authority_views[0].dnskey_key_tag;
      if (observedKeyTag === null) {
        throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
      }
      const delegationReference = evidence.evidence_reference;
      const dnsDocument = await prepareHnsDnsZoneActivationDocumentV1({
        payload: {
          version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
          dns_zone_activation_id: generation.snapshot.dns_zone_activation_id,
          canonical_root: rootLabel,
          dns_authority: ["pirate_managed_dns_v1", live.dns_authority_reference, dnsGeneration],
          pirate_dns_authority_inventory: [
            inventory.inventory.authority_inventory_reference,
            inventory.inventory.authority_inventory_version,
            inventory.inventory_digest,
          ],
          zone_revision: dnsGeneration,
          dnssec_keyset: [live.dnssec_keyset_reference, `key-tag-${observedKeyTag}`],
          gateway: [live.gateway_deployment_reference, live.gateway_certificate_spki_sha256],
          stable_chain_delegation_snapshot: [delegationReference, evidence.chain_authority_digest],
        },
        zone_bytes: live.zone_bytes,
      });
      const appSemanticInput = [
        generation.snapshot.app_host_activation_id,
        generation.snapshot.app_host_current_generation,
        "active",
        "canonical-authority",
      ] as const;
      const appAuthority = await operationAuthority("app-host", appSemanticInput);
      const appHost = encodeHnsAppHostTransitionDocumentV1({
        ...appAuthority,
        app_host_activation_id: generation.snapshot.app_host_activation_id,
        expected_activation_generation: generation.snapshot.app_host_current_generation,
        target_status: "active",
        reason_code: "canonical-authority",
      });
      const healthSemanticInput = [
        generation.snapshot.dns_zone_activation_id,
        dnsGeneration,
        generation.snapshot.successor_dns_latest_health_generation,
        delegationReference,
        evidence.chain_authority_digest,
        dnsDocument.zone_bytes_digest,
        live.dnssec_keyset_reference,
        `key-tag-${observedKeyTag}`,
        live.gateway_deployment_reference,
        live.gateway_certificate_spki_sha256,
        live.gateway_healthy,
        input.health_valid_for_seconds,
      ] as const;
      const healthAuthority = await operationAuthority("health", healthSemanticInput);
      const health = encodeHnsDnsHealthDocumentV1({
        ...healthAuthority,
        dns_zone_activation_id: generation.snapshot.dns_zone_activation_id,
        activation_generation: dnsGeneration,
        expected_health_generation: generation.snapshot.successor_dns_latest_health_generation,
        stable_chain_delegation_snapshot_reference: delegationReference,
        stable_chain_delegation_snapshot_digest: evidence.chain_authority_digest,
        observed_zone_bytes_digest: dnsDocument.zone_bytes_digest,
        observed_dnssec_keyset_reference: live.dnssec_keyset_reference,
        observed_dnssec_keyset_version: `key-tag-${observedKeyTag}`,
        observed_gateway_deployment_reference: live.gateway_deployment_reference,
        observed_gateway_certificate_spki_sha256: live.gateway_certificate_spki_sha256,
        delegation_matches: true,
        ds_authenticates_zone: true,
        retained_zone_digest_matches: true,
        gateway_healthy: live.gateway_healthy,
        valid_for_seconds: input.health_valid_for_seconds,
      });
      return {
        observer_evidence_reference: evidence.evidence_reference,
        detached_transcript: live.detached_transcript,
        generation_snapshot_database_time: generation.database_time,
        source_commit: live.source_commit,
        root_label: rootLabel,
        observed_at: generation.database_time,
        chain_height: evidence.chain_anchor_height,
        expected_chain_network: evidence.chain_network,
        chain_authority_records: live.chain_authority_records,
        authority_address_provenance: live.authority_address_provenance,
        generation_snapshot: generation.snapshot,
        expected_authority_addresses: [firstAddress, secondAddress],
        authority_views: live.authority_views,
        artifacts: {
          authority_inventory: Uint8Array.from(live.authority_inventory_bytes),
          dns_zone_activation: encodeHnsDnsZonePersistenceDocumentV1(dnsDocument),
          app_host_activation: appHost,
          health_observation: health,
          observer_evidence: observerEvidenceBytes,
        },
      };
    },
  };
}

function generationSnapshotPreimage(
  databaseTime: string,
  snapshot: HnsAuthoritySuccessorGenerationSnapshotV1,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "pirate-hns-authority-successor-generation-snapshot-v1",
      databaseTime,
      snapshot.dns_zone_activation_id,
      snapshot.dns_current_generation,
      snapshot.app_host_activation_id,
      snapshot.app_host_current_generation,
      snapshot.successor_dns_latest_health_generation,
    ]),
  );
}

async function observationDocument(
  source: HnsAuthoritySuccessorSourceObservationV1,
): Promise<HnsAuthoritySuccessorObservationDocumentV1> {
  const detachedTranscript = await encodeDetachedTranscript(source.detached_transcript);
  const transcriptSha256 = await detachedTranscriptSha256(detachedTranscript);
  const generationSnapshotSha256 = await sha256(
    generationSnapshotPreimage(
      source.generation_snapshot_database_time,
      source.generation_snapshot,
    ),
  );
  return {
    version: HNS_AUTHORITY_SUCCESSOR_OBSERVATION_VERSION,
    source_provenance: {
      source_kind: "detached-read-only-observation-v1",
      observer_evidence_reference: source.observer_evidence_reference,
      detached_transcript_sha256: transcriptSha256,
      generation_snapshot_database_time: source.generation_snapshot_database_time,
      generation_snapshot_sha256: generationSnapshotSha256,
    },
    source_commit: source.source_commit,
    root_label: source.root_label,
    observed_at: source.observed_at,
    chain_height: source.chain_height,
    expected_chain_network: source.expected_chain_network,
    chain_authority_records: source.chain_authority_records,
    authority_address_provenance: source.authority_address_provenance,
    generation_snapshot: source.generation_snapshot,
    expected_authority_addresses: source.expected_authority_addresses,
    authority_views: source.authority_views,
    detached_transcript: detachedTranscript,
    artifacts_hex: Object.fromEntries(
      artifactNames.map((name) => [name, hex(source.artifacts[name])]),
    ) as Record<HnsAuthoritySuccessorArtifactNameV1, string>,
  };
}

function structurallyValid(value: unknown): value is HnsAuthoritySuccessorObservationDocumentV1 {
  if (
    !exactObject(value, [
      "version",
      "source_provenance",
      "source_commit",
      "root_label",
      "observed_at",
      "chain_height",
      "expected_chain_network",
      "chain_authority_records",
      "authority_address_provenance",
      "generation_snapshot",
      "expected_authority_addresses",
      "authority_views",
      "detached_transcript",
      "artifacts_hex",
    ]) ||
    value.version !== HNS_AUTHORITY_SUCCESSOR_OBSERVATION_VERSION ||
    !exactObject(value.source_provenance, [
      "source_kind",
      "observer_evidence_reference",
      "detached_transcript_sha256",
      "generation_snapshot_database_time",
      "generation_snapshot_sha256",
    ]) ||
    value.source_provenance.source_kind !== "detached-read-only-observation-v1" ||
    !safeIdentity(value.source_provenance.observer_evidence_reference) ||
    !sha256HexValue(value.source_provenance.detached_transcript_sha256) ||
    !canonicalInstant(value.source_provenance.generation_snapshot_database_time) ||
    !sha256HexValue(value.source_provenance.generation_snapshot_sha256) ||
    typeof value.source_commit !== "string" ||
    typeof value.root_label !== "string" ||
    !canonicalInstant(value.observed_at) ||
    !Number.isSafeInteger(value.chain_height) ||
    typeof value.expected_chain_network !== "string" ||
    !Array.isArray(value.chain_authority_records) ||
    !validAuthorityAddressProvenance(value.authority_address_provenance) ||
    !exactObject(value.generation_snapshot, [
      "dns_zone_activation_id",
      "dns_current_generation",
      "app_host_activation_id",
      "app_host_current_generation",
      "successor_dns_latest_health_generation",
    ]) ||
    !safeIdentity(value.generation_snapshot.dns_zone_activation_id) ||
    !Number.isSafeInteger(value.generation_snapshot.dns_current_generation) ||
    !safeIdentity(value.generation_snapshot.app_host_activation_id) ||
    !Number.isSafeInteger(value.generation_snapshot.app_host_current_generation) ||
    !Number.isSafeInteger(value.generation_snapshot.successor_dns_latest_health_generation) ||
    !Array.isArray(value.expected_authority_addresses) ||
    value.expected_authority_addresses.length !== 2 ||
    !value.expected_authority_addresses.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.authority_views) ||
    value.authority_views.length !== 2 ||
    !Array.isArray(value.detached_transcript) ||
    !validArtifactsHex(value.artifacts_hex)
  ) {
    return false;
  }
  return true;
}

export async function decodeHnsAuthoritySuccessorObservationDocumentV1(bytes: Uint8Array): Promise<
  Readonly<{
    document: HnsAuthoritySuccessorObservationDocumentV1;
    source_observation: HnsAuthoritySuccessorSourceObservationV1;
  }>
> {
  const owned = Uint8Array.from(bytes);
  if (owned.byteLength === 0 || owned.byteLength > HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES) {
    throw new HnsAuthoritySuccessorObservationHarnessError(
      owned.byteLength > HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES
        ? "observation_too_large"
        : "invalid_observation_document",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(owned));
  } catch {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_observation_document");
  }
  const canonical = new TextEncoder().encode(JSON.stringify(value));
  if (
    canonical.byteLength !== owned.byteLength ||
    canonical.some((byte, index) => byte !== owned[index]) ||
    !structurallyValid(value)
  ) {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_observation_document");
  }
  const artifacts = Object.fromEntries(
    artifactNames.map((name) => [name, bytesFromHex(value.artifacts_hex[name])]),
  ) as Record<HnsAuthoritySuccessorArtifactNameV1, Uint8Array>;
  const detachedTranscript = await decodeAndValidateDetachedTranscript(value);
  const transcriptSha256 = await detachedTranscriptSha256(value.detached_transcript);
  const expectedGenerationDigest = await sha256(
    generationSnapshotPreimage(
      value.source_provenance.generation_snapshot_database_time,
      value.generation_snapshot,
    ),
  );
  let observerEvidence: Awaited<ReturnType<typeof decodeHnsAuthorityDetachedObserverEvidenceV1>>;
  try {
    observerEvidence = await decodeHnsAuthorityDetachedObserverEvidenceV1(
      artifacts.observer_evidence,
    );
  } catch {
    throw new HnsAuthoritySuccessorObservationHarnessError("observer_provenance_mismatch");
  }
  if (
    expectedGenerationDigest !== value.source_provenance.generation_snapshot_sha256 ||
    transcriptSha256 !== value.source_provenance.detached_transcript_sha256 ||
    observerEvidence.evidence_reference !== value.source_provenance.observer_evidence_reference ||
    observerEvidence.detached_transcript_sha256 !== transcriptSha256
  ) {
    throw new HnsAuthoritySuccessorObservationHarnessError("observer_provenance_mismatch");
  }
  return {
    document: value,
    source_observation: {
      observer_evidence_reference: value.source_provenance.observer_evidence_reference,
      detached_transcript: detachedTranscript,
      generation_snapshot_database_time: value.source_provenance.generation_snapshot_database_time,
      source_commit: value.source_commit,
      root_label: value.root_label,
      observed_at: value.observed_at,
      chain_height: value.chain_height,
      expected_chain_network: value.expected_chain_network,
      chain_authority_records: value.chain_authority_records,
      authority_address_provenance: value.authority_address_provenance,
      generation_snapshot: value.generation_snapshot,
      expected_authority_addresses: value.expected_authority_addresses,
      authority_views: value.authority_views,
      artifacts,
    },
  };
}

type CandidatePreparer = typeof prepareHnsAuthoritySuccessorCandidateV1;

function candidateInput(source: HnsAuthoritySuccessorSourceObservationV1) {
  return {
    source_commit: source.source_commit,
    root_label: source.root_label,
    observed_at: source.observed_at,
    chain_height: source.chain_height,
    expected_chain_network: source.expected_chain_network,
    chain_authority_records: source.chain_authority_records,
    authority_address_provenance: source.authority_address_provenance,
    generation_snapshot: source.generation_snapshot,
    expected_authority_addresses: source.expected_authority_addresses,
    authority_views: source.authority_views,
    artifacts: source.artifacts,
  };
}

export async function runHnsAuthoritySuccessorObservationHarnessV1(
  args: readonly string[],
  source: HnsAuthoritySuccessorObservationSourceV1,
  io: HnsAuthoritySuccessorObservationHarnessIoV1,
  options: Readonly<{ readonly signal?: AbortSignal }> = {},
  prepare: CandidatePreparer = prepareHnsAuthoritySuccessorCandidateV1,
) {
  if (args.length !== 0) {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_arguments");
  }
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw new HnsAuthoritySuccessorObservationHarnessError("source_unavailable");
  }
  let observed: HnsAuthoritySuccessorSourceObservationV1;
  try {
    observed = await source.observe({ signal });
  } catch (error) {
    if (error instanceof HnsAuthoritySuccessorObservationHarnessError) throw error;
    throw new HnsAuthoritySuccessorObservationHarnessError("source_unavailable");
  }
  let documentBytes: Uint8Array;
  try {
    documentBytes = new TextEncoder().encode(JSON.stringify(await observationDocument(observed)));
  } catch {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
  }
  const decoded = await decodeHnsAuthoritySuccessorObservationDocumentV1(documentBytes);
  let candidate: Awaited<ReturnType<CandidatePreparer>>;
  try {
    candidate = await prepare(candidateInput(decoded.source_observation));
  } catch {
    throw new HnsAuthoritySuccessorObservationHarnessError("invalid_source_observation");
  }
  if (signal.aborted) {
    throw new HnsAuthoritySuccessorObservationHarnessError("source_unavailable");
  }
  await io.emit(documentBytes);
  return { observation_document_bytes: documentBytes, candidate } as const;
}

export async function prepareCandidateFromHnsAuthoritySuccessorObservationV1(
  bytes: Uint8Array,
  prepare: CandidatePreparer = prepareHnsAuthoritySuccessorCandidateV1,
) {
  const decoded = await decodeHnsAuthoritySuccessorObservationDocumentV1(bytes);
  return prepare(candidateInput(decoded.source_observation));
}
