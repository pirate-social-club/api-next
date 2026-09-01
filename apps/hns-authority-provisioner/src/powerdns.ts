import type { HnsRootDelegationDsV1 } from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { HNS_AUTHORITY_NAMESERVERS, type HnsAuthorityZoneResult } from "./provision-root.ts";

export type PowerDnsFetch = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PowerDnsRootProvisionConfig = Readonly<{
  readonly api_url: string;
  readonly api_key: string;
  readonly server_id: string;
  readonly soa_content: string;
  readonly axfr_tsig_key_name: string;
  readonly gateway_ipv4: string;
  readonly shared_tlsa_association: string;
  readonly gateway_deployment_reference: string;
  readonly gateway_certificate_spki_sha256: string;
  readonly ttl_seconds: number;
}>;

export type PowerDnsRrset = Readonly<{
  readonly name: string;
  readonly type: string;
  readonly ttl: number;
  readonly changetype: "REPLACE";
  readonly records: readonly Readonly<{ readonly content: string; readonly disabled: false }>[];
}>;

type ApiZone = Readonly<{
  readonly name?: unknown;
  readonly serial?: unknown;
  readonly dnssec?: unknown;
  readonly rrsets?: unknown;
}>;

type ApiCryptokey = Readonly<{
  readonly active?: unknown;
  readonly published?: unknown;
  readonly ds?: unknown;
}>;

const responseMaxBytes = 1_048_576;
const requestTimeoutMs = 5_000;

function canonicalName(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

function escapeTxt(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function rrset(name: string, type: string, ttl: number, records: readonly string[]): PowerDnsRrset {
  return {
    name: canonicalName(name),
    type,
    ttl,
    changetype: "REPLACE",
    records: records.map((content) => ({ content, disabled: false })),
  };
}

export function buildManagedRootRrsets(input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly gateway_ipv4: string;
  readonly shared_tlsa_association: string;
  readonly ttl_seconds: number;
}): readonly PowerDnsRrset[] {
  const zone = canonicalName(input.root_label);
  return [
    rrset(zone, "NS", input.ttl_seconds, HNS_AUTHORITY_NAMESERVERS),
    rrset(zone, "A", input.ttl_seconds, [input.gateway_ipv4]),
    rrset(`app.${zone}`, "A", input.ttl_seconds, [input.gateway_ipv4]),
    rrset(`*.${zone}`, "A", input.ttl_seconds, [input.gateway_ipv4]),
    rrset(`_pirate.${zone}`, "TXT", input.ttl_seconds, [escapeTxt(input.challenge_txt_value)]),
    rrset(`_443._tcp.${zone}`, "TLSA", input.ttl_seconds, [input.shared_tlsa_association]),
    rrset(`*.${zone}`, "TLSA", input.ttl_seconds, [input.shared_tlsa_association]),
    rrset(`_443._tcp.app.${zone}`, "TLSA", input.ttl_seconds, [input.shared_tlsa_association]),
  ];
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > responseMaxBytes) throw new Error("PowerDNS response exceeded byte limit");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function parseDs(value: string): HnsRootDelegationDsV1 | null {
  const parts = value.trim().split(/\s+/u);
  if (parts.length !== 4) throw new Error("PowerDNS returned invalid DS data");
  const keyTag = Number(parts[0]);
  const algorithm = Number(parts[1]);
  const digestType = Number(parts[2]);
  const digest = parts[3]?.toLowerCase() ?? "";
  const digestLength = digestType === 1 ? 40 : digestType === 2 ? 64 : digestType === 4 ? 96 : 0;
  if (
    !Number.isSafeInteger(keyTag) ||
    keyTag < 0 ||
    keyTag > 65_535 ||
    !Number.isSafeInteger(algorithm) ||
    algorithm < 0 ||
    algorithm > 255 ||
    digestLength === 0 ||
    digest.length !== digestLength ||
    !/^[0-9a-f]+$/u.test(digest)
  ) {
    throw new Error("PowerDNS returned invalid DS data");
  }
  if (digestType === 1) return null;
  return {
    key_tag: keyTag,
    algorithm,
    digest_type: digestType as 2 | 4,
    digest,
  };
}

function retainedDsRecords(values: readonly string[]): readonly HnsRootDelegationDsV1[] {
  return [...new Set(values)]
    .flatMap((value) => {
      const parsed = parseDs(value);
      return parsed === null ? [] : [parsed];
    })
    .sort(
      (left, right) =>
        left.key_tag - right.key_tag ||
        left.algorithm - right.algorithm ||
        left.digest_type - right.digest_type,
    );
}

function parseZone(
  value: unknown,
  expectedName: string,
): { readonly serial: number; readonly dnssec: boolean } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PowerDNS returned invalid zone data");
  }
  const zone = value as ApiZone;
  if (
    zone.name !== expectedName ||
    typeof zone.serial !== "number" ||
    !Number.isSafeInteger(zone.serial) ||
    zone.serial < 0 ||
    typeof zone.dnssec !== "boolean"
  ) {
    throw new Error("PowerDNS returned invalid zone data");
  }
  return { serial: zone.serial, dnssec: zone.dnssec };
}

