import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@pirate/domain";
import {
  buildManagedRootRrsets,
  makePowerDnsRootInspector,
  makePowerDnsWildcardFamilyWriter,
  PowerDnsManagedProfileMismatchError,
} from "./powerdns.ts";

const config = {
  api_url: "http://powerdns.test:8081",
  api_key: "secret-not-logged",
  server_id: "localhost",
  soa_content: "ns1.pirate. hostmaster.pirate. 0 3600 900 1209600 300",
  axfr_tsig_key_name: "secondary-transfer.",
  gateway_ipv4: "192.0.2.10",
  shared_tlsa_association: `3 1 1 ${"a".repeat(64)}`,
  gateway_deployment_reference: "gateway-deployment-v1",
  gateway_certificate_spki_sha256: "a".repeat(64),
  ttl_seconds: 300,
};
const root = { root_label: "newroot", challenge_txt_value: "pirate-verification=session" };
const ds = [{ key_tag: 10_875, algorithm: 13, digest_type: 2 as const, digest: "a".repeat(64) }];
type Stored = { name: string; type: string; ttl?: number; records?: unknown; changetype?: string };

const digestOf = async (profile: "wildcard-v1" | "wildcard-address-family-v2") =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          canonicalJson(buildManagedRootRrsets({ ...config, ...root }, profile)),
        ),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** A provider that keeps what it is given and moves its serial on every change. */
function provider(
  rrsets: readonly Stored[],
  options: {
    failOnce?: string;
    frozenSerial?: boolean;
    dsText?: string;
    serialPolicy?: string;
  } = {},
) {
  const zone = { serial: 7, rrsets: [...rrsets] };
  const calls: string[] = [];
  let failOnce = options.failOnce;
  const fetcher = async (url: Request | string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    const call = `${method} ${path.split("/zones/")[1] ?? path}`;
    calls.push(call);
    if (failOnce !== undefined && call === failOnce) {
      failOnce = undefined;
      return new Response(null, { status: 500 });
    }
    if (method === "GET" && path.endsWith("/cryptokeys"))
      return Response.json([
        { active: true, published: true, ds: [options.dsText ?? `10875 13 2 ${"a".repeat(64)}`] },
      ]);
    if (method === "GET")
      return Response.json({
        name: "newroot.",
        dnssec: true,
        soa_edit_api: options.serialPolicy ?? "DEFAULT",
        ...zone,
      });
    if (method === "PATCH") {
      const changed: Stored[] = JSON.parse(String(init?.body)).rrsets;
      zone.rrsets = [
        ...zone.rrsets.filter(
          (kept) => !changed.some((next) => next.name === kept.name && next.type === kept.type),
        ),
        ...changed.filter((next) => next.changetype !== "DELETE"),
      ];
      if (options.frozenSerial !== true) zone.serial += 1;
    }
    return new Response(null, { status: 204 });
  };
  const wildcardTypes = () =>
    zone.rrsets
      .filter(({ name }) => name === "*.newroot.")
      .map(({ type }) => type)
      .sort();
  return { fetcher, calls, wildcardTypes, zone };
}

const earlierZone = () => buildManagedRootRrsets({ ...config, ...root }, "wildcard-v1");
const request = async (change: "add" | "remove") => ({
  ...root,
  expected_ds_records: ds,
  expected_managed_rrset_sha256: await digestOf("wildcard-v1"),
  change,
  retained_serial: 7,
  retained_family: false,
});

