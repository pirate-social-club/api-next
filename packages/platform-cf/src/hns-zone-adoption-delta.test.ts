import { describe, expect, test } from "bun:test";
import {
  HnsZoneAdoptionDeltaRefusal,
  requireHnsZoneAdoptionDeltaV1,
} from "./hns-zone-adoption-delta.ts";

type Record = readonly [string, number, 1, number, string];

const root = "newroot";
const wildcard = `*.${root}`;
const hex = (bytes: readonly number[]) =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
const name = (value: string) =>
  hex([
    ...value.split(".").flatMap((label) => [label.length, ...new TextEncoder().encode(label)]),
    0,
  ]);
const uint32 = (value: number) =>
  hex([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const soa = (serial: number, refresh = 3_600) =>
  `${name("ns1.pirate")}${name("hostmaster.pirate")}${uint32(serial)}${uint32(refresh)}${uint32(900)}${uint32(1_209_600)}${uint32(300)}`;
/** NSEC rdata: the next owner and one window-zero bitmap listing the types. */
const nsec = (next: string, types: readonly number[]) => {
  const length = Math.floor(Math.max(...types) / 8) + 1;
  const bitmap = new Array<number>(length).fill(0);
  for (const type of types)
    bitmap[Math.floor(type / 8)] = (bitmap[Math.floor(type / 8)] ?? 0) | (0x80 >> (type % 8));
  return `${name(next)}${hex([0, length, ...bitmap])}`;
};
const gateway = "c000020a";
const httpsService = "0001000001000c02683208687474702f312e31";

function zone(records: readonly Record[], label = root): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: "pirate-hns-canonical-authority-zone-v1",
      root_label: label,
      records,
    }),
  );
}

const retainedRecords = (serial = 7): Record[] => [
  [root, 1, 1, 300, gateway],
  [root, 2, 1, 300, name("ns1.pirate")],
  [root, 6, 1, 300, soa(serial)],
  [root, 47, 1, 300, nsec(wildcard, [1, 2, 6, 46, 47, 48])],
  [root, 48, 1, 300, "0101030d00"],
  [wildcard, 1, 1, 300, gateway],
  [wildcard, 47, 1, 300, nsec(`app.${root}`, [1, 46, 47, 52])],
  [wildcard, 52, 1, 300, `030101${"ab".repeat(32)}`],
  [`app.${root}`, 1, 1, 300, gateway],
  [`app.${root}`, 47, 1, 300, nsec(root, [1, 46, 47])],
];
const adoptedRecords = (serial = 8): Record[] =>
  retainedRecords(serial).flatMap((record): Record[] =>
    record[0] === wildcard && record[1] === 47
      ? [
          [wildcard, 28, 1, 300, `00000000000000000000ffff${gateway}`],
          [wildcard, 47, 1, 300, nsec(`app.${root}`, [1, 28, 46, 47, 52, 65])],
          [wildcard, 65, 1, 300, httpsService],
        ]
      : [record],
  );

const delta = (retained: readonly Record[], observed: readonly Record[]) =>
  requireHnsZoneAdoptionDeltaV1({
    root_label: root,
    retained_zone_bytes: zone(retained),
    observed_zone_bytes: zone(observed),
  });
const replace = (records: readonly Record[], owner: string, type: number, next: Record | null) =>
  records.flatMap((record): Record[] =>
    record[0] === owner && record[1] === type ? (next === null ? [] : [next]) : [record],
  );