function retainedManagedRrsets(value: unknown, expected: readonly PowerDnsRrset[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PowerDNS returned invalid zone data");
  }
  const rrsets = (value as ApiZone).rrsets;
  if (!Array.isArray(rrsets)) throw new Error("PowerDNS retained rrsets are unavailable");
  for (const wanted of expected) {
    const selected = rrsets.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        Reflect.get(candidate, "name") === wanted.name &&
        Reflect.get(candidate, "type") === wanted.type,
    );
    if (selected.length !== 1) throw new Error("PowerDNS managed rrset is unavailable");
    const actual = selected[0] as Record<string, unknown>;
    if (actual.ttl !== wanted.ttl || !Array.isArray(actual.records)) {
      throw new Error("PowerDNS managed rrset does not match");
    }
    const contents = actual.records.map((record) =>
      record !== null && typeof record === "object" && !Array.isArray(record)
        ? [Reflect.get(record, "content"), Reflect.get(record, "disabled")]
        : null,
    );
    if (
      JSON.stringify(contents) !==
      JSON.stringify(wanted.records.map((record) => [record.content, record.disabled]))
    ) {
      throw new Error("PowerDNS managed rrset does not match");
    }
  }
}

async function zoneResult(
  config: PowerDnsRootProvisionConfig,
  input: Readonly<{ readonly root_label: string; readonly challenge_txt_value: string }>,
  zone: Readonly<{ readonly serial: number; readonly dnssec: boolean }>,
  dsRecords: readonly HnsRootDelegationDsV1[],
  created: boolean,
): Promise<HnsAuthorityZoneResult> {
  if (!zone.dnssec) throw new Error("PowerDNS retained zone is not DNSSEC-enabled");
  const managed = buildManagedRootRrsets({ ...input, ...config });
  const managedBytes = new TextEncoder().encode(canonicalJson(managed));
  const tlsaBytes = new TextEncoder().encode(config.shared_tlsa_association);
  const [managedDigest, tlsaDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", Uint8Array.from(managedBytes).buffer),
    crypto.subtle.digest("SHA-256", Uint8Array.from(tlsaBytes).buffer),
  ]);
  const hex = (digest: ArrayBuffer) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    created,
    dnssec: true,
    serial: zone.serial,
    ds_records: dsRecords,
    managed_rrset_sha256: hex(managedDigest),
    managed_zone_bytes: managedBytes,
    shared_tlsa_profile_sha256: hex(tlsaDigest),
    gateway_ipv4: config.gateway_ipv4,
    gateway_deployment_reference: config.gateway_deployment_reference,
    gateway_certificate_spki_sha256: config.gateway_certificate_spki_sha256,
    ttl_seconds: config.ttl_seconds,
  };
}

