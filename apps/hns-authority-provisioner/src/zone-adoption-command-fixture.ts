import type { HnsChainObservationResultV1 } from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import type { Client } from "pg";
import { buildManagedRootRrsets } from "./powerdns.ts";
import {
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  type HnsAuthorityZoneResult,
  provisionHnsAuthorityRootV1,
} from "./provision-root.ts";
import {
  type HnsZoneAdoptionCommandDependenciesV1,
  runHnsZoneAdoptionCommandV1,
} from "./zone-adoption-command.ts";

export const encoder = new TextEncoder();
export const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const powerdns = {
  api_url: "http://powerdns.test:8081",
  api_key: "secret-not-logged",
  server_id: "localhost",
  soa_content: "ns1.pirate. hostmaster.pirate. 0 3600 900 1209600 300",
  axfr_tsig_key_name: "secondary-transfer.",
  gateway_ipv4: "192.0.2.10",
  shared_tlsa_association: `3 1 1 ${"d".repeat(64)}`,
  gateway_deployment_reference: "gateway-deployment-v1",
  gateway_certificate_spki_sha256: "d".repeat(64),
  ttl_seconds: 300,
};
const session = { root_label: "newroot", challenge_txt_value: "pirate-verification=challenge" };
const dsRecords = [
  { key_tag: 10_875, algorithm: 13, digest_type: 2 as const, digest: "a".repeat(64) },
  { key_tag: 10_875, algorithm: 13, digest_type: 4 as const, digest: "b".repeat(96) },
];

// A canonical authority zone for the root, without and with the two wildcard
// address-family records, as the adoption difference check reads it.
const hex = (bytes: readonly number[]) =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
const wireName = (value: string) =>
  hex([...value.split(".").flatMap((label) => [label.length, ...encoder.encode(label)]), 0]);
const nsec = (next: string, types: readonly number[]) => {
  const bitmap = new Array<number>(Math.floor(Math.max(...types) / 8) + 1).fill(0);
  for (const type of types)
    bitmap[Math.floor(type / 8)] = (bitmap[Math.floor(type / 8)] ?? 0) | (0x80 >> (type % 8));
  return `${wireName(next)}${hex([0, bitmap.length, ...bitmap])}`;
};
export function canonicalZone(serial: number, family: boolean): Uint8Array {
  const soa = `${wireName("ns1.pirate")}${wireName("hostmaster.pirate")}${serial
    .toString(16)
    .padStart(8, "0")}${"00000e10".repeat(4)}`;
  return encoder.encode(
    JSON.stringify({
      version: "pirate-hns-canonical-authority-zone-v1",
      root_label: "newroot",
      records: [
        ["newroot", 6, 1, 300, soa],
        ["*.newroot", 1, 1, 300, "c000020a"],
        ...(family ? [["*.newroot", 28, 1, 300, "00000000000000000000ffffc000020a"]] : []),
        ["*.newroot", 47, 1, 300, nsec("app.newroot", family ? [1, 28, 46, 47, 65] : [1, 46, 47])],
        ...(family ? [["*.newroot", 65, 1, 300, "0001000001000c02683208687474702f312e31"]] : []),
        ["app.newroot", 1, 1, 300, "c000020a"],
      ],
    }),
  );
}

function observedCurrent(records: readonly unknown[]): HnsChainObservationResultV1 {
  return {
    kind: "observed",
    observation: {
      view: "current",
      network: "main",
      genesis_block_hash: `${"0".repeat(63)}1`,
      anchor: {
        network: "main",
        genesis_block_hash: `${"0".repeat(63)}1`,
        height: 812_345,
        best_block_hash: "aa".repeat(32),
        median_time_past_epoch_seconds: 1_770_000_000,
        header_time_epoch_seconds: 1_770_000_030,
        confirmations: 1,
      },
      tip_height: 812_345,
      update_inclusion_height: 800_000,
      commitment: null,
      observed_at_epoch_ms: 1_770_000_060_000,
      records: structuredClone(records) as never,
      resource_sha256: "1".repeat(64),
    },
  };
}

