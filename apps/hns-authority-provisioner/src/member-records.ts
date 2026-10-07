import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  type PowerDnsFetch,
  readBoundedJson,
  validEndpoint,
  withExchangeDeadline,
} from "./powerdns.ts";

export type HnsMemberRecordTarget = Readonly<{
  root_label: string;
  handle_label: string;
  grant_id: string;
  gateway_ipv4: string;
  shared_tlsa_association: string;
  ttl_seconds: number;
  publish: boolean;
}>;

type RecordSet = Readonly<{
  name: string;
  type: string;
  ttl: number;
  changetype: "REPLACE" | "DELETE";
  records: readonly Readonly<{ content: string; disabled: false }>[];
}>;

type Zone = Readonly<{
  name: string;
  account: string;
  dnssec: boolean;
  serial: number;
  rrsets: unknown[];
}>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function recordNames(input: HnsMemberRecordTarget) {
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  if (
    !label.test(input.root_label) ||
    !label.test(input.handle_label) ||
    input.root_label === "pirate" ||
    input.handle_label === "app" ||
    input.grant_id.length === 0 ||
    input.grant_id.length > 256 ||
    isIP(input.gateway_ipv4) !== 4 ||
    !/^3 1 1 [a-fA-F0-9]{64}$/u.test(input.shared_tlsa_association) ||
    !Number.isSafeInteger(input.ttl_seconds) ||
    input.ttl_seconds < 1 ||
    input.ttl_seconds > 86400
  )
    throw new Error("HNS member record target is invalid");
  const host = `${input.handle_label}.${input.root_label}.`;
  return { host, tlsa: `_443._tcp.${host}`, marker: `_pirate-member.${host}` };
}

function contents(rrsets: readonly unknown[], name: string, type: string): string[] {
  const matches = rrsets.filter(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).name === name &&
      (value as Record<string, unknown>).type === type,
  );
  if (matches.length === 0) return [];
  if (matches.length !== 1) throw new Error("HNS member rrset is ambiguous");
  const records = (matches[0] as Record<string, unknown>).records;
  if (!Array.isArray(records)) throw new Error("HNS member rrset is invalid");
  return records
    .map((record: unknown) => {
      if (
        record === null ||
        typeof record !== "object" ||
        typeof (record as Record<string, unknown>).content !== "string" ||
        (record as Record<string, unknown>).disabled !== false
      )
        throw new Error("HNS member record is invalid");
      const content = (record as { content: string }).content;
      return type === "TLSA" ? content.toLowerCase() : content;
    })
    .sort();
}

function ownership(grantId: string, addresses: readonly string[], tlsa: readonly string[]) {
  return `"pirate-member-v1:${digest(grantId)}:${digest(JSON.stringify([addresses, tlsa]))}"`;
}

/** The marker makes a provider write recoverable even if the database acknowledgement is lost. */
export function buildHnsMemberRecordPatch(
  input: HnsMemberRecordTarget,
  rrsets: readonly unknown[],
): readonly RecordSet[] {
  const names = recordNames(input);
  const addresses = contents(rrsets, names.host, "A");
  const certificates = contents(rrsets, names.tlsa, "TLSA");
  const markers = contents(rrsets, names.marker, "TXT");
  if (markers.length === 0) {
    if (addresses.length || certificates.length)
      throw new Error("HNS member record ownership conflict");
    if (!input.publish) return [];
  } else if (
    markers.length !== 1 ||
    markers[0] !== ownership(input.grant_id, addresses, certificates)
  ) {
    throw new Error("HNS member record ownership conflict");
  }
  if (
    contents(rrsets, names.host, "CNAME").length ||
    contents(rrsets, names.host, "NS").length ||
    contents(rrsets, names.tlsa, "CNAME").length
  )
    throw new Error("HNS member record alias conflict");
  const desired = [input.gateway_ipv4];
  const tlsa = [input.shared_tlsa_association.toLowerCase()];
  const entries = [
    [names.host, "A", desired],
    [names.tlsa, "TLSA", tlsa],
    [names.marker, "TXT", [ownership(input.grant_id, desired, tlsa)]],
  ] as const;
  const current =
    input.publish &&
    entries.every(
      ([name, type, values]) =>
        JSON.stringify(contents(rrsets, name, type)) === JSON.stringify(values) &&
        rrsets.some(
          (row) =>
            row !== null &&
            typeof row === "object" &&
            Reflect.get(row, "name") === name &&
            Reflect.get(row, "type") === type &&
            Reflect.get(row, "ttl") === input.ttl_seconds,
        ),
    );
  if (current) return [];
  return entries.map(([name, type, values]) => ({
    name,
    type,
    ttl: input.ttl_seconds,
    changetype: input.publish ? "REPLACE" : "DELETE",
    records: input.publish ? values.map((content) => ({ content, disabled: false as const })) : [],
  }));
}

