import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";
import {
  decodeHnsAuthorityInventoryBytes,
  type HnsAuthorityInventoryV1,
} from "./hns-authority-inventory.ts";
import { decodeStrictHnsJsonBytes } from "./hns-evidence.ts";
import type { HnsRootDelegationDsV1 } from "./hns-root-import-plan.ts";

export const HNS_ROOT_IMPORT_READINESS_RESULT_VERSION =
  "pirate-hns-root-import-readiness-result-v1" as const;

export type HnsRootImportAuthorityViewV1 = Readonly<{
  readonly authority_nameserver: "ns1.pirate" | "ns2.pirate";
  readonly authority_address_family: "GLUE4" | "GLUE6";
  readonly authority_address: string;
  readonly dnssec_validation: "secure";
  readonly challenge_present: true;
  readonly validated_dnskey_response_sha256: string;
  readonly validated_control_response_sha256: string;
  readonly validated_chain_authority_digest: string;
  readonly observed_zone_sha256: string;
}>;

export type HnsRootImportReadinessResultV1 = Readonly<{
  readonly version: typeof HNS_ROOT_IMPORT_READINESS_RESULT_VERSION;
  readonly root_import_session_id: string;
  readonly namespace_session_id: string;
  readonly root_label: string;
  readonly ownership_result_sha256: string;
  readonly publish_plan_sha256: string;
  readonly provision_result_sha256: string;
  readonly chain_resource_sha256: string;
  readonly powerdns_zone_serial: number;
  readonly managed_rrset_sha256: string;
  readonly managed_zone_bytes_hex: string;
  readonly observed_zone_bytes_sha256: string;
  readonly shared_tlsa_profile_sha256: string;
  readonly ds_records: readonly HnsRootDelegationDsV1[];
  readonly dns_authority_reference: string;
  readonly dnssec_keyset_reference: string;
  readonly dnssec_keyset_version: string;
  readonly gateway_deployment_reference: string;
  readonly gateway_certificate_spki_sha256: string;
  readonly gateway_http_status: 200 | 421;
  readonly authority_views: readonly [HnsRootImportAuthorityViewV1, HnsRootImportAuthorityViewV1];
  readonly delegation_matches: true;
  readonly ds_authenticates_zone: true;
  readonly retained_zone_digest_matches: true;
  readonly gateway_healthy: true;
  readonly authority_inventory_reference: string;
  readonly authority_inventory_version: string;
  readonly authority_inventory_digest: string;
  readonly authority_inventory_bytes_hex: string;
  readonly observed_at: string;
  readonly valid_until: string;
}>;

export type HnsRootImportReadinessArtifactV1 = Readonly<{
  readonly result: HnsRootImportReadinessResultV1;
  readonly result_bytes: Uint8Array;
  readonly result_sha256: string;
  readonly authority_inventory: HnsAuthorityInventoryV1;
  readonly authority_inventory_bytes: Uint8Array;
  readonly managed_zone_bytes: Uint8Array;
}>;

const encoder = new TextEncoder();

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedId(value: unknown, maximumBytes = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    encoder.encode(value).byteLength <= maximumBytes &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
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

function bytesFromHex(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^([0-9a-f]{2})+$/u.test(value)) {
    throw new TypeError("HNS root readiness inventory bytes are invalid");
  }
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function validDsRecords(value: unknown): value is readonly HnsRootDelegationDsV1[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32 || value.length % 2 !== 0) {
    return false;
  }
  const identities = new Map<string, Set<number>>();
  const seen = new Set<string>();
  for (const entry of value) {
    if (!exactObject(entry, ["key_tag", "algorithm", "digest_type", "digest"])) return false;
    const digestLength = entry.digest_type === 2 ? 64 : entry.digest_type === 4 ? 96 : 0;
    if (
      !Number.isSafeInteger(entry.key_tag) ||
      Number(entry.key_tag) < 0 ||
      Number(entry.key_tag) > 65_535 ||
      !Number.isSafeInteger(entry.algorithm) ||
      Number(entry.algorithm) < 0 ||
      Number(entry.algorithm) > 255 ||
      digestLength === 0 ||
      typeof entry.digest !== "string" ||
      entry.digest.length !== digestLength ||
      !/^[0-9a-f]+$/u.test(entry.digest)
    ) {
      return false;
    }
    const encoded = JSON.stringify(entry);
    if (seen.has(encoded)) return false;
    seen.add(encoded);
    const identity = `${String(entry.key_tag)}:${String(entry.algorithm)}`;
    const digestTypes = identities.get(identity) ?? new Set<number>();
    digestTypes.add(Number(entry.digest_type));
    identities.set(identity, digestTypes);
  }
  return [...identities.values()].every(
    (digestTypes) => digestTypes.size === 2 && digestTypes.has(2) && digestTypes.has(4),
  );
}

