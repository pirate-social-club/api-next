import { describe, expect, test } from "bun:test";
import {
  decodeHnsRootImportReadinessResultV1,
  type HnsChainObservationResultV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import type { Client } from "pg";
import { buildManagedRootRrsets } from "./powerdns.ts";
import {
  HNS_AUTHORITY_PROVISION_REQUEST_VERSION,
  type HnsAuthorityZoneResult,
  provisionHnsAuthorityRootV1,
} from "./provision-root.ts";
import {
  HNS_ZONE_ADOPTION_DEFAULT_MINIMUM_VALIDITY_SECONDS,
  type HnsZoneAdoptionCommandDependenciesV1,
  parseHnsZoneAdoptionArgumentsV1,
  runHnsZoneAdoptionCommandV1,
} from "./zone-adoption-command.ts";

const encoder = new TextEncoder();
const sha256 = async (bytes: Uint8Array) =>
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
function canonicalZone(serial: number, family: boolean): Uint8Array {
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
async function world() {
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

  const live = { zone: canonicalZone(8, true), fails: null as Error | null };
  const files = new Map<string, Uint8Array>();
  const lines: Record<string, unknown>[] = [];
  const deps: HnsZoneAdoptionCommandDependenciesV1 = {
    connect,
    powerdns,
    fetch: fetcher,
    observe: {
      observe_current_resource: async () => observedCurrent(plan.replacement_records),
      inspect_zone: async () => ({ ...zone, created: false, serial: provider.serial }),
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
        return {
          authority_views: [view(1), view(2)],
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
  return { run, row, statements, events, provider, providerCalls, live, files };
}

describe("HNS zone adoption command arguments", () => {
  test("accepts each step's exact options", () => {
    expect(parseHnsZoneAdoptionArgumentsV1(["status", "--root", "newroot"])).toEqual({
      step: "status",
      root_label: "newroot",
    });
    expect(
      parseHnsZoneAdoptionArgumentsV1([
        "write-records",
        "--change",
        "add-wildcard-family",
        "--root",
        "newroot",
      ]),
    ).toEqual({
      step: "write-records",
      root_label: "newroot",
      change: "add",
      minimum_serving_validity_seconds: HNS_ZONE_ADOPTION_DEFAULT_MINIMUM_VALIDITY_SECONDS,
    });
    expect(
      parseHnsZoneAdoptionArgumentsV1([
        "write-records",
        "--root",
        "newroot",
        "--change",
        "remove-wildcard-family",
        "--minimum-validity-seconds",
        "7200",
      ]),
    ).toMatchObject({ change: "remove", minimum_serving_validity_seconds: 7_200 });
    expect(
      parseHnsZoneAdoptionArgumentsV1(["observe", "--root", "newroot", "--out", "/var/lib/x.json"]),
    ).toEqual({ step: "observe", root_label: "newroot", out: "/var/lib/x.json" });
    expect(
      parseHnsZoneAdoptionArgumentsV1([
        "adopt",
        "--observation",
        "/var/lib/x.json",
        "--expect-result-sha256",
        "a".repeat(64),
        "--expect-delta",
        "wildcard_family_added",
        "--mode",
        "rehearse",
      ]),
    ).toEqual({
      step: "adopt",
      observation: "/var/lib/x.json",
      expected_result_sha256: "a".repeat(64),
      expected_delta: "wildcard_family_added",
      mode: "rehearse",
    });
  });

  test("refuses anything else", () => {
    const replaced = (args: readonly string[], index: number, value: string) =>
      args.map((arg, position) => (position === index ? value : arg));
    const adopt = [
      "adopt",
      "--observation",
      "/var/lib/x.json",
      "--expect-result-sha256",
      "a".repeat(64),
      "--expect-delta",
      "wildcard_family_added",
      "--mode",
      "commit",
    ];
    for (const args of [
      [],
      ["status"],
      ["status", "--root", "NEWROOT"],
      ["status", "--root", "newroot", "--root", "other"],
      ["status", "--root", "newroot", "--mode", "commit"],
      ["write-records", "--root", "newroot"],
      ["write-records", "--root", "newroot", "--change", "add"],
      [
        "write-records",
        "--root",
        "newroot",
        "--change",
        "add-wildcard-family",
        "--minimum-validity-seconds",
        "60",
      ],
      ["observe", "--root", "newroot", "--out", "relative.json"],
      adopt.slice(0, -2),
      replaced(adopt, 2, "relative.json"),
      replaced(adopt, 4, "A".repeat(64)),
      replaced(adopt, 6, "anything"),
      replaced(adopt, 8, "force"),
    ]) {
      expect(() => parseHnsZoneAdoptionArgumentsV1(args)).toThrow("arguments are invalid");
    }
  });
});

describe("HNS zone adoption command", () => {
  test("status reads the root in a read-only transaction and writes nothing", async () => {
    const { run, statements, providerCalls } = await world();
    const { code, report } = await run("status", "--root", "newroot");
    expect(code).toBe(0);
    expect(report).toMatchObject({
      command: "adopt-zone",
      step: "status",
      outcome: "read",
      root_label: "newroot",
      current_generation: 4,
      retained_zone_holds_wildcard_family: false,
      open_renewal_jobs: 0,
    });
    expect(statements).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT",
      "ROLLBACK",
    ]);
    expect(providerCalls).toEqual([]);
  });

  test("write-records changes the primary only inside the fence and never writes the database", async () => {
    const { run, statements, events, provider, providerCalls } = await world();
    const { code, report } = await run(
      "write-records",
      "--root",
      "newroot",
      "--change",
      "add-wildcard-family",
    );
    expect(code).toBe(0);
    expect(report).toMatchObject({
      outcome: "written",
      change: "add",
      departs_from_retained_zone: true,
      current_generation: 4,
      serial_before: 7,
      serial_after: 8,
      wildcard_family_before: [],
      wildcard_family_after: [
        { type: "AAAA", ttl: 300, records: ["::ffff:192.0.2.10"] },
        { type: "HTTPS", ttl: 300, records: ["1 . alpn=h2,http/1.1"] },
      ],
    });
    // The rows are locked before the provider is touched and released after.
    expect(statements).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout TO '10s'",
      "SELECT locked",
      "SELECT 1",
      "ROLLBACK",
    ]);
    expect(providerCalls).toContain("PATCH newroot.");
    // Every provider call falls between taking the rows and releasing them.
    expect(events).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout TO '10s'",
      "SELECT locked",
      "provider GET",
      "provider GET",
      "provider PATCH",
      "provider PUT",
      "provider PUT",
      "provider GET",
      "SELECT 1",
      "ROLLBACK",
    ]);
    expect(provider.rrsets.filter(({ name }) => name === "*.newroot.").length).toBe(4);
    // Nothing printed is a credential.
    expect(JSON.stringify(report)).not.toContain("secret-not-logged");

    expect(
      (await run("write-records", "--root", "newroot", "--change", "add-wildcard-family")).report,
    ).toMatchObject({ outcome: "already_as_asked", serial_before: 8, serial_after: 8 });
    expect(
      (await run("write-records", "--root", "newroot", "--change", "remove-wildcard-family"))
        .report,
    ).toMatchObject({ outcome: "written", serial_after: 9, wildcard_family_after: [] });
  });

  test("write-records refuses, before the provider is touched, a departing change with an open renewal job or too close to expiry", async () => {
    const { run, row, providerCalls } = await world();
    row.open_renewal_jobs = "1";
    expect(
      await run("write-records", "--root", "newroot", "--change", "add-wildcard-family"),
    ).toMatchObject({
      code: 2,
      report: {
        outcome: "refused",
        reason: "a renewal job for the root's current generation is open",
      },
    });
    expect(providerCalls).toEqual([]);
    row.open_renewal_jobs = "0";
    row.serving_valid_until = new Date(Date.now() + 3 * 86_400_000);
    expect(
      await run("write-records", "--root", "newroot", "--change", "add-wildcard-family"),
    ).toMatchObject({
      code: 2,
      report: {
        outcome: "refused",
        reason:
          "the root is too close to expiry for a change to be adopted before a renewal is scheduled",
      },
    });
    expect(providerCalls).toEqual([]);
    // The operator can name a smaller margin, down to an hour.
    expect(
      (
        await run(
          "write-records",
          "--root",
          "newroot",
          "--change",
          "add-wildcard-family",
          "--minimum-validity-seconds",
          "86400",
        )
      ).code,
    ).toBe(0);
    expect(providerCalls.filter((call) => call.startsWith("PATCH")).length).toBe(1);
  });

  test("write-records never refuses a change that returns the zone to the retained one", async () => {
    // The retained zone holds no wildcard address records. Records written
    // and not yet adopted are withdrawn by removing them, and that must work
    // with a renewal job open and the root an hour from expiry, which is
    // exactly when a stalled adoption needs it.
    const { run, row, provider } = await world();
    expect(
      (await run("write-records", "--root", "newroot", "--change", "add-wildcard-family")).code,
    ).toBe(0);
    row.open_renewal_jobs = "1";
    row.serving_valid_until = new Date(Date.now() + 3_600_000);
    expect(
      await run("write-records", "--root", "newroot", "--change", "remove-wildcard-family"),
    ).toMatchObject({
      code: 0,
      report: {
        outcome: "written",
        departs_from_retained_zone: false,
        open_renewal_jobs: 1,
        wildcard_family_after: [],
      },
    });
    expect(provider.rrsets.filter(({ name }) => name === "*.newroot.").length).toBe(2);
    // Once the root retains the records, the directions exchange.
    row.zone_bytes = canonicalZone(8, true);
    row.zone_bytes_digest = await sha256(canonicalZone(8, true));
    expect(
      await run("write-records", "--root", "newroot", "--change", "remove-wildcard-family"),
    ).toMatchObject({ code: 2, report: { outcome: "refused" } });
    expect(
      (await run("write-records", "--root", "newroot", "--change", "add-wildcard-family")).report,
    ).toMatchObject({ outcome: "written", departs_from_retained_zone: false });
  });

  test("status reports a retained zone it cannot read instead of failing", async () => {
    const { run, row } = await world();
    row.zone_bytes = encoder.encode('{"serial":7}');
    row.zone_bytes_digest = await sha256(encoder.encode('{"serial":7}'));
    expect(await run("status", "--root", "newroot")).toMatchObject({
      code: 0,
      report: { outcome: "read", retained_zone_holds_wildcard_family: null },
    });
  });

  test("observe takes a renewal's observation, names the difference, and adopt checks it against the same row", async () => {
    const { run, row, files, statements, provider } = await world();
    const first = await run("observe", "--root", "newroot", "--out", "/var/lib/first.json");
    expect(first.code).toBe(0);
    expect(first.report).toMatchObject({
      outcome: "observed",
      observation: "/var/lib/first.json",
      current_generation: 4,
      zone_equals_retained: false,
      delta: "wildcard_family_added",
      delta_refusal: null,
      // The fixture row's keyset and chain references are placeholders.
      bindings_not_current: ["dnssec_keyset", "stable_chain_delegation_snapshot_reference"],
      ports: [
        { port: "chain", outcome: "returned" },
        { port: "inspect", outcome: "returned" },
        { port: "live", outcome: "returned" },
      ],
    });
    const written = files.get("/var/lib/first.json") ?? new Uint8Array();
    expect(first.report.result_sha256).toBe(await sha256(written));
    // The observation is the renewal kind, bound to the session's own request.
    const decoded = await decodeHnsRootImportReadinessResultV1(written);
    expect(decoded.result).toMatchObject({
      root_import_session_id: "root-import-session",
      provision_result_sha256: row.provision_result_sha256,
      retained_zone_digest_matches: true,
    });
    // It only read the database.
    expect(statements).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT",
      "ROLLBACK",
    ]);
    // An observation file is never overwritten.
    expect(await run("observe", "--root", "newroot", "--out", "/var/lib/first.json")).toMatchObject(
      {
        code: 1,
        // A system error is named by its code; its text is not printed.
        report: { outcome: "failed", reason: "unclassified", error_name: "Error", code: "EEXIST" },
      },
    );

    // Adoption refuses that observation: its references are not the current revision's.
    const adopt = (path: string, digest: unknown, delta: string, mode = "dry-run") =>
      run(
        "adopt",
        "--observation",
        path,
        "--expect-result-sha256",
        String(digest),
        "--expect-delta",
        delta,
        "--mode",
        mode,
      );
    expect(
      await adopt("/var/lib/first.json", first.report.result_sha256, "wildcard_family_added"),
    ).toMatchObject({
      code: 2,
      report: {
        outcome: "refused",
        reason:
          "the observation's keyset, gateway or chain reference is not the current revision's",
      },
    });

    // With the row holding the references the authorities actually present,
    // the same observation passes a dry run, which only reads.
    row.dnssec_keyset_version = decoded.result.dnssec_keyset_version;
    row.stable_chain_delegation_snapshot_reference = `hns-root-chain:${decoded.result.chain_resource_sha256}`;
    const second = await run("observe", "--root", "newroot", "--out", "/var/lib/second.json");
    expect(second.report).toMatchObject({
      bindings_not_current: [],
      delta: "wildcard_family_added",
    });
    statements.length = 0;
    const dryRun = await adopt(
      "/var/lib/second.json",
      second.report.result_sha256,
      "wildcard_family_added",
    );
    expect(dryRun).toMatchObject({
      code: 0,
      report: {
        outcome: "would_adopt",
        committed: false,
        delta: "wildcard_family_added",
        previous_generation: 4,
        next_generation: 5,
        previous_zone_bytes_sha256: row.zone_bytes_digest,
        next_zone_bytes_sha256: second.report.observed_zone_bytes_sha256,
        open_renewal_jobs: 0,
      },
    });
    expect(statements).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY",
      "SET LOCAL lock_timeout TO '10s'",
      "SET LOCAL statement_timeout TO '20s'",
      "SELECT",
      "ROLLBACK",
    ]);

    // A difference other than the one named, and a file other than the one reviewed.
    expect(
      await adopt("/var/lib/second.json", second.report.result_sha256, "serial_only"),
    ).toMatchObject({
      code: 2,
      report: {
        outcome: "refused",
        reason: "the zone difference is wildcard_family_added, not the one intended",
      },
    });
    expect(
      await adopt("/var/lib/second.json", "f".repeat(64), "wildcard_family_added"),
    ).toMatchObject({
      code: 2,
      report: { outcome: "refused", reason: "the observation is not the one that was reviewed" },
    });
    expect(await adopt("/var/lib/missing.json", "f".repeat(64), "serial_only")).toMatchObject({
      code: 1,
      report: { outcome: "failed", reason: "HNS zone adoption observation file is unavailable" },
    });

    // The zone was changed again after it was observed: the primary's serial
    // is no longer the one the observation was taken at.
    provider.serial += 1;
    expect(
      await adopt("/var/lib/second.json", second.report.result_sha256, "wildcard_family_added"),
    ).toMatchObject({
      code: 2,
      report: {
        outcome: "refused",
        reason:
          "the authorities no longer serve the zone that was observed; observe the root again",
      },
    });
  });

  test("observe reports a zone that equals the retained one, or differs in a way adoption does not admit", async () => {
    const { run, live } = await world();
    live.zone = canonicalZone(7, false);
    expect(
      (await run("observe", "--root", "newroot", "--out", "/var/lib/equal.json")).report,
    ).toMatchObject({
      outcome: "observed",
      zone_equals_retained: true,
      delta: null,
      delta_refusal: "the SOA serial did not increase",
    });
    live.zone = encoder.encode(
      new TextDecoder().decode(canonicalZone(8, true)).replace("c000020a", "c0000263"),
    );
    expect(
      (await run("observe", "--root", "newroot", "--out", "/var/lib/other.json")).report,
    ).toMatchObject({
      zone_equals_retained: false,
      delta: null,
      delta_refusal: "the zone changed outside the wildcard address records",
    });
  });

  test("a failed observation names the port that failed without printing what it threw", async () => {
    const { run, live, files } = await world();
    live.fails = Object.assign(new Error("connect to https://authority.test:8443/zone failed"), {
      code: "ECONNREFUSED",
    });
    const failed = await run("observe", "--root", "newroot", "--out", "/var/lib/failed.json");
    expect(failed).toMatchObject({
      code: 2,
      report: {
        outcome: "observation_failed",
        reason: "authority_unavailable",
        ports: [
          { port: "chain", outcome: "returned" },
          { port: "inspect", outcome: "returned" },
          { port: "live", outcome: "threw", reason: "unclassified", code: "ECONNREFUSED" },
        ],
      },
    });
    // Neither a host nor a path from a driver or runtime message is printed.
    expect(JSON.stringify(failed.report)).not.toContain("authority.test");
    expect(files.size).toBe(0);
    live.fails = new Error("HNS authority transfer timed out");
    expect(
      (await run("observe", "--root", "newroot", "--out", "/var/lib/failed.json")).report,
    ).toMatchObject({ ports: [{}, {}, { reason: "HNS authority transfer timed out" }] });
  });

  test("invalid arguments are reported without touching anything", async () => {
    const { run, statements, providerCalls } = await world();
    expect(await run("adopt", "--mode", "commit")).toMatchObject({
      code: 1,
      report: { command: "adopt-zone", outcome: "invalid_arguments" },
    });
    expect(statements).toEqual([]);
    expect(providerCalls).toEqual([]);
  });
});
