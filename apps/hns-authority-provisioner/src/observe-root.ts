import {
  decodeHnsAuthorityInventoryBytes,
  decodeStrictHnsJsonBytes,
  encodeHnsAuthorityInventory,
  encodeHnsRootImportReadinessResultV1,
  HNS_AUTHORITY_INVENTORY_VERSION,
  HNS_ROOT_IMPORT_READINESS_RESULT_VERSION,
  type HnsChainAuthorityRecord,
  type HnsRootDelegationDsV1,
  type HnsRootImportPublishPlanV1,
  type HnsRootResourceRecordV1,
  hnsAuthorityCapabilitySetDigest,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";
import type { HnsRootLiveReadinessResultV1 } from "./live-readiness.ts";
import {
  HNS_AUTHORITY_NAMESERVERS,
  HNS_AUTHORITY_PROVISION_RESULT_VERSION,
  type HnsAuthorityZoneResult,
} from "./provision-root.ts";

export const HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION =
  "pirate-hns-root-readiness-observation-request-v1" as const;

export type HnsRootReadinessObservationRequestV1 = Readonly<{
  readonly version: typeof HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION;
  readonly root_import_session_id: string;
  readonly namespace_session_id: string;
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly ownership_result_sha256: string;
  readonly publish_plan_sha256: string;
  readonly provision_result_sha256: string;
  readonly expires_at: string;
}>;

export type HnsRootReadinessObservationPorts = Readonly<{
  readonly inspect_current_resource: (
    rootLabel: string,
  ) => Promise<readonly HnsRootResourceRecordV1[]>;
  readonly inspect_zone: (input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
  }) => Promise<HnsAuthorityZoneResult>;
  readonly observe_live: (input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
    readonly authority_records: ReadonlyArray<HnsChainAuthorityRecord>;
  }) => Promise<HnsRootLiveReadinessResultV1>;
}>;

export type HnsRootReadinessObservationConfig = Readonly<{
  readonly environment: string;
  readonly valid_for_seconds: number;
  readonly now?: () => number;
}>;

export class HnsRootReadinessObservationError extends Error {
  override readonly name = "HnsRootReadinessObservationError";

  constructor(
    readonly code:
      | "invalid_request"
      | "owner_update_pending"
      | "authority_unavailable"
      | "authority_mismatch",
  ) {
    super(code);
  }
}

