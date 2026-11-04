import { describe, expect, test } from "bun:test";
import { decodeHnsRootImportReadinessResultV1 } from "@pirate/application/namespace-ownership";
import { HnsAuthoritySuccessorPromotionRefusal } from "../../../packages/platform-cf/src/hns-authority-successor-promotion.ts";
import { redateHnsZoneAdoptionFixture } from "../../../packages/platform-cf/src/hns-zone-adoption-fixture.ts";
import { HnsRootReadinessObservationError } from "./observe-root.ts";
import { runHnsZoneAdoptionCommandV1 } from "./zone-adoption-command.ts";
import { canonicalZone, encoder, sha256, world } from "./zone-adoption-command-fixture.ts";
import { describeZoneAdoptionFailure, zoneAdoptionRefusalReason } from "./zone-adoption-errors.ts";

function required<A>(value: A | undefined): A {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}

async function prepared() {
  const w = await world();
  w.provider.serial = 8;
  const first = await w.run("observe", "--root", "newroot", "--out", "/first.json");
  const decoded = await decodeHnsRootImportReadinessResultV1(required(w.files.get("/first.json")));
  w.row.dnssec_keyset_version = decoded.result.dnssec_keyset_version;
  w.row.stable_chain_delegation_snapshot_reference = `hns-root-chain:${decoded.result.chain_resource_sha256}`;
  expect(first.code).toBe(0);
  const adopt = (mode: string) =>
    w.run(
      "adopt",
      "--observation",
      "/first.json",
      "--expect-result-sha256",
      String(first.report.result_sha256),
      "--expect-delta",
      "wildcard_family_added",
      "--mode",
      mode,
    );
  return { ...w, adopt, first };
}

describe("zone adoption writing-mode guards", () => {
  for (const mode of ["rehearse", "commit"]) {
    test(`${mode} refuses changed authority bytes even when the serial does not move`, async () => {
      const w = await prepared();
      w.live.zone = encoder.encode(
        new TextDecoder().decode(canonicalZone(8, true)).replace("c000020a", "c0000263"),
      );
      w.statements.length = 0;
      expect(await w.adopt(mode)).toMatchObject({
        code: 2,
        report: {
          outcome: "refused",
          reason:
            "the authorities no longer serve the zone that was observed; observe the root again",
        },
      });
      expect(w.statements).toContain("SELECT locked");
      expect(w.statements.at(-1)).toBe("ROLLBACK");
      expect(w.statements).not.toContain("COMMIT");
    });
    test(`${mode} refuses secondary disagreement and observer key failure`, async () => {
      const w = await prepared();
      w.live.secondary_zone = canonicalZone(8, false);
      expect(await w.adopt(mode)).toMatchObject({
        code: 2,
        report: { outcome: "refused", reason: "authority_mismatch" },
      });
      w.live.secondary_zone = null;
      w.live.invalid_key = true;
      expect(await w.adopt(mode)).toMatchObject({
        code: 2,
        report: { outcome: "refused", reason: "authority_mismatch" },
      });
      expect(w.statements).not.toContain("COMMIT");
    });
    test(`${mode} rechecks database age after the live observer returns`, async () => {
      const w = await prepared();
      w.clock.finished_offset_ms = 901_000;
      expect(await w.adopt(mode)).toMatchObject({
        code: 2,
        report: { outcome: "refused", reason: "the observation is stale; observe the root again" },
      });
      expect(w.statements).not.toContain("COMMIT");
    });
    test(`${mode} refuses a forged serial and an expired observation before promotion`, async () => {
      for (const change of [
        { powerdns_zone_serial: 9 },
        { observed_at: new Date(Date.now() - 901_000).toISOString() },
        { observed_at: new Date(Date.now() + 30_000).toISOString() },
      ]) {
        const w = await prepared();
        const doc = JSON.parse(new TextDecoder().decode(w.files.get("/first.json")));
        const bytes =
          "observed_at" in change
            ? (
                await redateHnsZoneAdoptionFixture(
                  required(w.files.get("/first.json")),
                  required(change.observed_at),
                )
              ).result_bytes
            : encoder.encode(JSON.stringify({ ...doc, ...change }));
        w.files.set("/altered.json", bytes);
        const outcome = await w.run(
          "adopt",
          "--observation",
          "/altered.json",
          "--expect-result-sha256",
          await sha256(bytes),
          "--expect-delta",
          "wildcard_family_added",
          "--mode",
          mode,
        );
        expect(outcome).toMatchObject({
          code: 2,
          report: {
            outcome: "refused",
            reason:
              "observed_at" in change
                ? "the observation is stale; observe the root again"
                : "the observation serial disagrees with its zone bytes",
          },
        });
        expect(w.statements).not.toContain("COMMIT");
      }
    });
  }
  test("the observation clock is the database clock even when the host configuration is skewed", async () => {
    const w = await world();
    const reports: string[] = [];
    const before = Date.now();
    expect(
      await runHnsZoneAdoptionCommandV1(["observe", "--root", "newroot", "--out", "/clock.json"], {
        ...w.deps,
        observation_config: { ...w.deps.observation_config, now: () => Date.now() + 3_600_000 },
        write: (line) => reports.push(line),
      }),
    ).toBe(0);
    const result = JSON.parse(required(reports[0]));
    expect(Date.parse(result.observed_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.observed_at)).toBeLessThanOrEqual(Date.now());
  });
  test("an interrupted addition can finish after a renewal is queued", async () => {
    const w = await world();
    expect(
      (await w.run("write-records", "--root", "newroot", "--change", "add-wildcard-family")).code,
    ).toBe(0);
    // Model one expected record missing after an interrupted provider write.
    w.provider.rrsets = w.provider.rrsets.filter((set) => set.type !== "HTTPS");
    w.row.open_renewal_jobs = "1";
    w.row.serving_valid_until = new Date(Date.now() + 60_000);
    expect(
      await w.run("write-records", "--root", "newroot", "--change", "add-wildcard-family"),
    ).toMatchObject({ code: 0, report: { outcome: "written", family_state: "complete" } });
    expect(
      await w.run("write-records", "--root", "newroot", "--change", "add-wildcard-family"),
    ).toMatchObject({ code: 0, report: { outcome: "already_as_asked" } });
  });
});

describe("adoption error reporting", () => {
  test("preserves typed promotion and observer refusals without trusting message prefixes", () => {
    expect(
      zoneAdoptionRefusalReason(new HnsAuthoritySuccessorPromotionRefusal("private.test")),
    ).toBe("authority successor promotion refused");
    expect(
      zoneAdoptionRefusalReason(new HnsRootReadinessObservationError("authority_mismatch")),
    ).toBe("authority_mismatch");
    for (const message of [
      "HNS successor private.test",
      "HNS secret_token",
      "PowerDNS privatehostname",
    ]) {
      expect(zoneAdoptionRefusalReason(new Error(message))).toBeNull();
      expect(describeZoneAdoptionFailure(new Error(message)).reason).toBe("unclassified");
    }
    expect(zoneAdoptionRefusalReason(new Error("HNS successor observation is stale"))).toBe(
      "HNS successor observation is stale",
    );
  });
});
