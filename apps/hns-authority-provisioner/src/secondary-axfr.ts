import { isIP } from "node:net";
import { canonicalJson } from "@pirate/domain";
import {
  canonicalName,
  escapeTxt,
  type PowerDnsFetch,
  readBoundedJson,
  validEndpoint,
  withExchangeDeadline,
} from "./powerdns.ts";

export type PowerDnsSecondaryAxfrConfig = Readonly<{
  readonly api_url: string;
  readonly api_key: string;
  readonly server_id: string;
  readonly expected_master_address: string;
  readonly expected_account: string;
  readonly axfr_tsig_key_name: string;
}>;

type ApiZone = Readonly<{
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly masters?: unknown;
  readonly serial?: unknown;
  readonly dnssec?: unknown;
  readonly rrsets?: unknown;
  readonly account?: unknown;
}>;

type ApiMetadata = Readonly<{
  readonly kind?: unknown;
  readonly metadata?: unknown;
}>;

/**
 * Allows the readiness observer's signed AXFR only after the transferred
 * secondary proves the exact session challenge and expected authority shape.
 * The caller holds the same fenced zone-mutation lock as primary reconciliation.
 */
export function makePowerDnsSecondaryAxfrAuthorizer(
  config: PowerDnsSecondaryAxfrConfig,
  fetcher: PowerDnsFetch = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => Bun.sleep(milliseconds),
): (input: { readonly root_label: string; readonly challenge_txt_value: string }) => Promise<void> {
  if (
    !validEndpoint(config.api_url) ||
    config.api_key.length === 0 ||
    config.server_id.length === 0 ||
    isIP(config.expected_master_address) === 0 ||
    config.expected_account.trim() !== config.expected_account ||
    config.expected_account.length === 0 ||
    config.expected_account.length > 40 ||
    !/^[A-Za-z0-9._-]{1,256}$/u.test(config.axfr_tsig_key_name)
  ) {
    throw new Error("PowerDNS secondary AXFR configuration is invalid");
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
  return async ({ root_label, challenge_txt_value }) => {
    const zoneName = canonicalName(root_label);
    const zonePath = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(zoneName)}`;
    const metadataPath = `${zonePath}/metadata/TSIG-ALLOW-AXFR`;
    const challengeName = `_pirate.${zoneName}`;
    const transferred = (value: unknown): boolean => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("PowerDNS secondary returned invalid zone data");
      const zone = value as ApiZone;
      if (
        zone.name !== zoneName ||
        zone.kind !== "Slave" ||
        zone.account !== config.expected_account ||
        !Array.isArray(zone.masters) ||
        zone.masters.length !== 1 ||
        zone.masters[0] !== config.expected_master_address
      ) {
        throw new Error("PowerDNS secondary zone identity does not match");
      }
      if (!Array.isArray(zone.rrsets)) return false;
      const rrsets = zone.rrsets as readonly Record<string, unknown>[];
      const records = (name: string, type: string): unknown[] | null => {
        const matching = rrsets.filter(
          (rrset) =>
            rrset !== null &&
            typeof rrset === "object" &&
            rrset.name === name &&
            rrset.type === type,
        );
        if (matching.length > 1) throw new Error("PowerDNS secondary rrset is ambiguous");
        return matching.length === 1 && Array.isArray(matching[0]?.records)
          ? (matching[0].records as unknown[])
          : null;
      };
      const challenge = records(challengeName, "TXT");
      if (
        challenge !== null &&
        (challenge.length !== 1 ||
          challenge[0] === null ||
          typeof challenge[0] !== "object" ||
          Reflect.get(challenge[0], "content") !== escapeTxt(challenge_txt_value) ||
          Reflect.get(challenge[0], "disabled") !== false)
      ) {
        throw new Error("PowerDNS secondary challenge does not match");
      }
      const hasRecords = (name: string, type: string): boolean =>
        records(name, type)?.some(
          (record) =>
            record !== null &&
            typeof record === "object" &&
            typeof Reflect.get(record, "content") === "string" &&
            Reflect.get(record, "disabled") === false,
        ) === true;
      return (
        zone.dnssec === true &&
        typeof zone.serial === "number" &&
        Number.isSafeInteger(zone.serial) &&
        zone.serial > 0 &&
        challenge !== null &&
        hasRecords(zoneName, "DNSKEY") &&
        hasRecords(zoneName, "RRSIG") &&
        hasRecords(challengeName, "RRSIG")
      );
    };
    let ready = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inspected = await request("GET", zonePath);
      if (inspected.response.status !== 404) {
        if (!inspected.response.ok) throw new Error("PowerDNS secondary zone inspection failed");
        ready = transferred(inspected.json);
      }
      if (ready) break;
      if (attempt < 2) await wait(250);
    }
    if (!ready) throw new Error("PowerDNS secondary transfer is incomplete");
    const metadata = (value: unknown): readonly string[] => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("PowerDNS secondary AXFR metadata is invalid");
      const item = value as ApiMetadata;
      if (
        item.kind !== "TSIG-ALLOW-AXFR" ||
        !Array.isArray(item.metadata) ||
        item.metadata.length > 16 ||
        new Set(item.metadata).size !== item.metadata.length ||
        !item.metadata.every(
          (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256,
        )
      ) {
        throw new Error("PowerDNS secondary AXFR metadata is invalid");
      }
      return item.metadata as string[];
    };
    const before = await request("GET", metadataPath);
    if (!before.response.ok) throw new Error("PowerDNS secondary AXFR metadata inspection failed");
    const retained = metadata(before.json);
    if (retained.includes(config.axfr_tsig_key_name)) return;
    if (retained.length === 16)
      throw new Error("PowerDNS secondary AXFR metadata capacity is exhausted");
    const rechecked = await request("GET", zonePath);
    if (!rechecked.response.ok || !transferred(rechecked.json))
      throw new Error("PowerDNS secondary changed before AXFR authorization");
    const expected = [...retained, config.axfr_tsig_key_name];
    const updated = await request("PUT", metadataPath, {
      kind: "TSIG-ALLOW-AXFR",
      metadata: expected,
    });
    if (!updated.response.ok) throw new Error("PowerDNS secondary AXFR authorization failed");
    const after = await request("GET", metadataPath);
    if (
      !after.response.ok ||
      canonicalJson([...metadata(after.json)].sort()) !== canonicalJson([...expected].sort())
    ) {
      throw new Error("PowerDNS secondary AXFR authorization readback failed");
    }
  };
}
