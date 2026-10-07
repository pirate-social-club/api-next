import { describe, expect, test } from "bun:test";
import { HNS_CANONICAL_AUTHORITY_ZONE_VERSION } from "@pirate/hns-dns-runtime/dns-axfr-zone";
import { memberTargetFromZone } from "./member-publication.ts";

const spki = "5c".repeat(32);
type ZoneRecord = readonly [
  owner: string,
  type: number,
  recordClass: number,
  ttl: number,
  rdata: string,
];

// The shape the readiness observer stores: canonical owners without a trailing
// dot, numeric types, and RDATA as hex. Type 1 is A, 2 is NS, 52 is TLSA.
const records: readonly ZoneRecord[] = [
  ["*._tcp.example", 52, 1, 300, `030101${spki}`],
  ["*.example", 1, 1, 300, "c0000207"],
  ["_443._tcp.app.example", 52, 1, 300, `030101${spki}`],
  ["_443._tcp.example", 52, 1, 300, `030101${spki}`],
  ["app.example", 1, 1, 300, "c0000207"],
  ["example", 1, 1, 300, "c0000207"],
  ["example", 2, 1, 300, "036e7331067069726174650000"],
];

const zone = (rows: readonly ZoneRecord[] = records, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: HNS_CANONICAL_AUTHORITY_ZONE_VERSION,
    root_label: "example",
    records: rows,
    ...overrides,
  });

const context = (zoneBytes: string | null, authorized = true) => ({
  root_label: "example",
  handle_label: "member",
  grant_id: "grant-test",
  authorized,
  zone_bytes: zoneBytes,
});

const without = (owner: string, type: number) =>
  records.filter((row) => !(row[0] === owner && row[1] === type));

describe("member target from the accepted zone", () => {
  test("reads the gateway address and certificate association from the canonical zone", () => {
    expect(memberTargetFromZone(context(zone()))).toEqual({
      root_label: "example",
      handle_label: "member",
      grant_id: "grant-test",
      publish: true,
      gateway_ipv4: "192.0.2.7",
      shared_tlsa_association: `3 1 1 ${spki}`,
      ttl_seconds: 300,
    });
    expect(memberTargetFromZone(context(zone(), false)).publish).toBe(false);
  });

  test("is unaffected by member records the zone already carries", () => {
    const withMember: readonly ZoneRecord[] = [
      ...records,
      ["member.example", 1, 1, 300, "c0000207"],
      ["_443._tcp.member.example", 52, 1, 300, `030101${spki}`],
    ];
    expect(memberTargetFromZone(context(zone(withMember))).gateway_ipv4).toBe("192.0.2.7");
  });

  test("refuses a provider rrset list, which is not what readiness stores", () => {
    const providerShape = JSON.stringify([
      {
        name: "example.",
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.7", disabled: false }],
      },
    ]);
    expect(() => memberTargetFromZone(context(providerShape))).toThrow("zone is invalid");
  });

  test("refuses a zone it cannot attribute to this root and format", () => {
    expect(() => memberTargetFromZone(context(null))).toThrow("zone is unavailable");
    expect(() => memberTargetFromZone(context(zone(records, { version: "other" })))).toThrow(
      "zone is invalid",
    );
    expect(() => memberTargetFromZone(context(zone(records, { root_label: "other" })))).toThrow(
      "zone is invalid",
    );
    expect(() => memberTargetFromZone(context(zone(records, { records: "none" })))).toThrow(
      "zone is invalid",
    );
  });

  test("refuses an absent, ambiguous or inconsistent apex record set", () => {
    expect(() => memberTargetFromZone(context(zone(without("example", 1))))).toThrow(
      "rrset is invalid",
    );
    expect(() =>
      memberTargetFromZone(context(zone([...records, ["example", 1, 1, 300, "c0000208"]]))),
    ).toThrow("rrset is invalid");
    expect(() =>
      memberTargetFromZone(
        context(zone([...without("example", 1), ["example", 1, 1, 60, "c0000207"]])),
      ),
    ).toThrow("ttl differs");
    expect(() =>
      memberTargetFromZone(
        context(zone([...without("example", 1), ["example", 1, 1, 300, "c00002"]])),
      ),
    ).toThrow("address is invalid");
    expect(() =>
      memberTargetFromZone(
        context(
          zone([
            ...without("_443._tcp.example", 52),
            ["_443._tcp.example", 52, 1, 300, `030201${spki}`],
          ]),
        ),
      ),
    ).toThrow("TLSA profile is unsupported");
  });
});
