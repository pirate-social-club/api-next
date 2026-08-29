import type { Effect } from "effect";
import {
  decodeHnsAuthorityInventoryBytes,
  encodeHnsAuthorityInventory,
} from "./namespace-ownership/hns-authority-inventory.ts";
import {
  type HnsChainAuthorityRecord,
  hnsChainAuthorityDigest,
  hnsChainAuthorityRecords,
} from "./namespace-ownership/hns-control-observer.ts";
import {
  decodeHnsControlObservationResultV2Bytes,
  encodeHnsControlObservationResultV2,
} from "./namespace-ownership/hns-control-observer-v2.ts";
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

export type HnsAuthoritySuccessorGenerationsV1 = Readonly<{
  dns_activation_generation: number;
  app_host_activation_generation: number;
  health_generation: number;
}>;

export type HnsAuthorityEmitDsV1 = readonly [number, 13, 2 | 4, string];
export type HnsAuthorityEmitChainRecordV1 = HnsChainAuthorityRecord;
export type HnsAuthorityEmitViewV1 = Readonly<{
  authority_address: string;
  outcome: "observed" | "unavailable";
  zone_bytes_digest: string | null;
  dnskey_key_tag: number | null;
  derived_ds: ReadonlyArray<HnsAuthorityEmitDsV1> | null;
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
      | "artifact_semantics_mismatch",
  ) {
    super(`HNS authority candidate emission refused: ${reason}`);
  }
}

export const HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION =
  "pirate-hns-authority-successor-candidate-v1" as const;

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

/** Produces one complete canonical review package or refuses without output. */
export async function prepareHnsAuthoritySuccessorCandidateV1(
  input: Readonly<{
    source_commit: string;
    root_label: string;
    observed_at: string;
    chain_height: number;
    expected_chain_network: string;
    chain_authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
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
  const observation = await decodeHnsControlObservationResultV2Bytes(
    input.artifacts.observer_evidence,
  );
  if (observation.result.status !== "verified") {
    throw new HnsAuthorityEmitRefusal("observer_evidence_not_verified");
  }
  if (
    observation.result.root_label !== input.root_label ||
    observation.result.chain_anchor_height !== input.chain_height ||
    observation.result.chain_network !== input.expected_chain_network ||
    observation.result.ownership_source !== "owner_authoritative_dns_txt"
  ) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  let chainAuthorityRecords: ReadonlyArray<HnsChainAuthorityRecord>;
  let chainAuthorityDigest: string;
  try {
    chainAuthorityRecords = hnsChainAuthorityRecords(
      observation.result.ownership_source,
      input.chain_authority_records,
    );
    chainAuthorityDigest = await hnsChainAuthorityDigest({
      chain_network: observation.result.chain_network,
      chain_genesis_block_hash: observation.result.chain_genesis_block_hash,
      root_label: observation.result.root_label,
      ownership_source: observation.result.ownership_source,
      authority_records: chainAuthorityRecords,
    });
  } catch {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
  if (chainAuthorityDigest !== observation.result.chain_authority_digest) {
    throw new HnsAuthorityEmitRefusal("observer_evidence_mismatch");
  }
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
  const canonicalObservation = await encodeHnsControlObservationResultV2(observation.result);
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
    generation_snapshot: input.generation_snapshot,
    generations,
    expected_authority_addresses: input.expected_authority_addresses,
    views,
    inventory,
    dns_zone_activation: dnsZoneActivation,
    app_host_transition: appHostTransition,
    health_observation: healthObservation,
    observer_evidence: observation.result,
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
    chain_network: observation.result.chain_network,
    chain_genesis_block_hash: observation.result.chain_genesis_block_hash,
    chain_authority_digest: chainAuthorityDigest,
    chain_authority_records: chainAuthorityRecords,
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
  const activeAuthorityAddresses = new Set(
    inventory.authoritative_nameserver_glue
      .filter((entry) => entry.active)
      .map((entry) => entry.authority_address),
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
  const canonical = (records: ReadonlyArray<HnsAuthorityEmitDsV1>) =>
    [...records].sort((first, second) => {
      const encodedFirst = JSON.stringify(first);
      const encodedSecond = JSON.stringify(second);
      return encodedFirst < encodedSecond ? -1 : encodedFirst > encodedSecond ? 1 : 0;
    });
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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

/** Requires a complete, internally consistent two-authority DNSSEC observation. */
export function requireHnsAuthorityEmitObservationV1(
  input: Readonly<{
    expected_authority_addresses: readonly [string, string];
    views: ReadonlyArray<HnsAuthorityEmitViewV1>;
    chain_ds: ReadonlyArray<HnsAuthorityEmitDsV1>;
  }>,
): readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1] {
  const [firstAddress, secondAddress] = input.expected_authority_addresses;
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
  return [first, second];
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
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      activation_document_digest: string;
      dns_zone_activation_id: string;
      expected_activation_generation: number;
      lease_seconds: number;
    }>,
  ) => Effect.Effect<HnsDnsZoneActivationReservationV1, ControlPlaneError>;
  finalizeDnsZoneActivation: (
    input: Readonly<{
      reservation: HnsDnsZoneActivationReservationV1;
      reviewed_document_bytes: Uint8Array;
    }>,
  ) => Effect.Effect<HnsDnsZoneActivationOutcomeV1, ControlPlaneError>;
  changeDnsZoneStatus: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      request_hash: string;
      dns_zone_activation_id: string;
      expected_activation_generation: number;
      target_status: HnsDnsZoneActivationLifecycleStatusV1;
      reason_code: string;
    }>,
  ) => Effect.Effect<HnsLifecycleOutcomeV1, ControlPlaneError>;
  recordDnsZoneHealth: (
    reviewed_document_bytes: Uint8Array,
  ) => Effect.Effect<HnsDnsZoneHealthOutcomeV1, ControlPlaneError>;
  activateCommunityAppHost: (
    input: Readonly<{
      operation_id: string;
      idempotency_key: string;
      request_hash: string;
      app_host_activation_id: string;
      community_id: string;
      canonical_root: string;
      route_binding_id: string;
      route_authority_kind: "verified_namespace_v1" | "operator_managed_route_v1";
      route_authority_reference: string;
      route_authority_generation: number;
      dns_zone_activation_id: string;
      dns_zone_activation_generation: number;
      gateway_deployment_reference: string;
    }>,
  ) => Effect.Effect<HnsCommunityAppHostActivationOutcomeV1, ControlPlaneError>;
  changeCommunityAppHostStatus: (
    reviewed_document_bytes: Uint8Array,
  ) => Effect.Effect<HnsCommunityAppHostActivationOutcomeV1, ControlPlaneError>;
}>;
