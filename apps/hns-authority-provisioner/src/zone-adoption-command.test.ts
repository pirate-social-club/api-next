import { describe, expect, test } from "bun:test";
import { decodeHnsRootImportReadinessResultV1 } from "@pirate/application/namespace-ownership";
import {
  HNS_ZONE_ADOPTION_DEFAULT_MINIMUM_VALIDITY_SECONDS,
  parseHnsZoneAdoptionArgumentsV1,
} from "./zone-adoption-command.ts";
import { canonicalZone, encoder, sha256, world } from "./zone-adoption-command-fixture.ts";

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

  test("write-records refuses before a provider mutation, a departing change with an open renewal job or too close to expiry", async () => {
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
    expect(providerCalls.every((call) => call.startsWith("GET"))).toBe(true);
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
    expect(providerCalls.every((call) => call.startsWith("GET"))).toBe(true);
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
    ).toMatchObject({ code: 0, report: { outcome: "already_as_asked" } });
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
    provider.serial = 8;
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
      "SELECT clock_timestamp() AS database_time",
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