export function assertHnsMemberRecords(
  input: HnsMemberRecordTarget,
  rrsets: readonly unknown[],
): void {
  const names = recordNames(input);
  const expected = input.publish
    ? [
        [input.gateway_ipv4],
        [input.shared_tlsa_association.toLowerCase()],
        [
          ownership(
            input.grant_id,
            [input.gateway_ipv4],
            [input.shared_tlsa_association.toLowerCase()],
          ),
        ],
      ]
    : [[], [], []];
  const actual = [
    contents(rrsets, names.host, "A"),
    contents(rrsets, names.tlsa, "TLSA"),
    contents(rrsets, names.marker, "TXT"),
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("HNS member record readback differs");
}

type Provider = Readonly<{ api_url: string; api_key: string; server_id: string }>;

function requests(config: Provider, fetcher: PowerDnsFetch) {
  if (!validEndpoint(config.api_url) || !config.api_key || !config.server_id)
    throw new Error("HNS member provider configuration is invalid");
  return (method: string, path: string, body?: unknown) =>
    withExchangeDeadline(async (signal) => {
      const response = await fetcher(`${config.api_url.replace(/\/+$/u, "")}/api/v1${path}`, {
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
      if (!response.ok) throw new Error("HNS member provider request failed");
      return readBoundedJson(response);
    });
}

function zone(value: unknown, root: string): Zone {
  if (value === null || typeof value !== "object") throw new Error("HNS member zone is invalid");
  const result = value as Zone;
  if (
    result.name !== `${root}.` ||
    result.dnssec !== true ||
    !Array.isArray(result.rrsets) ||
    !Number.isSafeInteger(result.serial) ||
    result.serial <= 0
  )
    throw new Error("HNS member zone is invalid");
  return result;
}

/** Caller must hold the current grant and root-session mutation locks for the entire operation. */
export function makePowerDnsMemberWriter(config: Provider, fetcher: PowerDnsFetch = fetch) {
  const request = requests(config, fetcher);
  return async (
    input: HnsMemberRecordTarget & { readonly challenge_txt_value: string },
  ): Promise<number> => {
    recordNames(input);
    const path = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(`${input.root_label}.`)}`;
    const before = zone(await request("GET", path), input.root_label);
    // The published challenge binds the zone to this session. The account is
    // deliberately not compared: root provisioning adopts a delegated zone
    // that still carries an earlier reservation and never rewrites its
    // account, and members of such a root must still be publishable.
    if (
      JSON.stringify(contents(before.rrsets, `_pirate.${input.root_label}.`, "TXT")) !==
      JSON.stringify([
        `"${input.challenge_txt_value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      ])
    )
      throw new Error("HNS member zone reservation differs");
    const patch = buildHnsMemberRecordPatch(input, before.rrsets);
    if (patch.length > 0) await request("PATCH", path, { rrsets: patch });
    // A prior PATCH can have succeeded before its acknowledgement was lost.
    // Complete signing/notification on retry without needlessly advancing SOA.
    await request("PUT", `${path}/rectify`);
    await request("PUT", `${path}/notify`);
    const after = zone(await request("GET", path), input.root_label);
    if (after.account !== before.account) throw new Error("HNS member zone reservation changed");
    assertHnsMemberRecords(input, after.rrsets);
    return after.serial;
  };
}

export function makePowerDnsMemberReader(config: Provider, fetcher: PowerDnsFetch = fetch) {
  const request = requests(config, fetcher);
  return async (input: HnsMemberRecordTarget, minimumSerial: number): Promise<void> => {
    const path = `/servers/${encodeURIComponent(config.server_id)}/zones/${encodeURIComponent(`${input.root_label}.`)}`;
    const current = zone(await request("GET", path), input.root_label);
    if (current.serial < minimumSerial) throw new Error("HNS member secondary is behind");
    assertHnsMemberRecords(input, current.rrsets);
  };
}