const encoder = new TextEncoder();

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    encoder.encode(value).byteLength <= 256
  );
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactDs(value: unknown): readonly HnsRootDelegationDsV1[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32 || value.length % 2 !== 0) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  const records = value.map((entry) => {
    if (
      !exactObject(entry, ["key_tag", "algorithm", "digest_type", "digest"]) ||
      !Number.isSafeInteger(entry.key_tag) ||
      !Number.isSafeInteger(entry.algorithm) ||
      (entry.digest_type !== 2 && entry.digest_type !== 4) ||
      typeof entry.digest !== "string" ||
      !/^[0-9a-f]+$/u.test(entry.digest)
    ) {
      throw new HnsRootReadinessObservationError("authority_mismatch");
    }
    return entry as HnsRootDelegationDsV1;
  });
  const identities = new Map<string, Set<number>>();
  for (const record of records) {
    const identity = `${record.key_tag}:${record.algorithm}`;
    const digestTypes = identities.get(identity) ?? new Set<number>();
    digestTypes.add(record.digest_type);
    identities.set(identity, digestTypes);
  }
  if (
    new Set(records.map((record) => canonicalJson(record))).size !== records.length ||
    [...identities.values()].some(
      (digestTypes) => digestTypes.size !== 2 || !digestTypes.has(2) || !digestTypes.has(4),
    )
  ) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  return [...records].sort(
    (left, right) =>
      left.key_tag - right.key_tag ||
      left.algorithm - right.algorithm ||
      left.digest_type - right.digest_type,
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeHnsRootReadinessObservationRequestV1(
  bytes: Uint8Array,
): HnsRootReadinessObservationRequestV1 {
  let value: unknown;
  try {
    value = decodeStrictHnsJsonBytes(bytes, 65_536);
  } catch {
    throw new HnsRootReadinessObservationError("invalid_request");
  }
  if (
    !exactObject(value, [
      "version",
      "root_import_session_id",
      "namespace_session_id",
      "root_label",
      "challenge_txt_value",
      "ownership_result_sha256",
      "publish_plan_sha256",
      "provision_result_sha256",
      "expires_at",
    ]) ||
    value.version !== HNS_ROOT_READINESS_OBSERVATION_REQUEST_VERSION ||
    !id(value.root_import_session_id) ||
    !id(value.namespace_session_id) ||
    typeof value.root_label !== "string" ||
    !validCommunityRouteRoot("hns", value.root_label) ||
    typeof value.challenge_txt_value !== "string" ||
    !value.challenge_txt_value.startsWith("pirate-verification=") ||
    !hash(value.ownership_result_sha256) ||
    !hash(value.publish_plan_sha256) ||
    !hash(value.provision_result_sha256) ||
    !instant(value.expires_at)
  ) {
    throw new HnsRootReadinessObservationError("invalid_request");
  }
  return value as HnsRootReadinessObservationRequestV1;
}

function decodePlan(bytes: Uint8Array): HnsRootImportPublishPlanV1 {
  const value = decodeStrictHnsJsonBytes(bytes, 1_048_576);
  if (
    !exactObject(value, [
      "version",
      "replacement_semantics",
      "current_records",
      "preserved_records",
      "removed_conflicts",
      "added_records",
      "replacement_records",
      "preserved_unknown_record_types",
      "acknowledgement_required",
    ]) ||
    value.version !== "pirate-hns-root-import-publish-plan-v1" ||
    value.replacement_semantics !== "complete_resource" ||
    value.acknowledgement_required !== true ||
    !Array.isArray(value.current_records) ||
    !Array.isArray(value.preserved_records) ||
    !Array.isArray(value.removed_conflicts) ||
    !Array.isArray(value.added_records) ||
    !Array.isArray(value.replacement_records) ||
    !Array.isArray(value.preserved_unknown_record_types)
  ) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  validateHnsRootResourceRecordsV1(value.current_records);
  validateHnsRootResourceRecordsV1(value.preserved_records);
  validateHnsRootResourceRecordsV1(value.removed_conflicts);
  validateHnsRootResourceRecordsV1(value.added_records);
  validateHnsRootResourceRecordsV1(value.replacement_records);
  return value as unknown as HnsRootImportPublishPlanV1;
}

function canonicalRecordMultiset(records: readonly HnsRootResourceRecordV1[]): string {
  return canonicalJson(records.map((record) => canonicalJson(record)).sort());
}

function chainAuthorityRecords(
  records: readonly HnsRootResourceRecordV1[],
): readonly HnsChainAuthorityRecord[] {
  const authority: HnsChainAuthorityRecord[] = [];
  for (const record of records) {
    if (record.type === "NS") {
      if (typeof record.ns !== "string") {
        throw new HnsRootReadinessObservationError("authority_mismatch");
      }
      authority.push(["NS", record.ns.endsWith(".") ? record.ns.slice(0, -1) : record.ns]);
    } else if (record.type === "DS") {
      if (
        !Number.isSafeInteger(record.keyTag) ||
        !Number.isSafeInteger(record.algorithm) ||
        (record.digestType !== 2 && record.digestType !== 4) ||
        typeof record.digest !== "string"
      ) {
        throw new HnsRootReadinessObservationError("authority_mismatch");
      }
      authority.push([
        "DS",
        Number(record.keyTag),
        Number(record.algorithm),
        record.digestType,
        record.digest,
      ]);
    }
  }
  const nameservers = authority
    .filter((record): record is readonly ["NS", string] => record[0] === "NS")
    .map((record) => record[1]);
  if (canonicalJson(nameservers.sort()) !== canonicalJson(["ns1.pirate", "ns2.pirate"])) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  return authority;
}

export type HnsAuthorityProvisionResultV1 = Readonly<{
  readonly root_import_session_id: string;
  readonly root_label: string;
  readonly zone_created: boolean;
  readonly zone_serial: number;
  readonly ds_records: readonly HnsRootDelegationDsV1[];
  readonly managed_rrset_sha256: string;
  readonly shared_tlsa_profile_sha256: string;
  readonly gateway_deployment_reference: string;
  readonly gateway_certificate_spki_sha256: string;
}>;

export function decodeHnsAuthorityProvisionResultV1(
  bytes: Uint8Array,
): HnsAuthorityProvisionResultV1 {
  const value = decodeStrictHnsJsonBytes(bytes, 1_048_576);
  if (
    !exactObject(value, [
      "version",
      "root_import_session_id",
      "root_label",
      "nameservers",
      "zone_created",
      "zone_dnssec",
      "zone_serial",
      "ds_records",
      "managed_rrset_sha256",
      "shared_tlsa_profile_sha256",
      "gateway_ipv4",
      "gateway_deployment_reference",
      "gateway_certificate_spki_sha256",
      "ttl_seconds",
    ]) ||
    value.version !== HNS_AUTHORITY_PROVISION_RESULT_VERSION ||
    !id(value.root_import_session_id) ||
    typeof value.root_label !== "string" ||
    JSON.stringify(value.nameservers) !== JSON.stringify(HNS_AUTHORITY_NAMESERVERS) ||
    typeof value.zone_created !== "boolean" ||
    value.zone_dnssec !== true ||
    !Number.isSafeInteger(value.zone_serial) ||
    Number(value.zone_serial) <= 0 ||
    !hash(value.managed_rrset_sha256) ||
    !hash(value.shared_tlsa_profile_sha256) ||
    !id(value.gateway_deployment_reference) ||
    !hash(value.gateway_certificate_spki_sha256)
  ) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  return { ...value, ds_records: exactDs(value.ds_records) } as never;
}

export async function observeHnsRootReadinessV1(input: {
  readonly observation_attempt: { readonly job_id: string; readonly lease_fence: number };
  readonly operation_kind: "observe_root_v1" | "renew_health_v1";
  readonly request: HnsRootReadinessObservationRequestV1;
  readonly publish_plan_bytes: Uint8Array;
  readonly provision_result_bytes: Uint8Array;
  readonly ports: HnsRootReadinessObservationPorts;
  readonly config: HnsRootReadinessObservationConfig;
}) {
  if (
    !id(input.observation_attempt.job_id) ||
    !Number.isSafeInteger(input.observation_attempt.lease_fence) ||
    input.observation_attempt.lease_fence <= 0
  ) {
    throw new HnsRootReadinessObservationError("invalid_request");
  }
  const now = input.config.now?.() ?? Date.now();
  if (
    !id(input.config.environment) ||
    !Number.isSafeInteger(input.config.valid_for_seconds) ||
    input.config.valid_for_seconds < 60 ||
    input.config.valid_for_seconds > 7 * 86_400 ||
    !Number.isFinite(now) ||
    (input.operation_kind === "observe_root_v1" && now >= Date.parse(input.request.expires_at)) ||
    (await sha256(input.publish_plan_bytes)) !== input.request.publish_plan_sha256 ||
    (await sha256(input.provision_result_bytes)) !== input.request.provision_result_sha256
  ) {
    throw new HnsRootReadinessObservationError("invalid_request");
  }
  const plan = decodePlan(input.publish_plan_bytes);
  const provision = decodeHnsAuthorityProvisionResultV1(input.provision_result_bytes);
  if (
    provision.root_import_session_id !== input.request.root_import_session_id ||
    provision.root_label !== input.request.root_label
  ) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  let chainRecords: readonly HnsRootResourceRecordV1[];
  try {
    chainRecords = validateHnsRootResourceRecordsV1(
      await input.ports.inspect_current_resource(input.request.root_label),
    );
  } catch {
    throw new HnsRootReadinessObservationError("authority_unavailable");
  }
  if (canonicalRecordMultiset(chainRecords) !== canonicalRecordMultiset(plan.replacement_records)) {
    throw new HnsRootReadinessObservationError("owner_update_pending");
  }
  const authorityRecords = chainAuthorityRecords(chainRecords);
  let zone: HnsAuthorityZoneResult;
  try {
    zone = await input.ports.inspect_zone({
      root_label: input.request.root_label,
      challenge_txt_value: input.request.challenge_txt_value,
    });
  } catch {
    throw new HnsRootReadinessObservationError("authority_unavailable");
  }
  if (
    zone.dnssec !== true ||
    zone.serial < provision.zone_serial ||
    canonicalJson(zone.ds_records) !== canonicalJson(provision.ds_records) ||
    zone.managed_rrset_sha256 !== provision.managed_rrset_sha256 ||
    zone.shared_tlsa_profile_sha256 !== provision.shared_tlsa_profile_sha256 ||
    zone.gateway_deployment_reference !== provision.gateway_deployment_reference ||
    zone.gateway_certificate_spki_sha256 !== provision.gateway_certificate_spki_sha256
  ) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }
  let live: HnsRootLiveReadinessResultV1;
  try {
    live = await input.ports.observe_live({
      root_label: input.request.root_label,
      challenge_txt_value: input.request.challenge_txt_value,
      authority_records: authorityRecords,
    });
  } catch {
    throw new HnsRootReadinessObservationError("authority_unavailable");
  }
  const [primaryView, secondaryView] = live.authority_views;
  if (
    primaryView.authority_nameserver !== "ns1.pirate" ||
    secondaryView.authority_nameserver !== "ns2.pirate" ||
    primaryView.dnssec_validation !== "secure" ||
    secondaryView.dnssec_validation !== "secure" ||
    primaryView.challenge_present !== true ||
    secondaryView.challenge_present !== true ||
    primaryView.validated_chain_authority_digest !==
      secondaryView.validated_chain_authority_digest ||
    primaryView.observed_zone_sha256 !== secondaryView.observed_zone_sha256 ||
    live.gateway.certificate_spki_sha256 !== provision.gateway_certificate_spki_sha256 ||
    (live.gateway.http_status !== 200 && live.gateway.http_status !== 421)
  ) {
    throw new HnsRootReadinessObservationError("authority_mismatch");
  }

  const observedAt = new Date(now).toISOString();
  const validUntil = new Date(now + input.config.valid_for_seconds * 1_000).toISOString();
  const capabilityReference = `pdns-zone:${input.request.root_label}`;
  const dnsWriteCapabilities = [
    {
      capability_reference: capabilityReference,
      scope_kind: "exact_root" as const,
      root_label: input.request.root_label,
      active: true,
    },
  ] as const;
  const nameserverGlue = live.authority_views.map((view) => ({
    authority_nameserver: view.authority_nameserver,
    authority_address_family: view.authority_address_family,
    authority_address: view.authority_address,
    active: true,
  }));
  const capabilityDigest = await hnsAuthorityCapabilitySetDigest({
    environment: input.config.environment,
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: dnsWriteCapabilities,
  });
  // A recurring job retains its identity across leases. Fence and evidence
  // identity distinguish successors; replaying retained bytes keeps the version.
  const inventoryIdentity = await sha256(
    encoder.encode(
      canonicalJson([
        input.observation_attempt.job_id,
        input.observation_attempt.lease_fence,
        input.request.provision_result_sha256,
        observedAt,
        validUntil,
        capabilityDigest,
      ]),
    ),
  );
  const inventoryBytes = await encodeHnsAuthorityInventory({
    version: HNS_AUTHORITY_INVENTORY_VERSION,
    authority_inventory_reference: `hns-authority:${input.request.root_label}`,
    authority_inventory_version: `readiness-${inventoryIdentity}`,
    environment: input.config.environment,
    completeness: "complete",
    runtime_capability_set_digest: capabilityDigest,
    published_at: observedAt,
    expires_at: validUntil,
    authoritative_nameserver_glue: nameserverGlue,
    dns_write_capabilities: dnsWriteCapabilities,
  });
  const inventory = await decodeHnsAuthorityInventoryBytes(inventoryBytes);
  const chainBytes = encoder.encode(canonicalJson(chainRecords));
  const keysetBytes = encoder.encode(canonicalJson(zone.ds_records));
  const observedZoneBytes = primaryView.observed_zone_bytes;
  return encodeHnsRootImportReadinessResultV1({
    version: HNS_ROOT_IMPORT_READINESS_RESULT_VERSION,
    root_import_session_id: input.request.root_import_session_id,
    namespace_session_id: input.request.namespace_session_id,
    root_label: input.request.root_label,
    ownership_result_sha256: input.request.ownership_result_sha256,
    publish_plan_sha256: input.request.publish_plan_sha256,
    provision_result_sha256: input.request.provision_result_sha256,
    chain_resource_sha256: await sha256(chainBytes),
    powerdns_zone_serial: zone.serial,
    managed_rrset_sha256: zone.managed_rrset_sha256,
    managed_zone_bytes_hex: hex(observedZoneBytes),
    observed_zone_bytes_sha256: primaryView.observed_zone_sha256,
    shared_tlsa_profile_sha256: zone.shared_tlsa_profile_sha256,
    ds_records: zone.ds_records,
    dns_authority_reference: capabilityReference,
    dnssec_keyset_reference: `pdns-keyset:${input.request.root_label}`,
    dnssec_keyset_version: await sha256(keysetBytes),
    gateway_deployment_reference: zone.gateway_deployment_reference,
    gateway_certificate_spki_sha256: zone.gateway_certificate_spki_sha256,
    gateway_http_status: live.gateway.http_status,
    authority_views: [
      {
        authority_nameserver: "ns1.pirate",
        authority_address_family: primaryView.authority_address_family,
        authority_address: primaryView.authority_address,
        dnssec_validation: primaryView.dnssec_validation,
        challenge_present: primaryView.challenge_present,
        validated_dnskey_response_sha256: primaryView.validated_dnskey_response_sha256,
        validated_control_response_sha256: primaryView.validated_control_response_sha256,
        validated_chain_authority_digest: primaryView.validated_chain_authority_digest,
        observed_zone_sha256: primaryView.observed_zone_sha256,
      },
      {
        authority_nameserver: "ns2.pirate",
        authority_address_family: secondaryView.authority_address_family,
        authority_address: secondaryView.authority_address,
        dnssec_validation: secondaryView.dnssec_validation,
        challenge_present: secondaryView.challenge_present,
        validated_dnskey_response_sha256: secondaryView.validated_dnskey_response_sha256,
        validated_control_response_sha256: secondaryView.validated_control_response_sha256,
        validated_chain_authority_digest: secondaryView.validated_chain_authority_digest,
        observed_zone_sha256: secondaryView.observed_zone_sha256,
      },
    ],
    delegation_matches: true,
    ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_healthy: true,
    authority_inventory_reference: inventory.inventory.authority_inventory_reference,
    authority_inventory_version: inventory.inventory.authority_inventory_version,
    authority_inventory_digest: inventory.inventory_digest,
    authority_inventory_bytes_hex: hex(inventoryBytes),
    observed_at: observedAt,
    valid_until: validUntil,
  });
}
