import { describe, expect, test } from "bun:test";
import { decideHnsTeardownRetentionV1 } from "@pirate/application/namespace-ownership";
import {
  buildManagedRootRrsets,
  makePowerDnsRootProvisioner,
  makePowerDnsRootReconciler,
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
    let account = "";
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
            : Response.json({ name: "newroot.", serial: 5, dnssec: true, account });
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
        if (method === "POST") {
          account = body.account;
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 204 });
      },
    );
    const result = await provision({
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      current_records: [],
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

  test("recovers an ambiguous create while refusing another reservation before mutation", async () => {
    const config = {
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
    };
    let account: string | null = null;
    const methods: string[] = [];
    const provision = makePowerDnsRootProvisioner(config, async (url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        account = JSON.parse(String(init?.body)).account;
        throw new Error("response lost after zone commit");
      }
      if (method === "GET" && String(url).endsWith("/cryptokeys"))
        return Response.json([{ active: true, ds: [`10875 13 2 ${"a".repeat(64)}`] }]);
      if (method === "GET")
        return account === null
          ? new Response(null, { status: 404 })
          : Response.json({ name: "newroot.", serial: 5, dnssec: true, account });
      return new Response(null, { status: 204 });
    });
    const input = {
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=first",
      current_records: [],
    };
    await expect(provision(input)).rejects.toThrow("response lost");
    expect(account).toMatch(/^[0-9a-f]{40}$/u);
    methods.length = 0;
    await expect(
      provision({ ...input, challenge_txt_value: "pirate-verification=other" }),
    ).rejects.toThrow("another reservation");
    expect(methods).toEqual(["GET", "GET"]);
    methods.length = 0;
    expect(await provision(input)).toMatchObject({ created: true, dnssec: true });
    expect(methods).not.toContain("POST");
    expect(methods).toContain("PATCH");
    const cleanupMethods: string[] = [];
    let remove = false;
    const teardown = makePowerDnsRootTeardown(config, async (_url, init) => {
      const method = init?.method ?? "GET";
      cleanupMethods.push(method);
      if (method === "DELETE") {
        if (remove) account = null;
        return new Response(null, { status: 204 });
      }
      return account === null
        ? new Response(null, { status: 404 })
        : Response.json({ name: "newroot.", serial: 5, dnssec: true, account });
    });
    await expect(
      teardown({ ...input, challenge_txt_value: "pirate-verification=other" }),
    ).rejects.toThrow("reservation does not match");
    expect(cleanupMethods).toEqual(["GET"]);
    cleanupMethods.length = 0;
    await expect(teardown(input)).rejects.toThrow("remains after teardown");
    expect(cleanupMethods).toEqual(["GET", "DELETE", "GET"]);
    remove = true;
    await teardown(input);
    expect(account).toBeNull();
    cleanupMethods.length = 0;
    await teardown(input);
    expect(cleanupMethods).toEqual(["GET"]);
  });

  test("preserves a matching retained zone until chain ownership is proven", async () => {
    const config = {
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
    };
    const ds = [
      { key_tag: 10_875, algorithm: 13, digest_type: 2 as const, digest: "a".repeat(64) },
      { key_tag: 10_875, algorithm: 13, digest_type: 4 as const, digest: "b".repeat(96) },
    ];
    const calls: string[] = [];
    const fetcher = async (url: Request | string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(url)).pathname;
      calls.push(`${method} ${path}`);
      if (method === "GET" && path.endsWith("/cryptokeys")) {
        return Response.json([
          {
            active: true,
            published: true,
            ds: [`10875 13 2 ${"a".repeat(64)}`, `10875 13 4 ${"b".repeat(96)}`],
          },
        ]);
      }
      if (method === "GET") {
        return Response.json({
          name: "dankmeme.",
          serial: 12,
          dnssec: true,
          account: "older-reservation",
        });
      }
      return new Response(null, { status: 204 });
    };
    const provision = makePowerDnsRootProvisioner(config, fetcher);
    const result = await provision({
      root_label: "dankmeme",
      challenge_txt_value: "pirate-verification=fresh",
      current_records: [
        { type: "NS", ns: "ns1.pirate." },
        { type: "NS", ns: "ns2.pirate." },
        ...ds.map((record) => ({
          type: "DS",
          keyTag: record.key_tag,
          algorithm: record.algorithm,
          digestType: record.digest_type,
          digest: record.digest,
        })),
      ],
    });
    expect(result).toMatchObject({ created: false, ds_records: ds });
    expect(calls).toEqual([
      "GET /api/v1/servers/localhost/zones/dankmeme.",
      "GET /api/v1/servers/localhost/zones/dankmeme./cryptokeys",
    ]);

    calls.length = 0;
    const reconcile = makePowerDnsRootReconciler(config, fetcher);
    await reconcile({
      root_label: "dankmeme",
      challenge_txt_value: "pirate-verification=fresh",
      expected_ds_records: ds,
    });
    expect(calls).toEqual([
      "GET /api/v1/servers/localhost/zones/dankmeme.",
      "GET /api/v1/servers/localhost/zones/dankmeme./cryptokeys",
      "PATCH /api/v1/servers/localhost/zones/dankmeme.",
      "PUT /api/v1/servers/localhost/zones/dankmeme./metadata/TSIG-ALLOW-AXFR",
      "PUT /api/v1/servers/localhost/zones/dankmeme./rectify",
      "PUT /api/v1/servers/localhost/zones/dankmeme./notify",
    ]);
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

describe("teardown variants retain authority unless positive evidence allows retirement (T07)", () => {
  const planDigest = "ab".repeat(32);
  function observed(
    view: "current" | "safe",
    digest: string | null,
  ): import("@pirate/application/namespace-ownership").HnsChainObservationResultV1 {
    return {
      kind: "observed",
      observation: {
        view,
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
        records: [],
        resource_sha256: digest ?? `${"0".repeat(63)}${view === "current" ? "1" : "2"}`,
      },
    };
  }

  test("every teardown variant retains authority when either view references the plan", () => {
    for (const teardown_kind of ["teardown_provisional_root_v1", "teardown_root_v1"] as const) {
      for (const referencingView of ["current", "safe"] as const) {
        const decision = decideHnsTeardownRetentionV1({
          teardown_kind,
          plan_encoded_resource_sha256: planDigest,
          current:
            referencingView === "current"
              ? observed("current", planDigest)
              : observed("current", null),
          safe: referencingView === "safe" ? observed("safe", planDigest) : observed("safe", null),
          positive_absence_evidence: true,
        });
        expect(decision).toMatchObject({
          decision: "retain",
          reason: "chain_reference_retained",
        });
      }
    }
  });

  test("unavailable reads retain authority pending another inspection", () => {
    for (const unavailable of [
      { kind: "unavailable", classification: "transport_failure" },
      { kind: "unavailable", classification: "chain_moving" },
      { kind: "unavailable", classification: "node_stale" },
      { kind: "finding", classification: "resource_absent" },
    ]) {
      const decision = decideHnsTeardownRetentionV1({
        teardown_kind: "teardown_root_v1",
        plan_encoded_resource_sha256: planDigest,
        current: observed("current", null),
        safe: unavailable as never,
        positive_absence_evidence: false,
      });
      expect(decision).toMatchObject({
        decision: "retain",
        reason: "unavailable_chain_state_retained",
      });
    }
  });

  test("chain absence after exposure alone never authorizes deletion", () => {
    const decision = decideHnsTeardownRetentionV1({
      teardown_kind: "teardown_provisional_root_v1",
      plan_encoded_resource_sha256: planDigest,
      current: observed("current", null),
      safe: observed("safe", null),
      positive_absence_evidence: false,
    });
    expect(decision).toEqual({
      decision: "retain",
      reason: "chain_absence_after_exposure_retained",
      inspected_views: ["current", "safe"],
    });
  });

  test("retirement requires positive fresh-inspection evidence", () => {
    const decision = decideHnsTeardownRetentionV1({
      teardown_kind: "teardown_root_v1",
      plan_encoded_resource_sha256: planDigest,
      current: observed("current", null),
      safe: observed("safe", null),
      positive_absence_evidence: true,
    });
    expect(decision).toEqual({
      decision: "retire_eligible",
      reason: "retirement_positive_evidence",
      inspected_views: ["current", "safe"],
    });
  });
});