export function makePowerDnsRootProvisioner(
  config: PowerDnsRootProvisionConfig,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
}) => Promise<HnsAuthorityZoneResult> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0 ||
    config.soa_content.trim().length === 0 ||
    config.axfr_tsig_key_name.trim().length === 0 ||
    config.gateway_deployment_reference.trim().length === 0 ||
    !/^[0-9a-f]{64}$/u.test(config.gateway_certificate_spki_sha256)
  ) {
    throw new Error("PowerDNS root provisioner configuration is invalid");
  }
  const apiUrl = config.api_url.replace(/\/+$/u, "");
  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly response: Response; readonly json: unknown }> => {
    const response = await fetcher(`${apiUrl}/api/v1${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept: "application/json",
        "x-api-key": config.api_key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await readBoundedJson(response);
    return { response, json };
  };
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const managed = buildManagedRootRrsets({ ...input, ...config });
    const existingResponse = await request("GET", zonePath);
    let created = false;
    let existing: { readonly serial: number; readonly dnssec: boolean } | null;
    if (existingResponse.response.status === 404) {
      existing = null;
    } else {
      if (!existingResponse.response.ok) throw new Error("PowerDNS zone inspection failed");
      existing = parseZone(existingResponse.json, zoneName);
    }
    if (existing === null) {
      const create = await request(
        "POST",
        `/servers/${encodeURIComponent(config.server_id)}/zones`,
        {
          name: zoneName,
          kind: "Master",
          soa_edit_api: "DEFAULT",
          dnssec: true,
          api_rectify: true,
          rrsets: [rrset(zoneName, "SOA", config.ttl_seconds, [config.soa_content]), ...managed],
        },
      );
      if (create.response.status === 409) {
        const raced = await request("GET", zonePath);
        if (!raced.response.ok) throw new Error("PowerDNS zone creation race could not converge");
        existing = parseZone(raced.json, zoneName);
      } else {
        if (!create.response.ok) throw new Error("PowerDNS zone creation failed");
        created = true;
      }
    }
    if (!created) {
      if (existing?.dnssec !== true)
        throw new Error("PowerDNS existing zone is not DNSSEC-enabled");
      const patch = await request("PATCH", zonePath, { rrsets: managed });
      if (!patch.response.ok) throw new Error("PowerDNS zone reconciliation failed");
    }
    const metadata = await request("PUT", `${zonePath}/metadata/TSIG-ALLOW-AXFR`, {
      kind: "TSIG-ALLOW-AXFR",
      metadata: [config.axfr_tsig_key_name],
    });
    if (!metadata.response.ok) throw new Error("PowerDNS AXFR authorization failed");
    const rectify = await request("PUT", `${zonePath}/rectify`);
    if (!rectify.response.ok) throw new Error("PowerDNS DNSSEC rectification failed");
    const notify = await request("PUT", `${zonePath}/notify`);
    if (!notify.response.ok) throw new Error("PowerDNS secondary notification failed");
    const retained = await request("GET", zonePath);
    if (!retained.response.ok) throw new Error("PowerDNS retained zone inspection failed");
    const zone = parseZone(retained.json, zoneName);
    if (!zone.dnssec) throw new Error("PowerDNS retained zone is not DNSSEC-enabled");
    const cryptokeys = await request("GET", `${zonePath}/cryptokeys`);
    if (!cryptokeys.response.ok || !Array.isArray(cryptokeys.json)) {
      throw new Error("PowerDNS DNSSEC key inspection failed");
    }
    const dsRecords = (cryptokeys.json as readonly ApiCryptokey[])
      .filter((key) => key.active !== false && key.published !== false)
      .flatMap((key) => (Array.isArray(key.ds) ? key.ds : []));
    if (!dsRecords.every((value): value is string => typeof value === "string")) {
      throw new Error("PowerDNS returned invalid DS data");
    }
    const parsedDs = retainedDsRecords(dsRecords);
    return zoneResult(config, input, zone, parsedDs, created);
  };
}

/** Idempotently removes only a zone that this import session reported creating. */
export function makePowerDnsRootTeardown(
  config: Pick<PowerDnsRootProvisionConfig, "api_url" | "api_key" | "server_id">,
  fetcher: PowerDnsFetch = fetch,
): (input: { readonly root_label: string }) => Promise<void> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0
  ) {
    throw new Error("PowerDNS root teardown configuration is invalid");
  }
  const apiUrl = config.api_url.replace(/\/+$/u, "");
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const response = await fetcher(
      `${apiUrl}/api/v1/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`,
      {
        method: "DELETE",
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { accept: "application/json", "x-api-key": config.api_key },
      },
    );
    await readBoundedJson(response);
    if (response.status !== 404 && !response.ok) {
      throw new Error("PowerDNS zone teardown failed");
    }
  };
}

/** Read-only reconciliation used after the owner broadcasts the replacement resource. */
export function makePowerDnsRootInspector(
  config: PowerDnsRootProvisionConfig,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
}) => Promise<HnsAuthorityZoneResult> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0 ||
    config.gateway_deployment_reference.trim().length === 0 ||
    !/^[0-9a-f]{64}$/u.test(config.gateway_certificate_spki_sha256)
  ) {
    throw new Error("PowerDNS root inspector configuration is invalid");
  }
  const apiUrl = config.api_url.replace(/\/+$/u, "");
  const request = async (path: string): Promise<unknown> => {
    const response = await fetcher(`${apiUrl}/api/v1${path}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { accept: "application/json", "x-api-key": config.api_key },
    });
    if (!response.ok) throw new Error("PowerDNS authority inspection failed");
    return readBoundedJson(response);
  };
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const retained = await request(zonePath);
    const zone = parseZone(retained, zoneName);
    retainedManagedRrsets(retained, buildManagedRootRrsets({ ...input, ...config }));
    const cryptokeys = await request(`${zonePath}/cryptokeys`);
    if (!Array.isArray(cryptokeys)) throw new Error("PowerDNS DNSSEC key inspection failed");
    const dsRecords = (cryptokeys as readonly ApiCryptokey[])
      .filter((key) => key.active !== false && key.published !== false)
      .flatMap((key) => (Array.isArray(key.ds) ? key.ds : []));
    if (!dsRecords.every((value): value is string => typeof value === "string")) {
      throw new Error("PowerDNS returned invalid DS data");
    }
    return zoneResult(config, input, zone, retainedDsRecords(dsRecords), false);
  };
}
