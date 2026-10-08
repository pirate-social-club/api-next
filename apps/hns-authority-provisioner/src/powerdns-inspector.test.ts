import { describe, expect, test } from "bun:test";
import { buildManagedRootRrsets, makePowerDnsRootInspector } from "./powerdns.ts";

describe("PowerDNS root inspector", () => {
  test("accepts canonical TLSA hex case while retaining the certificate pin and challenge", async () => {
    const association = "ABCDEF09".repeat(8);
    const config = {
      api_url: "http://powerdns.test:8081",
      api_key: "synthetic-test-key",
      server_id: "localhost",
      soa_content: "ns1.pirate. hostmaster.pirate. 0 3600 900 1209600 300",
      axfr_tsig_key_name: "secondary-transfer.",
      gateway_ipv4: "192.0.2.10",
      shared_tlsa_association: `3 1 1 ${association}`,
      gateway_deployment_reference: "gateway-deployment-v1",
      gateway_certificate_spki_sha256: association.toLowerCase(),
      ttl_seconds: 60,
    };
    const input = { root_label: "newroot", challenge_txt_value: "pirate-verification=expected" };
    const managed = buildManagedRootRrsets({ ...config, ...input });
    let rrsets = managed.map((rrset) => ({
      ...rrset,
      records: rrset.records.map((record) => ({
        ...record,
        content: rrset.type === "TLSA" ? record.content.toLowerCase() : record.content,
      })),
    }));
    const inspect = makePowerDnsRootInspector(config, async (url, init) => {
      expect(init?.method).toBe("GET");
      return String(url).endsWith("/cryptokeys")
        ? Response.json([{ active: true, published: true, ds: [`10875 13 2 ${"a".repeat(64)}`] }])
        : Response.json({ name: "newroot.", serial: 12, dnssec: true, rrsets });
    });

    await expect(inspect(input)).resolves.toMatchObject({ dnssec: true, serial: 12 });

    rrsets = rrsets.map((rrset) =>
      rrset.type === "TLSA" && rrset.name === "_443._tcp.app.newroot."
        ? { ...rrset, records: [{ content: `3 1 1 ${"b".repeat(64)}`, disabled: false }] }
        : rrset,
    );
    await expect(inspect(input)).rejects.toThrow("PowerDNS managed rrset does not match");

    rrsets = managed.map((rrset) => ({
      ...rrset,
      records: rrset.records.map((record) => ({
        ...record,
        content:
          rrset.type === "TXT"
            ? record.content.replace("pirate-verification", "PIRATE-verification")
            : record.content,
      })),
    }));
    await expect(inspect(input)).rejects.toThrow("PowerDNS managed rrset does not match");
  });

  test("reads the managed profile from the zone and requires that whole profile", async () => {
    const config = {
      api_url: "http://powerdns.test:8081",
      api_key: "synthetic-test-key",
      server_id: "localhost",
      soa_content: "ns1.pirate. hostmaster.pirate. 0 3600 900 1209600 300",
      axfr_tsig_key_name: "secondary-transfer.",
      gateway_ipv4: "192.0.2.10",
      shared_tlsa_association: `3 1 1 ${"a".repeat(64)}`,
      gateway_deployment_reference: "gateway-deployment-v1",
      gateway_certificate_spki_sha256: "a".repeat(64),
      ttl_seconds: 60,
    };
    const input = { root_label: "newroot", challenge_txt_value: "pirate-verification=expected" };
    const earlier = buildManagedRootRrsets({ ...config, ...input }, "wildcard-v1");
    const current = buildManagedRootRrsets({ ...config, ...input }, "wildcard-address-family-v2");
    let rrsets: readonly unknown[] = earlier;
    const inspect = makePowerDnsRootInspector(config, async (url) =>
      String(url).endsWith("/cryptokeys")
        ? Response.json([{ active: true, published: true, ds: [`10875 13 2 ${"a".repeat(64)}`] }])
        : Response.json({ name: "newroot.", serial: 12, dnssec: true, rrsets }),
    );

    // A root created before the address-family profile is unchanged, and so is its digest.
    const earlierResult = await inspect(input);
    rrsets = current;
    const currentResult = await inspect(input);
    expect(currentResult.managed_rrset_sha256).not.toBe(earlierResult.managed_rrset_sha256);
    expect(new TextDecoder().decode(earlierResult.managed_zone_bytes)).not.toContain("AAAA");
    expect(new TextDecoder().decode(currentResult.managed_zone_bytes)).toContain("HTTPS");

    // Either address-family record set commits the zone to the whole profile.
    rrsets = current.filter((rrset) => rrset.type !== "HTTPS");
    await expect(inspect(input)).rejects.toThrow("PowerDNS managed rrset is unavailable");
    rrsets = current.filter((rrset) => rrset.type !== "AAAA");
    await expect(inspect(input)).rejects.toThrow("PowerDNS managed rrset is unavailable");
    rrsets = current.map((rrset) =>
      rrset.type === "AAAA"
        ? { ...rrset, records: [{ content: "::ffff:192.0.2.99", disabled: false }] }
        : rrset,
    );
    await expect(inspect(input)).rejects.toThrow("PowerDNS managed rrset does not match");

    // A root with a recorded digest is inspected under that profile whatever
    // else sits at the wildcard owner, as it was before profiles existed: an
    // unmanaged record there must not start failing an existing root.
    const stray = {
      name: "*.newroot.",
      type: "AAAA",
      ttl: 60,
      records: [{ content: "2001:db8::1", disabled: false }],
    };
    rrsets = [...earlier, stray];
    expect(
      (
        await inspect({
          ...input,
          expected_managed_rrset_sha256: earlierResult.managed_rrset_sha256,
        })
      ).managed_rrset_sha256,
    ).toBe(earlierResult.managed_rrset_sha256);
    // Without a recorded digest the same zone reads as the newer profile and is
    // refused, because that record set is not the one the profile manages.
    await expect(inspect(input)).rejects.toThrow("PowerDNS managed rrset does not match");
    // A recorded digest neither profile reproduces leaves the zone to decide,
    // and the result then differs from what was recorded for the caller to report.
    rrsets = current;
    expect(
      (await inspect({ ...input, expected_managed_rrset_sha256: "0".repeat(64) }))
        .managed_rrset_sha256,
    ).toBe(currentResult.managed_rrset_sha256);

    // Unmanaged record sets elsewhere in the zone do not select a profile.
    rrsets = [
      ...earlier,
      {
        name: "other.newroot.",
        type: "AAAA",
        ttl: 60,
        records: [{ content: "2001:db8::1", disabled: false }],
      },
    ];
    expect((await inspect(input)).managed_rrset_sha256).toBe(earlierResult.managed_rrset_sha256);
  });
});