/**
 * One activated root provisioned under the earlier profile, the database row
 * the command reads for it, a provider that keeps what it is given, and the
 * observer's three ports serving whichever zone the test says is live.
 */
export async function world() {
  const managed = buildManagedRootRrsets({ ...powerdns, ...session }, "wildcard-v1");
  const zone: HnsAuthorityZoneResult = {
    created: true,
    dnssec: true,
    serial: 7,
    ds_records: dsRecords,
    managed_rrset_sha256: await sha256(encoder.encode(canonicalJson(managed))),
    managed_zone_bytes: encoder.encode(canonicalJson(managed)),
    shared_tlsa_profile_sha256: "c".repeat(64),
    gateway_ipv4: powerdns.gateway_ipv4,
    gateway_deployment_reference: powerdns.gateway_deployment_reference,
    gateway_certificate_spki_sha256: powerdns.gateway_certificate_spki_sha256,
    ttl_seconds: 300,
  };
  const provision = await provisionHnsAuthorityRootV1(
    {
      version: HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
      root_import_session_id: "root-import-session",
      namespace_session_id: "namespace-session",
      ...session,
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    {
      observe_current_resource: async () => observedCurrent([{ type: "TXT", txt: ["preserved"] }]),
      ensure_zone: async () => zone,
    },
  );
  const plan = JSON.parse(new TextDecoder().decode(provision.publish_plan_bytes)) as {
    readonly replacement_records: readonly unknown[];
  };
  const retained = canonicalZone(7, false);
  const row: Record<string, unknown> = {
    root_import_session_id: "root-import-session",
    session_status: "activated",
    namespace_session_id: "namespace-session",
    challenge_txt_value: session.challenge_txt_value,
    ownership_result_sha256: "e".repeat(64),
    session_publish_plan_sha256: provision.publish_plan_sha256,
    publish_plan_bytes: provision.publish_plan_bytes,
    session_expires_at: "2099-01-01T00:00:00.000Z",
    provision_publish_plan_sha256: provision.publish_plan_sha256,
    provision_result_sha256: provision.result_sha256,
    provision_result_bytes: provision.result_bytes,
    dns_zone_activation_id: "dns-activation",
    current_generation: "4",
    zone_bytes: retained,
    zone_bytes_digest: await sha256(retained),
    dnssec_keyset_reference: "pdns-keyset:newroot",
    dnssec_keyset_version: "0".repeat(64),
    gateway_deployment_reference: powerdns.gateway_deployment_reference,
    gateway_certificate_spki_sha256: powerdns.gateway_certificate_spki_sha256,
    stable_chain_delegation_snapshot_reference: `hns-root-chain:${"0".repeat(64)}`,
    open_renewal_jobs: "0",
    serving_valid_until: new Date(Date.now() + 6 * 86_400_000),
  };

  // Database statements and provider calls, in the order they happened.
  const events: string[] = [];
  const statements: string[] = [];
  const clock = { finished_offset_ms: 0 };
  const connect = async () =>
    ({
      query: async (text: string) => {
        const flat = text.trim().replace(/\s+/gu, " ");
        if (flat.includes("FROM hns_root_import_sessions")) {
          const read = flat.endsWith("FOR NO KEY UPDATE OF session, dns")
            ? "SELECT locked"
            : "SELECT";
          statements.push(read);
          events.push(read);
          return { rows: [{ ...row, database_time: new Date() }] };
        }
        statements.push(flat);
        events.push(flat);
        if (flat === "SELECT clock_timestamp() AS database_time")
          return { rows: [{ database_time: new Date(Date.now() + clock.finished_offset_ms) }] };
        return { rows: [] };
      },
      end: async () => {},
      on: () => {},
      off: () => {},
    }) as unknown as Client;

  const provider = { serial: 7, rrsets: [...managed] as { name: string; type: string }[] };
  const providerCalls: string[] = [];
  const fetcher = async (url: Request | string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    providerCalls.push(`${method} ${path.split("/zones/")[1] ?? path}`);
    events.push(`provider ${method}`);
    if (method === "GET" && path.endsWith("/cryptokeys"))
      return Response.json([
        {
          active: true,
          published: true,
          ds: dsRecords.map((ds) => `10875 13 ${String(ds.digest_type)} ${ds.digest}`),
        },
      ]);
    if (method === "GET")
      return Response.json({
        name: "newroot.",
        dnssec: true,
        soa_edit_api: "DEFAULT",
        ...provider,
      });
    if (method === "PATCH") {
      const changed: { name: string; type: string; changetype: string }[] = JSON.parse(
        String(init?.body),
      ).rrsets;
      provider.rrsets = [
        ...provider.rrsets.filter(
          (kept) => !changed.some((next) => next.name === kept.name && next.type === kept.type),
        ),
        ...changed.filter((next) => next.changetype !== "DELETE"),
      ];
      provider.serial += 1;
    }
    return new Response(null, { status: 204 });
  };

  const live = {
    zone: canonicalZone(8, true),
    secondary_zone: null as Uint8Array | null,
    invalid_key: false,
    fails: null as Error | null,
  };
  const files = new Map<string, Uint8Array>();
  const lines: Record<string, unknown>[] = [];
  const deps: HnsZoneAdoptionCommandDependenciesV1 = {
    connect,
    powerdns,
    fetch: fetcher,
    observe: {
      observe_current_resource: async () => observedCurrent(plan.replacement_records),
      inspect_zone: async () => ({
        ...zone,
        created: false,
        serial: provider.serial,
        ds_records: live.invalid_key ? [] : zone.ds_records,
      }),
      observe_live: async () => {
        if (live.fails !== null) throw live.fails;
        const observedZoneSha256 = await sha256(live.zone);
        const view = (ordinal: 1 | 2) => ({
          authority_nameserver: `ns${String(ordinal)}.pirate`,
          authority_address_family: "GLUE4" as const,
          authority_address: `192.0.2.${String(52 + ordinal)}`,
          dnssec_validation: "secure" as const,
          challenge_present: true as const,
          validated_dnskey_response_sha256: String(ordinal).repeat(64),
          validated_control_response_sha256: String(ordinal + 2).repeat(64),
          validated_chain_authority_digest: "5".repeat(64),
          observed_zone_bytes: live.zone,
          observed_zone_sha256: observedZoneSha256,
        });
        const second =
          live.secondary_zone === null
            ? view(2)
            : {
                ...view(2),
                observed_zone_bytes: live.secondary_zone,
                observed_zone_sha256: await sha256(live.secondary_zone),
              };
        return {
          authority_views: [view(1), second],
          gateway: {
            normalized_host: "app.newroot",
            gateway_address: "192.0.2.10",
            certificate_spki_sha256: "d".repeat(64),
            http_status: 421 as const,
          },
        } as const;
      },
    },
    observation_config: { environment: "staging", valid_for_seconds: 604_800 },
    executor_id: "executor",
    read_file: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("HNS zone adoption observation file is unavailable");
      return bytes;
    },
    write_new_file: async (path, bytes) => {
      if (files.has(path))
        throw Object.assign(new Error("EEXIST: file exists"), { code: "EEXIST" });
      files.set(path, bytes);
    },
    write: (line) => lines.push(JSON.parse(line)),
  };
  const run = async (...args: string[]) => {
    lines.length = 0;
    const code = await runHnsZoneAdoptionCommandV1(args, deps);
    return { code, report: lines[0] ?? {} };
  };
  return { clock, run, row, statements, events, provider, providerCalls, live, files, deps };
}
