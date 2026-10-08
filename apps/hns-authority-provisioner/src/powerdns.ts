import type {
  HnsRootDelegationDsV1,
  HnsRootImportGlueRecordV1,
  HnsRootImportNameserversV1,
  HnsRootResourceRecordV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { HNS_AUTHORITY_NAMESERVERS, type HnsAuthorityZoneResult } from "./provision-root.ts";

export type PowerDnsFetch = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PowerDnsRootProvisionConfig = Readonly<{
  readonly nameservers?: HnsRootImportNameserversV1;
  readonly glue_records?: readonly HnsRootImportGlueRecordV1[];
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
  readonly account?: unknown;
}>;

type ApiCryptokey = Readonly<{
  readonly active?: unknown;
  readonly published?: unknown;
  readonly ds?: unknown;
}>;

const responseMaxBytes = 1_048_576;
const requestTimeoutMs = 5_000;

/**
 * Runs one PowerDNS exchange, request and body read together, under an
 * ordinary timer. `AbortSignal.timeout` alone did not keep the serve loop
 * alive: a read-back that never settled let Bun drain its event loop and exit
 * 0 in the middle of a provisioning job. This timer is referenced, so a stall
 * rejects, the job retries, and the failure is logged.
 */
export async function withExchangeDeadline<T>(
  exchange: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("PowerDNS request timed out"));
    }, requestTimeoutMs);
  });
  try {
    return await Promise.race([exchange(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    // Clearing the timer removed the only other abort. An exchange that
    // failed before reading its body (an error status, or a body over the
    // limit) would otherwise leave that response holding a pooled socket.
    // After a completed read this does nothing.
    controller.abort();
  }
}

export async function reservationAccount(challenge: string): Promise<string> {
  const reservationDigest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(challenge),
  );
  // PowerDNS SQL backends retain a forty-character account field.
  return [...new Uint8Array(reservationDigest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

export function canonicalName(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

export function escapeTxt(value: string): string {
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

/**
 * The record sets a root's zone is managed to.
 *
 * `wildcard-v1` answers member names from a wildcard A and TLSA only. A
 * Handshake client in use rejects the wildcard no-data answers that leaves for
 * AAAA and HTTPS, so `wildcard-address-family-v2` adds a wildcard AAAA and a
 * wildcard HTTPS record set and every type that client asks for gets a
 * positive wildcard answer. The AAAA is the IPv4-mapped form of the gateway
 * address, so the gateway needs no IPv6 address of its own.
 *
 * A root keeps the profile its provision result recorded: the managed digest
 * is bound into that result, and an activated root's retained zone is frozen
 * between authority successors. A zone gets the newer profile when this code
 * creates it, or when a root is imported again over an existing zone, where
 * the new session's reconciliation rewrites the managed record sets anyway.
 */
const HNS_MANAGED_RECORD_PROFILES = ["wildcard-v1", "wildcard-address-family-v2"] as const;
export type HnsManagedRecordProfile = (typeof HNS_MANAGED_RECORD_PROFILES)[number];
export const HNS_MANAGED_RECORD_PROFILE_FOR_NEW_ZONES: HnsManagedRecordProfile =
  "wildcard-address-family-v2";
/** Service mode with the owner as its own target: clients keep the name's own addresses. */
const WILDCARD_HTTPS_CONTENT = "1 . alpn=h2,http/1.1";

export function buildManagedRootRrsets(
  input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
    readonly gateway_ipv4: string;
    readonly shared_tlsa_association: string;
    readonly ttl_seconds: number;
    readonly nameservers?: HnsRootImportNameserversV1;
    readonly glue_records?: readonly HnsRootImportGlueRecordV1[];
  },
  profile: HnsManagedRecordProfile = "wildcard-v1",
): readonly PowerDnsRrset[] {
  const zone = canonicalName(input.root_label);
  const inBailiwickAddresses = (input.glue_records ?? [])
    .filter((record) => record.ns.endsWith(`.${zone}`))
    .map((record) =>
      rrset(record.ns, record.type === "GLUE4" ? "A" : "AAAA", input.ttl_seconds, [record.address]),
    );
  return [
    rrset(zone, "NS", input.ttl_seconds, input.nameservers ?? HNS_AUTHORITY_NAMESERVERS),
    ...inBailiwickAddresses,
    rrset(zone, "A", input.ttl_seconds, [input.gateway_ipv4]),
    rrset(`app.${zone}`, "A", input.ttl_seconds, [input.gateway_ipv4]),
    rrset(`*.${zone}`, "A", input.ttl_seconds, [input.gateway_ipv4]),
    rrset(`_pirate.${zone}`, "TXT", input.ttl_seconds, [escapeTxt(input.challenge_txt_value)]),
    rrset(`_443._tcp.${zone}`, "TLSA", input.ttl_seconds, [input.shared_tlsa_association]),
    rrset(`*.${zone}`, "TLSA", input.ttl_seconds, [input.shared_tlsa_association]),
    rrset(`_443._tcp.app.${zone}`, "TLSA", input.ttl_seconds, [input.shared_tlsa_association]),
    ...(profile === "wildcard-address-family-v2"
      ? [
          rrset(`*.${zone}`, "AAAA", input.ttl_seconds, [`::ffff:${input.gateway_ipv4}`]),
          rrset(`*.${zone}`, "HTTPS", input.ttl_seconds, [WILDCARD_HTTPS_CONTENT]),
        ]
      : []),
  ];
}

/**
 * The profile a retained zone carries, read from the zone itself, for callers
 * that have no provision result to consult. A zone the provisioner made holds
 * the wildcard address-family record sets from its creation or not at all, so
 * either one marks the newer profile; the caller then requires the whole
 * profile exactly. Callers that do hold a provision result use its digest
 * instead, so an unmanaged record at the wildcard owner cannot change which
 * profile an existing root is held to.
 */
function managedProfileOfZone(value: unknown, zoneName: string): HnsManagedRecordProfile {
  const rrsets =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as ApiZone).rrsets
      : undefined;
  if (!Array.isArray(rrsets)) throw new Error("PowerDNS retained rrsets are unavailable");
  const wildcard = `*.${zoneName}`;
  return rrsets.some(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      Reflect.get(candidate, "name") === wildcard &&
      (Reflect.get(candidate, "type") === "AAAA" || Reflect.get(candidate, "type") === "HTTPS"),
  )
    ? "wildcard-address-family-v2"
    : "wildcard-v1";
}

/**
 * Raised when neither profile, built from current configuration, reproduces the
 * managed digest a root's provision result recorded. The configuration changed
 * after provisioning, which the caller reports as an authority mismatch.
 */
export class PowerDnsManagedProfileMismatchError extends Error {
  constructor() {
    super("PowerDNS managed profile does not match the provision result");
    this.name = "PowerDnsManagedProfileMismatchError";
  }
}

async function managedProfileForDigest(
  input: Parameters<typeof buildManagedRootRrsets>[0],
  expectedSha256: string,
): Promise<HnsManagedRecordProfile | undefined> {
  for (const candidate of HNS_MANAGED_RECORD_PROFILES) {
    if ((await managedRrsetSha256(buildManagedRootRrsets(input, candidate))) === expectedSha256) {
      return candidate;
    }
  }
  return undefined;
}

async function managedRrsetSha256(managed: readonly PowerDnsRrset[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(new TextEncoder().encode(canonicalJson(managed))).buffer,
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validEndpoint(value: string): boolean {
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

export async function readBoundedJson(response: Response): Promise<unknown> {
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

export function retainedDsRecords(values: readonly string[]): readonly HnsRootDelegationDsV1[] {
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

function chainUsesZoneAuthority(
  records: readonly HnsRootResourceRecordV1[],
  dsRecords: readonly HnsRootDelegationDsV1[],
  expectedNameservers: HnsRootImportNameserversV1,
  expectedGlue: readonly HnsRootImportGlueRecordV1[],
  rootLabel: string,
): boolean {
  const nameservers = records
    .filter((record) => record.type === "NS")
    .map((record) => record.ns)
    .sort();
  const chainDs = records
    .filter((record) => record.type === "DS")
    .map((record) => ({
      key_tag: record.keyTag,
      algorithm: record.algorithm,
      digest_type: record.digestType,
      digest: typeof record.digest === "string" ? record.digest.toLowerCase() : record.digest,
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const zoneDs = dsRecords
    .map((record) => ({ ...record }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const chainGlue = records
    .filter(
      (record) =>
        (record.type === "GLUE4" || record.type === "GLUE6") &&
        expectedNameservers.includes(record.ns as string),
    )
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const zoneGlue = expectedGlue
    .filter((record) => record.ns.endsWith(`.${rootLabel}.`))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return (
    canonicalJson(nameservers) === canonicalJson([...expectedNameservers].sort()) &&
    canonicalJson(chainDs) === canonicalJson(zoneDs) &&
    canonicalJson(chainGlue) === canonicalJson(zoneGlue)
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
    // PowerDNS normalizes TLSA association hex to lowercase on readback.
    // Hex letter case does not change the certificate pin; other record
    // contents remain exact, including the ownership challenge.
    const comparableContent = (content: unknown): unknown => {
      if (wanted.type !== "TLSA" || typeof content !== "string") return content;
      const tlsa = /^3 1 1 ([0-9a-fA-F]{64})$/u.exec(content);
      return tlsa ? `3 1 1 ${tlsa[1]?.toLowerCase()}` : content;
    };
    const contents = actual.records.map((record) =>
      record !== null && typeof record === "object" && !Array.isArray(record)
        ? [comparableContent(Reflect.get(record, "content")), Reflect.get(record, "disabled")]
        : null,
    );
    if (
      JSON.stringify(contents) !==
      JSON.stringify(
        wanted.records.map((record) => [comparableContent(record.content), record.disabled]),
      )
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
  profile: HnsManagedRecordProfile,
): Promise<HnsAuthorityZoneResult> {
  if (!zone.dnssec) throw new Error("PowerDNS retained zone is not DNSSEC-enabled");
  const managed = buildManagedRootRrsets({ ...input, ...config }, profile);
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
  readonly current_records: readonly HnsRootResourceRecordV1[];
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
  ): Promise<{ readonly response: Response; readonly json: unknown }> =>
    withExchangeDeadline(async (signal) => {
      const response = await fetcher(`${apiUrl}/api/v1${path}`, {
        method,
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          "x-api-key": config.api_key,
          // A prior aborted response can leave Bun's pooled tunnel socket stale.
          // Each API exchange gets a fresh connection; ambiguous writes are
          // still reconciled by the zone reservation before any retry.
          connection: "close",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await readBoundedJson(response);
      return { response, json };
    });
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    // A zone this call creates gets the current profile. A zone that already
    // exists under this reservation keeps the profile it was created with.
    let profile = HNS_MANAGED_RECORD_PROFILE_FOR_NEW_ZONES;
    // The account marker is stored atomically with zone creation. A retry can
    // recover an ambiguous create without adopting another session's zone.
    const reservation = await reservationAccount(input.challenge_txt_value);
    const retainedReservation = (value: unknown): boolean =>
      value !== null && typeof value === "object" && (value as ApiZone).account === reservation;
    const existingResponse = await request("GET", zonePath);
    let created = false;
    let existing: { readonly serial: number; readonly dnssec: boolean } | null;
    if (existingResponse.response.status === 404) {
      existing = null;
    } else {
      if (!existingResponse.response.ok) throw new Error("PowerDNS zone inspection failed");
      existing = parseZone(existingResponse.json, zoneName);
      if (!retainedReservation(existingResponse.json)) {
        if (!existing.dnssec) throw new Error("PowerDNS existing zone is not DNSSEC-enabled");
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
        if (
          !chainUsesZoneAuthority(
            input.current_records,
            parsedDs,
            config.nameservers ?? HNS_AUTHORITY_NAMESERVERS,
            config.glue_records ?? [],
            input.root_label,
          )
        ) {
          throw new Error("PowerDNS zone belongs to another reservation");
        }
        // The parent chain already delegates to this signed zone. Preserve it
        // unchanged until the owner publishes this attempt's fresh challenge.
        // Reconciliation then brings it to the current profile, so that is
        // the profile this result records.
        return zoneResult(config, input, existing, parsedDs, false, profile);
      }
      profile = managedProfileOfZone(existingResponse.json, zoneName);
    }
    if (existing === null) {
      const create = await request(
        "POST",
        `/servers/${encodeURIComponent(config.server_id)}/zones`,
        {
          name: zoneName,
          account: reservation,
          kind: "Master",
          soa_edit_api: "DEFAULT",
          dnssec: true,
          api_rectify: true,
          rrsets: [
            rrset(zoneName, "SOA", config.ttl_seconds, [config.soa_content]),
            ...buildManagedRootRrsets({ ...input, ...config }, profile),
          ],
        },
      );
      if (create.response.status === 409) {
        const raced = await request("GET", zonePath);
        if (!raced.response.ok) throw new Error("PowerDNS zone creation race could not converge");
        existing = parseZone(raced.json, zoneName);
        if (!retainedReservation(raced.json))
          throw new Error("PowerDNS zone creation race belongs to another reservation");
        profile = managedProfileOfZone(raced.json, zoneName);
      } else {
        if (!create.response.ok) throw new Error("PowerDNS zone creation failed");
        created = true;
      }
    }
    if (!created) {
      if (existing?.dnssec !== true)
        throw new Error("PowerDNS existing zone is not DNSSEC-enabled");
      const patch = await request("PATCH", zonePath, {
        rrsets: buildManagedRootRrsets({ ...input, ...config }, profile),
      });
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
    if (!retainedReservation(retained.json))
      throw new Error("PowerDNS retained reservation does not match");
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
    // A recovered create still belongs to this reservation and must be removed
    // by its expiry teardown. "created" is retained ownership, not this call's POST.
    return zoneResult(config, input, zone, parsedDs, true, profile);
  };
}

/**
 * Reconciles a retained zone only after the parent-chain replacement proves
 * control of the name. The expected DS set prevents adopting an unrelated
 * Pirate-hosted zone or a keyset that changed after preparation.
 */
export function makePowerDnsRootReconciler(
  config: PowerDnsRootProvisionConfig,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly expected_ds_records: readonly HnsRootDelegationDsV1[];
  /** The managed digest the root's provision result recorded; it selects the profile. */
  readonly expected_managed_rrset_sha256: string;
}) => Promise<void> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0 ||
    config.soa_content.trim().length === 0 ||
    config.axfr_tsig_key_name.trim().length === 0
  ) {
    throw new Error("PowerDNS root reconciler configuration is invalid");
  }
  const apiUrl = config.api_url.replace(/\/+$/u, "");
  const request = (method: string, path: string, body?: unknown) =>
    withExchangeDeadline(async (signal) => {
      const response = await fetcher(`${apiUrl}/api/v1${path}`, {
        method,
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          "x-api-key": config.api_key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, json: await readBoundedJson(response) };
    });
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const retained = await request("GET", zonePath);
    if (!retained.response.ok) throw new Error("PowerDNS zone inspection failed");
    const zone = parseZone(retained.json, zoneName);
    if (!zone.dnssec) throw new Error("PowerDNS existing zone is not DNSSEC-enabled");
    const cryptokeys = await request("GET", `${zonePath}/cryptokeys`);
    if (!cryptokeys.response.ok || !Array.isArray(cryptokeys.json)) {
      throw new Error("PowerDNS DNSSEC key inspection failed");
    }
    const dsValues = (cryptokeys.json as readonly ApiCryptokey[])
      .filter((key) => key.active !== false && key.published !== false)
      .flatMap((key) => (Array.isArray(key.ds) ? key.ds : []));
    if (!dsValues.every((value): value is string => typeof value === "string")) {
      throw new Error("PowerDNS returned invalid DS data");
    }
    const actualDs = retainedDsRecords(dsValues);
    if (canonicalJson(actualDs) !== canonicalJson(input.expected_ds_records)) {
      throw new Error("PowerDNS DNSSEC key changed after preparation");
    }
    // Neither profile reproducing what was provisioned means the configuration
    // changed since. Writing either would not be what was recorded, so nothing
    // is written and the caller reports the mismatch.
    const profile = await managedProfileForDigest(
      { ...input, ...config },
      input.expected_managed_rrset_sha256,
    );
    if (profile === undefined) throw new PowerDnsManagedProfileMismatchError();
    const managed = buildManagedRootRrsets({ ...input, ...config }, profile);
    const patch = await request("PATCH", zonePath, { rrsets: managed });
    if (!patch.response.ok) throw new Error("PowerDNS zone reconciliation failed");
    const metadata = await request("PUT", `${zonePath}/metadata/TSIG-ALLOW-AXFR`, {
      kind: "TSIG-ALLOW-AXFR",
      metadata: [config.axfr_tsig_key_name],
    });
    if (!metadata.response.ok) throw new Error("PowerDNS AXFR authorization failed");
    const rectify = await request("PUT", `${zonePath}/rectify`);
    if (!rectify.response.ok) throw new Error("PowerDNS DNSSEC rectification failed");
    const notify = await request("PUT", `${zonePath}/notify`);
    if (!notify.response.ok) throw new Error("PowerDNS secondary notification failed");
  };
}

type PowerDnsWildcardFamilyRrset = Readonly<{
  readonly type: string;
  readonly ttl: number;
  readonly records: readonly string[];
}>;

export type PowerDnsWildcardFamilyResult = Readonly<{
  /** False when the zone already held what was asked for and nothing was sent to change it. */
  readonly changed: boolean;
  readonly serial_before: number;
  readonly serial_after: number;
  readonly wildcard_family_before: readonly PowerDnsWildcardFamilyRrset[];
  readonly wildcard_family_after: readonly PowerDnsWildcardFamilyRrset[];
}>;

/** The wildcard owner's AAAA and HTTPS record sets as the provider holds them. */
function wildcardFamilyOfZone(
  value: unknown,
  zoneName: string,
): readonly PowerDnsWildcardFamilyRrset[] {
  const rrsets =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as ApiZone).rrsets
      : undefined;
  if (!Array.isArray(rrsets)) throw new Error("PowerDNS retained rrsets are unavailable");
  const wildcard = `*.${zoneName}`;
  return rrsets
    .filter(
      (candidate): candidate is Record<string, unknown> =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        Reflect.get(candidate, "name") === wildcard &&
        (Reflect.get(candidate, "type") === "AAAA" || Reflect.get(candidate, "type") === "HTTPS"),
    )
    .map((candidate) => {
      const records = candidate.records;
      if (typeof candidate.ttl !== "number" || !Array.isArray(records))
        throw new Error("PowerDNS returned invalid zone data");
      return {
        type: String(candidate.type),
        ttl: candidate.ttl,
        records: records.map((record) => {
          const content =
            record !== null && typeof record === "object" && !Array.isArray(record)
              ? Reflect.get(record, "content")
              : undefined;
          if (typeof content !== "string" || Reflect.get(record, "disabled") !== false)
            throw new Error("PowerDNS returned invalid zone data");
          return content;
        }),
      };
    })
    .sort((left, right) => left.type.localeCompare(right.type));
}

/**
 * Adds the wildcard address-family record sets to, or removes them from, the
 * zone of a root that was provisioned under `wildcard-v1`.
 *
 * Such a root's managed record sets and its recorded digest stay what they
 * were: the two record sets are extra to its profile, and what holds them in
 * place afterwards is the retained zone a renewal compares the served zone
 * with. The caller is an operator adopting that changed zone, and holds the
 * fence that keeps a renewal of the root from running meanwhile.
 *
 * The two record sets written are the ones a new zone gets, built by the same
 * function. Before any write the zone must be the provisioned one as far as
 * the provider can show: its DNSSEC keys the provisioned ones, its managed
 * record sets intact, its serial advanced by API changes, and the wildcard
 * AAAA and HTTPS sets either absent or exactly those two. Whether the whole
 * served zone equals the retained one is the observation's to say. A zone already in
 * the state asked for is not written again, but it is still rectified and
 * notified, so a run that stopped between the write and those two steps is
 * finished by running it again.
 */
export function makePowerDnsWildcardFamilyWriter(
  config: PowerDnsRootProvisionConfig,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly expected_ds_records: readonly HnsRootDelegationDsV1[];
  /** The managed digest the root's provision result recorded. */
  readonly expected_managed_rrset_sha256: string;
  readonly change: "add" | "remove";
}) => Promise<PowerDnsWildcardFamilyResult> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0
  ) {
    throw new Error("PowerDNS wildcard family writer configuration is invalid");
  }
  const apiUrl = config.api_url.replace(/\/+$/u, "");
  const request = (method: string, path: string, body?: unknown) =>
    withExchangeDeadline(async (signal) => {
      const response = await fetcher(`${apiUrl}/api/v1${path}`, {
        method,
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          "x-api-key": config.api_key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, json: await readBoundedJson(response) };
    });
  return async (input) => {
    if (input.change !== "add" && input.change !== "remove")
      throw new Error("PowerDNS wildcard family change is invalid");
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const read = async () => {
      const retained = await request("GET", zonePath);
      if (!retained.response.ok) throw new Error("PowerDNS zone inspection failed");
      return { zone: parseZone(retained.json, zoneName), json: retained.json };
    };
    const before = await read();
    if (!before.zone.dnssec) throw new Error("PowerDNS existing zone is not DNSSEC-enabled");
    // A zone that does not move its serial on an API change would be changed
    // without the secondary transferring it, and a second run could not tell.
    // Zones this provisioner creates are set to; one that is not is refused
    // before anything is written.
    const serialPolicy = Reflect.get(before.json as object, "soa_edit_api");
    if (typeof serialPolicy !== "string" || serialPolicy.length === 0)
      throw new Error("PowerDNS zone does not advance its serial on API changes");
    const cryptokeys = await request("GET", `${zonePath}/cryptokeys`);
    if (!cryptokeys.response.ok || !Array.isArray(cryptokeys.json)) {
      throw new Error("PowerDNS DNSSEC key inspection failed");
    }
    const dsValues = (cryptokeys.json as readonly ApiCryptokey[])
      .filter((key) => key.active !== false && key.published !== false)
      .flatMap((key) => (Array.isArray(key.ds) ? key.ds : []));
    if (!dsValues.every((value): value is string => typeof value === "string")) {
      throw new Error("PowerDNS returned invalid DS data");
    }
    if (canonicalJson(retainedDsRecords(dsValues)) !== canonicalJson(input.expected_ds_records)) {
      throw new Error("PowerDNS DNSSEC key changed after preparation");
    }
    const profile = await managedProfileForDigest(
      { ...input, ...config },
      input.expected_managed_rrset_sha256,
    );
    if (profile === undefined) throw new PowerDnsManagedProfileMismatchError();
    // A root provisioned under the newer profile holds these record sets as
    // managed ones; they are neither added to it nor removable from it here.
    if (profile !== "wildcard-v1")
      throw new Error("PowerDNS wildcard address records belong to the root's managed profile");
    const managed = buildManagedRootRrsets({ ...input, ...config }, profile);
    retainedManagedRrsets(before.json, managed);

    const wildcard = `*.${zoneName}`;
    const family = buildManagedRootRrsets(
      { ...input, ...config },
      "wildcard-address-family-v2",
    ).filter((set) => set.name === wildcard && (set.type === "AAAA" || set.type === "HTTPS"));
    if (family.length !== 2) throw new Error("PowerDNS wildcard address records are unavailable");
    const familyAsRead: readonly PowerDnsWildcardFamilyRrset[] = family
      .map((set) => ({
        type: set.type,
        ttl: set.ttl,
        records: set.records.map((record) => record.content),
      }))
      .sort((left, right) => left.type.localeCompare(right.type));
    const wanted = input.change === "add" ? familyAsRead : [];
    const start = input.change === "add" ? [] : familyAsRead;
    const present = wildcardFamilyOfZone(before.json, zoneName);
    const alreadyThere = canonicalJson(present) === canonicalJson(wanted);
    // Anything else at those two types was not put there by this code.
    if (!alreadyThere && canonicalJson(present) !== canonicalJson(start))
      throw new Error("PowerDNS wildcard address records are not the expected ones");
    if (!alreadyThere) {
      const patch = await request("PATCH", zonePath, {
        rrsets:
          input.change === "add"
            ? family
            : family.map((set) => ({ name: set.name, type: set.type, changetype: "DELETE" })),
      });
      if (!patch.response.ok) throw new Error("PowerDNS zone reconciliation failed");
    }
    const rectify = await request("PUT", `${zonePath}/rectify`);
    if (!rectify.response.ok) throw new Error("PowerDNS DNSSEC rectification failed");
    const notify = await request("PUT", `${zonePath}/notify`);
    if (!notify.response.ok) throw new Error("PowerDNS secondary notification failed");

    const after = await read();
    retainedManagedRrsets(after.json, managed);
    const presentAfter = wildcardFamilyOfZone(after.json, zoneName);
    if (canonicalJson(presentAfter) !== canonicalJson(wanted))
      throw new Error("PowerDNS wildcard address records did not take effect");
    // Without a later serial the secondary does not transfer the change.
    if (!alreadyThere && after.zone.serial <= before.zone.serial)
      throw new Error("PowerDNS zone serial did not advance");
    return {
      changed: !alreadyThere,
      serial_before: before.zone.serial,
      serial_after: after.zone.serial,
      wildcard_family_before: present,
      wildcard_family_after: presentAfter,
    };
  };
}

/** Idempotently removes only a zone that this import session reported creating. */
export function makePowerDnsRootTeardown(
  config: Pick<PowerDnsRootProvisionConfig, "api_url" | "api_key" | "server_id">,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value?: string;
}) => Promise<void> {
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
    const zoneUrl = `${apiUrl}/api/v1/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const inspect = async () => {
      const { response, value } = await withExchangeDeadline(async (signal) => {
        const response = await fetcher(zoneUrl, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { accept: "application/json", "x-api-key": config.api_key },
        });
        return { response, value: await readBoundedJson(response) };
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("PowerDNS teardown inspection failed");
      parseZone(value, zoneName);
      return value as ApiZone;
    };
    if (input.challenge_txt_value !== undefined) {
      const zone = await inspect();
      if (zone === null) return;
      if (zone.account !== (await reservationAccount(input.challenge_txt_value)))
        throw new Error("PowerDNS teardown reservation does not match");
    }
    const response = await withExchangeDeadline(async (signal) => {
      const response = await fetcher(
        `${apiUrl}/api/v1/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`,
        {
          method: "DELETE",
          redirect: "manual",
          signal,
          headers: { accept: "application/json", "x-api-key": config.api_key },
        },
      );
      await readBoundedJson(response);
      return response;
    });
    if (response.status !== 404 && !response.ok) {
      throw new Error("PowerDNS zone teardown failed");
    }
    // Read back on both variants. A 2xx from the API is not confirmation that
    // the zone is gone, and quota is released on a completed teardown: an
    // unverified delete would release a reservation whose infrastructure may
    // still be serving. An ambiguous delete throws, the job retries, and the
    // reservation stays held for reconciliation.
    if ((await inspect()) !== null) throw new Error("PowerDNS zone remains after teardown");
  };
}

/**
 * Read-only zone and signing-key availability for incident evidence.
 *
 * Distinct from the reconciler: it asserts nothing about managed records and
 * compares nothing, because the incident question is only whether the
 * retained zone and its signing keys still exist. A 404 is a finding — the
 * zone is gone. An unavailable authority or an unreadable key list is not a
 * finding, and returns null so the classifier reports
 * `provider_availability_unknown` rather than inventing an absence.
 */
export function makePowerDnsZoneAvailabilityReadV1(
  config: Pick<PowerDnsRootProvisionConfig, "api_url" | "api_key" | "server_id">,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
}) => Promise<{ readonly zone_present: boolean; readonly signing_keys_present: boolean } | null> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0
  ) {
    throw new Error("PowerDNS zone availability configuration is invalid");
  }
  const apiUrl = config.api_url.replace(/\/+$/u, "");
  const get = (path: string): Promise<{ readonly response: Response; readonly json: unknown }> =>
    withExchangeDeadline(async (signal) => {
      const response = await fetcher(`${apiUrl}/api/v1${path}`, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "application/json", "x-api-key": config.api_key },
      });
      return { response, json: await readBoundedJson(response) };
    });
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    let zoneResponse: Response;
    try {
      zoneResponse = (await get(zonePath)).response;
    } catch {
      return null;
    }
    if (zoneResponse.status === 404) {
      return { zone_present: false, signing_keys_present: false };
    }
    if (!zoneResponse.ok) return null;
    let cryptokeys: unknown;
    try {
      const { response, json } = await get(`${zonePath}/cryptokeys`);
      if (!response.ok) return null;
      cryptokeys = json;
    } catch {
      return null;
    }
    if (!Array.isArray(cryptokeys)) return null;
    const signingKeysPresent = (cryptokeys as readonly ApiCryptokey[]).some(
      (key) => key.active !== false && key.published !== false,
    );
    return { zone_present: true, signing_keys_present: signingKeysPresent };
  };
}

/** Read-only reconciliation used after the owner broadcasts the replacement resource. */
export function makePowerDnsRootInspector(
  config: PowerDnsRootProvisionConfig,
  fetcher: PowerDnsFetch = fetch,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
  /** The managed digest the root's provision result recorded, when the caller has one. */
  readonly expected_managed_rrset_sha256?: string;
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
  const request = (path: string): Promise<unknown> =>
    withExchangeDeadline(async (signal) => {
      const response = await fetcher(`${apiUrl}/api/v1${path}`, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "application/json", "x-api-key": config.api_key },
      });
      if (!response.ok) throw new Error("PowerDNS authority inspection failed");
      return readBoundedJson(response);
    });
  return async (input) => {
    const zoneName = canonicalName(input.root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const retained = await request(zonePath);
    const zone = parseZone(retained, zoneName);
    // A recorded digest decides the profile, so an existing root is inspected
    // exactly as before whatever else its zone holds. When configuration no
    // longer reproduces that digest under either profile the earlier set is
    // checked, which is all an inspection checked before profiles existed,
    // and the caller's own comparison of the digests reports the mismatch.
    // Only an inspection without a recorded digest reads the profile from
    // the zone.
    const profile =
      input.expected_managed_rrset_sha256 === undefined
        ? managedProfileOfZone(retained, zoneName)
        : ((await managedProfileForDigest(
            { ...input, ...config },
            input.expected_managed_rrset_sha256,
          )) ?? "wildcard-v1");
    retainedManagedRrsets(retained, buildManagedRootRrsets({ ...input, ...config }, profile));
    const cryptokeys = await request(`${zonePath}/cryptokeys`);
    if (!Array.isArray(cryptokeys)) throw new Error("PowerDNS DNSSEC key inspection failed");
    const dsRecords = (cryptokeys as readonly ApiCryptokey[])
      .filter((key) => key.active !== false && key.published !== false)
      .flatMap((key) => (Array.isArray(key.ds) ? key.ds : []));
    if (!dsRecords.every((value): value is string => typeof value === "string")) {
      throw new Error("PowerDNS returned invalid DS data");
    }
    return zoneResult(config, input, zone, retainedDsRecords(dsRecords), false, profile);
  };
}
