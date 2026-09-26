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
});
