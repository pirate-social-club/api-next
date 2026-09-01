import {
  buildHnsRootImportPublishPlanV1,
  decodeStrictHnsJsonBytes,
  type HnsRootDelegationDsV1,
  type HnsRootResourceRecordV1,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson, validCommunityRouteRoot } from "@pirate/domain";

export const HNS_AUTHORITY_PROVISION_REQUEST_VERSION = "pirate-hns-authority-provision-request-v1";
export const HNS_AUTHORITY_PROVISION_RESULT_VERSION = "pirate-hns-authority-provision-result-v1";
export const HNS_AUTHORITY_NAMESERVERS = ["ns1.pirate.", "ns2.pirate."] as const;

export type HnsAuthorityProvisionRequestV1 = Readonly<{
  readonly version: typeof HNS_AUTHORITY_PROVISION_REQUEST_VERSION;
  readonly root_import_session_id: string;
  readonly namespace_session_id: string;
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly expires_at: string;
}>;

export type HnsAuthorityZoneResult = Readonly<{
  readonly created: boolean;
  readonly dnssec: true;
  readonly serial: number;
  readonly ds_records: readonly HnsRootDelegationDsV1[];
  readonly managed_rrset_sha256: string;
  readonly managed_zone_bytes: Uint8Array;
  readonly shared_tlsa_profile_sha256: string;
  readonly gateway_ipv4: string;
  readonly gateway_deployment_reference: string;
  readonly gateway_certificate_spki_sha256: string;
  readonly ttl_seconds: number;
}>;

export type HnsAuthorityProvisionPorts = Readonly<{
  readonly inspect_current_resource: (
    rootLabel: string,
  ) => Promise<readonly HnsRootResourceRecordV1[]>;
  readonly ensure_zone: (input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
  }) => Promise<HnsAuthorityZoneResult>;
}>;

export type HnsAuthorityProvisionOutput = Readonly<{
  readonly publish_plan_bytes: Uint8Array;
  readonly publish_plan_sha256: string;
  readonly result_bytes: Uint8Array;
  readonly result_sha256: string;
}>;

export class HnsAuthorityProvisionError extends Error {
  override readonly name = "HnsAuthorityProvisionError";

  constructor(
    readonly code:
      | "invalid_request"
      | "root_unavailable"
      | "authority_unavailable"
      | "invalid_authority_result",
  ) {
    super(code);
  }
}

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes).buffer)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    encoder.encode(value).byteLength >= 1 &&
    encoder.encode(value).byteLength <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    })
  );
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const ordered = [...expected].sort();
  return actual.length === ordered.length && actual.every((key, index) => key === ordered[index]);
}

export function decodeHnsAuthorityProvisionRequestV1(
  bytes: Uint8Array,
): HnsAuthorityProvisionRequestV1 {
  let decoded: unknown;
  try {
    decoded = decodeStrictHnsJsonBytes(bytes, 65_536);
  } catch {
    throw new HnsAuthorityProvisionError("invalid_request");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new HnsAuthorityProvisionError("invalid_request");
  }
  const record = decoded as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "version",
      "root_import_session_id",
      "namespace_session_id",
      "root_label",
      "challenge_txt_value",
      "expires_at",
    ]) ||
    record.version !== HNS_AUTHORITY_PROVISION_REQUEST_VERSION ||
    !boundedId(record.root_import_session_id) ||
    !boundedId(record.namespace_session_id) ||
    typeof record.root_label !== "string" ||
    !validCommunityRouteRoot("hns", record.root_label) ||
    typeof record.challenge_txt_value !== "string" ||
    !record.challenge_txt_value.startsWith("pirate-verification=") ||
    record.challenge_txt_value.length === "pirate-verification=".length ||
    encoder.encode(record.challenge_txt_value).byteLength > 16_448 ||
    !canonicalInstant(record.expires_at)
  ) {
    throw new HnsAuthorityProvisionError("invalid_request");
  }
  return record as HnsAuthorityProvisionRequestV1;
}

export async function provisionHnsAuthorityRootV1(
  request: HnsAuthorityProvisionRequestV1,
  ports: HnsAuthorityProvisionPorts,
): Promise<HnsAuthorityProvisionOutput> {
  let currentRecords: readonly HnsRootResourceRecordV1[];
  try {
    currentRecords = validateHnsRootResourceRecordsV1(
      await ports.inspect_current_resource(request.root_label),
    );
  } catch (error) {
    if (error instanceof HnsAuthorityProvisionError) throw error;
    throw new HnsAuthorityProvisionError("root_unavailable");
  }
  let zone: HnsAuthorityZoneResult;
  try {
    zone = await ports.ensure_zone({
      root_label: request.root_label,
      challenge_txt_value: request.challenge_txt_value,
    });
  } catch (error) {
    if (error instanceof HnsAuthorityProvisionError) throw error;
    throw new HnsAuthorityProvisionError("authority_unavailable");
  }
  if (
    zone.dnssec !== true ||
    !Number.isSafeInteger(zone.serial) ||
    zone.serial <= 0 ||
    !/^[0-9a-f]{64}$/u.test(zone.managed_rrset_sha256) ||
    (await sha256(zone.managed_zone_bytes)) !== zone.managed_rrset_sha256 ||
    !/^[0-9a-f]{64}$/u.test(zone.shared_tlsa_profile_sha256) ||
    !/^[0-9a-f]{64}$/u.test(zone.gateway_certificate_spki_sha256) ||
    !boundedId(zone.gateway_deployment_reference) ||
    !Number.isSafeInteger(zone.ttl_seconds) ||
    zone.ttl_seconds < 60 ||
    zone.ttl_seconds > 86_400
  ) {
    throw new HnsAuthorityProvisionError("invalid_authority_result");
  }
  let plan: ReturnType<typeof buildHnsRootImportPublishPlanV1>;
  try {
    plan = buildHnsRootImportPublishPlanV1({
      current_records: currentRecords,
      challenge_txt_value: request.challenge_txt_value,
      ds_records: zone.ds_records,
    });
  } catch {
    throw new HnsAuthorityProvisionError("invalid_authority_result");
  }
  const publishPlanBytes = encoder.encode(canonicalJson(plan));
  const resultBytes = encoder.encode(
    canonicalJson({
      version: HNS_AUTHORITY_PROVISION_RESULT_VERSION,
      root_import_session_id: request.root_import_session_id,
      root_label: request.root_label,
      nameservers: HNS_AUTHORITY_NAMESERVERS,
      zone_created: zone.created,
      zone_dnssec: true,
      zone_serial: zone.serial,
      ds_records: zone.ds_records,
      managed_rrset_sha256: zone.managed_rrset_sha256,
      shared_tlsa_profile_sha256: zone.shared_tlsa_profile_sha256,
      gateway_ipv4: zone.gateway_ipv4,
      gateway_deployment_reference: zone.gateway_deployment_reference,
      gateway_certificate_spki_sha256: zone.gateway_certificate_spki_sha256,
      ttl_seconds: zone.ttl_seconds,
    }),
  );
  return {
    publish_plan_bytes: publishPlanBytes,
    publish_plan_sha256: await sha256(publishPlanBytes),
    result_bytes: resultBytes,
    result_sha256: await sha256(resultBytes),
  };
}
