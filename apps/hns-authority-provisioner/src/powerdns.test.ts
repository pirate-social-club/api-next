import { describe, expect, test } from "bun:test";
import {
  buildManagedRootRrsets,
  makePowerDnsRootProvisioner,
  makePowerDnsRootTeardown,
} from "./powerdns.ts";

describe("PowerDNS managed HNS root rrsets", () => {
  test("uses the fixed authority, gateway, challenge, and shared TLSA profile", () => {
    const rrsets = buildManagedRootRrsets({
      root_label: "newroot",
      challenge_txt_value: 'pirate-verification=a"b\\c',
      gateway_ipv4: "192.0.2.10",
      shared_tlsa_association: `3 1 1 ${"A".repeat(64)}`,
      ttl_seconds: 300,
    });
    expect(rrsets.map(({ name, type }) => `${name} ${type}`)).toEqual([
      "newroot. NS",
      "newroot. A",
      "app.newroot. A",
      "*.newroot. A",
      "_pirate.newroot. TXT",
      "_443._tcp.newroot. TLSA",
      "*.newroot. TLSA",
      "_443._tcp.app.newroot. TLSA",
    ]);
    expect(rrsets[0]?.records.map((record) => record.content)).toEqual([
      "ns1.pirate.",
      "ns2.pirate.",
    ]);
    expect(rrsets[4]?.records[0]?.content).toBe('"pirate-verification=a\\"b\\\\c"');
  });

  test("creates one signed primary, authorizes AXFR, rectifies, notifies, and returns DS", async () => {
    const calls: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> =
      [];
    let zoneGets = 0;
    const provision = makePowerDnsRootProvisioner(
      {
        api_url: "http://powerdns.test:8081",
        api_key: "secret-not-logged",
        server_id: "localhost",
        soa_content: "ns1.pirate. hostmaster.pirate. 0 3600 900 1209600 300",
        axfr_tsig_key_name: "secondary-transfer.",
        gateway_ipv4: "192.0.2.10",
        shared_tlsa_association: `3 1 1 ${"A".repeat(64)}`,
        gateway_deployment_reference: "gateway-deployment-v1",
        gateway_certificate_spki_sha256: "a".repeat(64),
        ttl_seconds: 300,
      },
      async (url, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, url: String(url), body });
        const path = new URL(String(url)).pathname;
        if (method === "GET" && path.endsWith("/zones/newroot.")) {
          zoneGets += 1;
          return zoneGets === 1
            ? new Response(null, { status: 404 })
            : Response.json({ name: "newroot.", serial: 5, dnssec: true });
        }
        if (method === "GET" && path.endsWith("/cryptokeys")) {
          return Response.json([
            {
              active: true,
              published: true,
              ds: [
                `10875 13 1 ${"0".repeat(40)}`,
                `10875 13 2 ${"a".repeat(64)}`,
                `10875 13 4 ${"b".repeat(96)}`,
              ],
            },
            {
              active: true,
              published: true,
              ds: [
                `20000 13 1 ${"1".repeat(40)}`,
                `20000 13 2 ${"c".repeat(64)}`,
                `20000 13 4 ${"d".repeat(96)}`,
              ],
            },
          ]);
        }
        if (method === "POST") return new Response(null, { status: 201 });
        return new Response(null, { status: 204 });
      },
    );
    const result = await provision({
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
    });
    expect(result).toMatchObject({ created: true, dnssec: true, serial: 5 });
    expect(result.ds_records.map((record) => [record.key_tag, record.digest_type])).toEqual([
      [10_875, 2],
      [10_875, 4],
      [20_000, 2],
      [20_000, 4],
    ]);
    expect(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "GET /api/v1/servers/localhost/zones/newroot.",
      "POST /api/v1/servers/localhost/zones",
      "PUT /api/v1/servers/localhost/zones/newroot./metadata/TSIG-ALLOW-AXFR",
      "PUT /api/v1/servers/localhost/zones/newroot./rectify",
      "PUT /api/v1/servers/localhost/zones/newroot./notify",
      "GET /api/v1/servers/localhost/zones/newroot.",
      "GET /api/v1/servers/localhost/zones/newroot./cryptokeys",
    ]);
    expect(calls[1]?.body).toMatchObject({ kind: "Master", dnssec: true, api_rectify: true });
  });

  test("idempotently deletes one exact abandoned root zone", async () => {
    const calls: string[] = [];
    const teardown = makePowerDnsRootTeardown(
      {
        api_url: "http://powerdns.test:8081",
        api_key: "secret-not-logged",
        server_id: "localhost",
      },
      async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return new Response(null, { status: 204 });
      },
    );
    await teardown({ root_label: "newroot" });
    expect(calls).toEqual(["DELETE /api/v1/servers/localhost/zones/newroot."]);
  });
});