const authorityViewKeys = [
  "authority_nameserver",
  "authority_address_family",
  "authority_address",
  "dnssec_validation",
  "challenge_present",
  "validated_dnskey_response_sha256",
  "validated_control_response_sha256",
  "validated_chain_authority_digest",
  "observed_zone_sha256",
] as const;

function validAuthorityViews(
  value: unknown,
): value is readonly [HnsRootImportAuthorityViewV1, HnsRootImportAuthorityViewV1] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const expectedNameservers = ["ns1.pirate", "ns2.pirate"];
  return value.every((entry, index) => {
    if (!exactObject(entry, authorityViewKeys)) return false;
    return (
      entry.authority_nameserver === expectedNameservers[index] &&
      (entry.authority_address_family === "GLUE4" || entry.authority_address_family === "GLUE6") &&
      boundedId(entry.authority_address, 45) &&
      entry.dnssec_validation === "secure" &&
      entry.challenge_present === true &&
      hash(entry.validated_dnskey_response_sha256) &&
      hash(entry.validated_control_response_sha256) &&
      hash(entry.validated_chain_authority_digest) &&
      hash(entry.observed_zone_sha256)
    );
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const resultKeys = [
  "version",
  "root_import_session_id",
  "namespace_session_id",
  "root_label",
  "ownership_result_sha256",
  "publish_plan_sha256",
  "provision_result_sha256",
  "chain_resource_sha256",
  "powerdns_zone_serial",
  "managed_rrset_sha256",
  "managed_zone_bytes_hex",
  "observed_zone_bytes_sha256",
  "shared_tlsa_profile_sha256",
  "ds_records",
  "dns_authority_reference",
  "dnssec_keyset_reference",
  "dnssec_keyset_version",
  "gateway_deployment_reference",
  "gateway_certificate_spki_sha256",
  "gateway_http_status",
  "authority_views",
  "delegation_matches",
  "ds_authenticates_zone",
  "retained_zone_digest_matches",
  "gateway_healthy",
  "authority_inventory_reference",
  "authority_inventory_version",
  "authority_inventory_digest",
  "authority_inventory_bytes_hex",
  "observed_at",
  "valid_until",
] as const;

export async function decodeHnsRootImportReadinessResultV1(
  value: Uint8Array,
): Promise<HnsRootImportReadinessArtifactV1> {
  const resultBytes = new Uint8Array(value);
  const decoded = decodeStrictHnsJsonBytes(resultBytes, 1_048_576);
  if (
    !exactObject(decoded, resultKeys) ||
    decoded.version !== HNS_ROOT_IMPORT_READINESS_RESULT_VERSION ||
    !boundedId(decoded.root_import_session_id) ||
    !boundedId(decoded.namespace_session_id) ||
    typeof decoded.root_label !== "string" ||
    !validCommunityRouteRoot("hns", decoded.root_label) ||
    !hash(decoded.ownership_result_sha256) ||
    !hash(decoded.publish_plan_sha256) ||
    !hash(decoded.provision_result_sha256) ||
    !hash(decoded.chain_resource_sha256) ||
    !Number.isSafeInteger(decoded.powerdns_zone_serial) ||
    Number(decoded.powerdns_zone_serial) <= 0 ||
    !hash(decoded.managed_rrset_sha256) ||
    !hash(decoded.observed_zone_bytes_sha256) ||
    !hash(decoded.shared_tlsa_profile_sha256) ||
    !validDsRecords(decoded.ds_records) ||
    !boundedId(decoded.dns_authority_reference) ||
    !boundedId(decoded.dnssec_keyset_reference) ||
    !boundedId(decoded.dnssec_keyset_version) ||
    !boundedId(decoded.gateway_deployment_reference) ||
    !hash(decoded.gateway_certificate_spki_sha256) ||
    (decoded.gateway_http_status !== 200 && decoded.gateway_http_status !== 421) ||
    !validAuthorityViews(decoded.authority_views) ||
    decoded.delegation_matches !== true ||
    decoded.ds_authenticates_zone !== true ||
    decoded.retained_zone_digest_matches !== true ||
    decoded.gateway_healthy !== true ||
    !boundedId(decoded.authority_inventory_reference) ||
    !boundedId(decoded.authority_inventory_version) ||
    !hash(decoded.authority_inventory_digest) ||
    !instant(decoded.observed_at) ||
    !instant(decoded.valid_until) ||
    Date.parse(decoded.valid_until) <= Date.parse(decoded.observed_at)
  ) {
    throw new TypeError("HNS root readiness result is invalid");
  }
  const inventoryBytes = bytesFromHex(decoded.authority_inventory_bytes_hex);
  const managedZoneBytes = bytesFromHex(decoded.managed_zone_bytes_hex);
  const inventory = await decodeHnsAuthorityInventoryBytes(inventoryBytes);
  const authorityViews = decoded.authority_views as readonly HnsRootImportAuthorityViewV1[];
  if (
    (await sha256(managedZoneBytes)) !== decoded.observed_zone_bytes_sha256 ||
    authorityViews.some(
      (view) => view.observed_zone_sha256 !== decoded.observed_zone_bytes_sha256,
    ) ||
    authorityViews[0]?.validated_chain_authority_digest !==
      authorityViews[1]?.validated_chain_authority_digest ||
    inventory.inventory.authoritative_nameserver_glue.length !== authorityViews.length ||
    inventory.inventory.authoritative_nameserver_glue.some((entry, index) => {
      const view = authorityViews[index];
      return (
        view === undefined ||
        entry.active !== true ||
        entry.authority_nameserver !== view.authority_nameserver ||
        entry.authority_address_family !== view.authority_address_family ||
        entry.authority_address !== view.authority_address
      );
    }) ||
    inventory.inventory_digest !== decoded.authority_inventory_digest ||
    inventory.inventory.authority_inventory_reference !== decoded.authority_inventory_reference ||
    inventory.inventory.authority_inventory_version !== decoded.authority_inventory_version ||
    inventory.inventory.published_at !== decoded.observed_at ||
    inventory.inventory.expires_at !== decoded.valid_until ||
    !inventory.inventory.dns_write_capabilities.some(
      (capability) => capability.root_label === decoded.root_label && capability.active,
    )
  ) {
    throw new TypeError("HNS root readiness inventory does not match its result");
  }
  return {
    result: decoded as HnsRootImportReadinessResultV1,
    result_bytes: resultBytes,
    result_sha256: await sha256(resultBytes),
    authority_inventory: inventory.inventory,
    authority_inventory_bytes: inventoryBytes,
    managed_zone_bytes: managedZoneBytes,
  };
}

export async function encodeHnsRootImportReadinessResultV1(
  input: HnsRootImportReadinessResultV1,
): Promise<HnsRootImportReadinessArtifactV1> {
  return decodeHnsRootImportReadinessResultV1(encoder.encode(canonicalJson(input)));
}