describe("PowerDNS wildcard address family writer", () => {
  test("adds the two record sets a new zone gets, rectifies, notifies, and leaves the root's profile alone", async () => {
    const pdns = provider(earlierZone());
    const result = await makePowerDnsWildcardFamilyWriter(
      config,
      pdns.fetcher,
    )(await request("add"));
    expect(result).toEqual({
      changed: true,
      family_state: "complete",
      serial_before: 7,
      serial_after: 8,
      wildcard_family_before: [],
      wildcard_family_after: [
        { type: "AAAA", ttl: 300, records: ["::ffff:192.0.2.10"] },
        { type: "HTTPS", ttl: 300, records: ["1 . alpn=h2,http/1.1"] },
      ],
    });
    expect(pdns.wildcardTypes()).toEqual(["A", "AAAA", "HTTPS", "TLSA"]);
    expect(pdns.calls).toEqual([
      "GET newroot.",
      "GET newroot./cryptokeys",
      "PATCH newroot.",
      "PUT newroot./rectify",
      "PUT newroot./notify",
      "GET newroot.",
    ]);
    // The root is still inspected under the profile its provision result recorded.
    expect(
      (
        await makePowerDnsRootInspector(
          config,
          pdns.fetcher,
        )({
          ...root,
          expected_managed_rrset_sha256: await digestOf("wildcard-v1"),
        })
      ).managed_rrset_sha256,
    ).toBe(await digestOf("wildcard-v1"));
  });

  test("removes exactly those two record sets again", async () => {
    const pdns = provider(earlierZone());
    const write = makePowerDnsWildcardFamilyWriter(config, pdns.fetcher);
    await write(await request("add"));
    const removed = await write(await request("remove"));
    expect(removed).toMatchObject({
      changed: true,
      serial_before: 8,
      serial_after: 9,
      wildcard_family_after: [],
    });
    expect(pdns.wildcardTypes()).toEqual(["A", "TLSA"]);
  });

  test("a zone already as asked is not written again but is still rectified and notified", async () => {
    const pdns = provider(earlierZone(), { failOnce: "PUT newroot./rectify" });
    const write = makePowerDnsWildcardFamilyWriter(config, pdns.fetcher);
    // The first run writes and then stops at rectification.
    await expect(write(await request("add"))).rejects.toThrow("rectification failed");
    expect(pdns.wildcardTypes()).toEqual(["A", "AAAA", "HTTPS", "TLSA"]);
    pdns.calls.length = 0;
    // Running it again finishes the two remaining steps without another write.
    expect(await write(await request("add"))).toMatchObject({
      changed: false,
      serial_before: 8,
      serial_after: 8,
    });
    expect(pdns.calls).toEqual([
      "GET newroot.",
      "GET newroot./cryptokeys",
      "PUT newroot./rectify",
      "PUT newroot./notify",
      "GET newroot.",
    ]);
    pdns.calls.length = 0;
    expect((await write(await request("remove"))).changed).toBe(true);
    pdns.calls.length = 0;
    expect((await write(await request("remove"))).changed).toBe(false);
    expect(pdns.calls).not.toContain("PATCH newroot.");
  });

  test("refuses before any write when the zone is not the retained one", async () => {
    const writes = (calls: readonly string[]) => calls.filter((call) => !call.startsWith("GET"));

    // Other record sets at the two types were not put there by this code.
    const foreign = provider([
      ...earlierZone(),
      {
        name: "*.newroot.",
        type: "AAAA",
        ttl: 300,
        records: [{ content: "2001:db8::1", disabled: false }],
      },
    ]);
    const foreignWrite = makePowerDnsWildcardFamilyWriter(config, foreign.fetcher);
    await expect(foreignWrite(await request("add"))).rejects.toThrow("not the expected ones");
    await expect(foreignWrite(await request("remove"))).rejects.toThrow("not the expected ones");
    expect(writes(foreign.calls)).toEqual([]);

    // A managed record set that changed.
    const drifted = provider(
      earlierZone().map((set) =>
        set.name === "app.newroot." && set.type === "A"
          ? { ...set, records: [{ content: "192.0.2.99", disabled: false }] }
          : set,
      ),
    );
    await expect(
      makePowerDnsWildcardFamilyWriter(config, drifted.fetcher)(await request("add")),
    ).rejects.toThrow("managed rrset does not match");
    expect(writes(drifted.calls)).toEqual([]);

    // DNSSEC keys other than the provisioned ones.
    const rekeyed = provider(earlierZone(), { dsText: `10875 13 2 ${"b".repeat(64)}` });
    await expect(
      makePowerDnsWildcardFamilyWriter(config, rekeyed.fetcher)(await request("add")),
    ).rejects.toThrow("key changed after preparation");
    expect(writes(rekeyed.calls)).toEqual([]);

    // A root provisioned under the newer profile holds the record sets as
    // managed ones, and configuration that reproduces neither profile is a
    // mismatch.
    const current = provider(
      buildManagedRootRrsets({ ...config, ...root }, "wildcard-address-family-v2"),
    );
    const currentWrite = makePowerDnsWildcardFamilyWriter(config, current.fetcher);
    await expect(
      currentWrite({
        ...(await request("remove")),
        expected_managed_rrset_sha256: await digestOf("wildcard-address-family-v2"),
      }),
    ).rejects.toThrow("belong to the root's managed profile");
    await expect(
      currentWrite({ ...(await request("add")), expected_managed_rrset_sha256: "f".repeat(64) }),
    ).rejects.toBeInstanceOf(PowerDnsManagedProfileMismatchError);
    expect(writes(current.calls)).toEqual([]);
  });

  test("refuses, before any write, a zone that serial policy is not DEFAULT or INCREASE", async () => {
    // Such a zone would be changed without the secondary transferring it, and
    // a second run, finding the records present, could not tell.
    for (const serialPolicy of ["", "EPOCH", "SOA-EDIT", "unknown"]) {
      const pdns = provider(earlierZone(), { serialPolicy });
      await expect(
        makePowerDnsWildcardFamilyWriter(config, pdns.fetcher)(await request("add")),
      ).rejects.toThrow("serial policy is not DEFAULT or INCREASE");
      expect(pdns.calls).toEqual(["GET newroot."]);
      expect(pdns.wildcardTypes()).toEqual(["A", "TLSA"]);
    }
  });

  test("still reports a serial that did not advance after a write", async () => {
    const pdns = provider(earlierZone(), { frozenSerial: true });
    await expect(
      makePowerDnsWildcardFamilyWriter(config, pdns.fetcher)(await request("add")),
    ).rejects.toThrow("serial did not advance");
    const beforeRetry = pdns.calls.length;
    await expect(
      makePowerDnsWildcardFamilyWriter(config, pdns.fetcher)(await request("add")),
    ).rejects.toThrow("no serial newer than the retained zone");
    expect(pdns.calls.slice(beforeRetry).every((call) => call.startsWith("GET"))).toBe(true);
  });
});