describe("zone adoption delta", () => {
  test("admits the two wildcard address records with the serial and the wildcard NSEC they change", () => {
    expect(delta(retainedRecords(), adoptedRecords())).toBe("wildcard_family_added");
    // Record order is not part of the zone.
    expect(delta([...retainedRecords()].reverse(), adoptedRecords())).toBe("wildcard_family_added");
  });

  test("admits the exact reverse as a removal, and nothing short of it", () => {
    expect(delta(adoptedRecords(8), retainedRecords(9))).toBe("wildcard_family_removed");
    expect(() => delta(adoptedRecords(8), retainedRecords(8))).toThrow("did not increase");
    // One of the two records left behind is neither a removal nor an addition.
    const halfRemoved = replace(adoptedRecords(9), wildcard, 28, null);
    expect(() => delta(adoptedRecords(8), halfRemoved)).toThrow(
      "rather than being added or removed",
    );
    // A removal that also changes another record is refused like an addition would be.
    const alsoMoved = replace(retainedRecords(9), `app.${root}`, 1, [
      `app.${root}`,
      1,
      1,
      300,
      "c0000263",
    ]);
    expect(() => delta(adoptedRecords(8), alsoMoved)).toThrow(
      "outside the wildcard address records",
    );
    // The NSEC left after a removal must list exactly the earlier types less the two.
    const staleNsec = replace(retainedRecords(9), wildcard, 47, [
      wildcard,
      47,
      1,
      300,
      nsec(`app.${root}`, [1, 28, 46, 47, 52, 65]),
    ]);
    expect(() => delta(adoptedRecords(8), staleNsec)).toThrow("more than the two added types");
  });

  test("admits a serial that moved with nothing else, in either zone shape", () => {
    expect(delta(retainedRecords(7), retainedRecords(9))).toBe("serial_only");
    expect(delta(adoptedRecords(8), adoptedRecords(11))).toBe("serial_only");
  });

  test("refuses equal zones, an older serial, and any other SOA change", () => {
    expect(() => delta(retainedRecords(7), retainedRecords(7))).toThrow("did not increase");
    expect(() => delta(retainedRecords(7), adoptedRecords(6))).toThrow("did not increase");
    const retuned = replace(adoptedRecords(8), root, 6, [root, 6, 1, 300, soa(8, 7_200)]);
    expect(() => delta(retainedRecords(7), retuned)).toThrow("more than its serial");
    const soaTtl = replace(adoptedRecords(8), root, 6, [root, 6, 1, 60, soa(8)]);
    expect(() => delta(retainedRecords(7), soaTtl)).toThrow("more than its serial");
  });

  test("refuses any record that differs outside the wildcard address records", () => {
    const extra: Record[] = [...adoptedRecords(), [`other.${root}`, 1, 1, 300, gateway]];
    expect(() => delta(retainedRecords(), extra)).toThrow("outside the wildcard address records");
    const moved = replace(adoptedRecords(), `app.${root}`, 1, [
      `app.${root}`,
      1,
      1,
      300,
      "c0000263",
    ]);
    expect(() => delta(retainedRecords(), moved)).toThrow("outside the wildcard address records");
    const dropped = replace(adoptedRecords(), wildcard, 52, null);
    expect(() => delta(retainedRecords(), dropped)).toThrow("outside the wildcard address records");
    // A changed wildcard A is caught as a change outside the family too.
    const readdressed = replace(adoptedRecords(), wildcard, 1, [wildcard, 1, 1, 300, "c0000263"]);
    expect(() => delta(retainedRecords(), readdressed)).toThrow(
      "outside the wildcard address records",
    );
  });

  test("refuses a wildcard AAAA or HTTPS record that is not the expected one", () => {
    const native = replace(adoptedRecords(), wildcard, 28, [
      wildcard,
      28,
      1,
      300,
      `20010db8${"00".repeat(11)}01`,
    ]);
    expect(() => delta(retainedRecords(), native)).toThrow("IPv4-mapped form");
    const withHttp3 = replace(adoptedRecords(), wildcard, 65, [
      wildcard,
      65,
      1,
      300,
      "0001000001000902683302683208687474702f312e31".slice(0, 44),
    ]);
    expect(() => delta(retainedRecords(), withHttp3)).toThrow("expected service binding");
    const shortTtl = replace(adoptedRecords(), wildcard, 65, [wildcard, 65, 1, 60, httpsService]);
    expect(() => delta(retainedRecords(), shortTtl)).toThrow("share the wildcard A record's TTL");
    const onlyOne = replace(adoptedRecords(), wildcard, 65, null);
    expect(() => delta(retainedRecords(), onlyOne)).toThrow("exactly one wildcard HTTPS record");
    const twice: Record[] = [
      ...adoptedRecords(),
      [wildcard, 28, 1, 300, `00000000000000000000ffffc0000263`],
    ];
    expect(() => delta(retainedRecords(), twice)).toThrow("exactly one wildcard AAAA record");
  });

  test("refuses a wildcard NSEC that changed in more than the two added types", () => {
    const stale = replace(adoptedRecords(), wildcard, 47, [
      wildcard,
      47,
      1,
      300,
      nsec(`app.${root}`, [1, 46, 47, 52]),
    ]);
    expect(() => delta(retainedRecords(), stale)).toThrow("more than the two added types");
    const another = replace(adoptedRecords(), wildcard, 47, [
      wildcard,
      47,
      1,
      300,
      nsec(`app.${root}`, [1, 16, 28, 46, 47, 52, 65]),
    ]);
    expect(() => delta(retainedRecords(), another)).toThrow("more than the two added types");
    const elsewhere = replace(adoptedRecords(), wildcard, 47, [
      wildcard,
      47,
      1,
      300,
      nsec(root, [1, 28, 46, 47, 52, 65]),
    ]);
    expect(() => delta(retainedRecords(), elsewhere)).toThrow("more than the two added types");
  });

  test("refuses changed wildcard address records, NSEC3 zones and anything that is not a canonical zone for the root", () => {
    const again = replace(adoptedRecords(9), wildcard, 65, [wildcard, 65, 1, 300, "000100"]);
    expect(() => delta(adoptedRecords(8), again)).toThrow("rather than being added or removed");
    const hashed: Record[] = [...retainedRecords(), [root, 51, 1, 300, "0100000000"]];
    expect(() => delta(hashed, adoptedRecords())).toThrow("NSEC3");
    expect(() =>
      requireHnsZoneAdoptionDeltaV1({
        root_label: root,
        retained_zone_bytes: zone(retainedRecords(), "otherroot"),
        observed_zone_bytes: zone(adoptedRecords()),
      }),
    ).toThrow(HnsZoneAdoptionDeltaRefusal);
    expect(() =>
      requireHnsZoneAdoptionDeltaV1({
        root_label: root,
        retained_zone_bytes: new TextEncoder().encode("{}"),
        observed_zone_bytes: zone(adoptedRecords()),
      }),
    ).toThrow("not a canonical authority zone");
  });
});
