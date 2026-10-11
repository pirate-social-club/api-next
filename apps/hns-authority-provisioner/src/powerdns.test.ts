import { describe, expect, test } from "bun:test";
import {
  decideHnsTeardownRetentionV1,
  type HnsRootResourceRecordV1,
  hnsChainResourceDigestV1,
  preflightEncodeHnsResourceV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import {
  buildManagedRootRrsets,
  HNS_MANAGED_RECORD_PROFILE_FOR_NEW_ZONES,
  makePowerDnsRootInspector,
  makePowerDnsRootProvisioner,
  makePowerDnsRootReconciler,
  makePowerDnsRootTeardown,
  PowerDnsManagedProfileMismatchError,
  reservationAccount,
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

  test("the address-family profile adds only a wildcard AAAA and a wildcard HTTPS record set", () => {
    const input = {
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=challenge",
      gateway_ipv4: "192.0.2.10",
      shared_tlsa_association: `3 1 1 ${"A".repeat(64)}`,
      ttl_seconds: 300,
    };
    const earlier = buildManagedRootRrsets(input, "wildcard-v1");
    const current = buildManagedRootRrsets(input, "wildcard-address-family-v2");
    expect(buildManagedRootRrsets(input)).toEqual(earlier);
    expect(HNS_MANAGED_RECORD_PROFILE_FOR_NEW_ZONES).toBe("wildcard-address-family-v2");
    expect(current.slice(0, earlier.length)).toEqual([...earlier]);
    // The AAAA is the IPv4-mapped gateway address, so no IPv6 host is needed;
    // the HTTPS record points a client back at the name's own addresses.
    expect(JSON.parse(JSON.stringify(current.slice(earlier.length)))).toEqual([
      {
        name: "*.newroot.",
        type: "AAAA",
        ttl: 300,
        changetype: "REPLACE",
        records: [{ content: "::ffff:192.0.2.10", disabled: false }],
      },
      {
        name: "*.newroot.",
        type: "HTTPS",
        ttl: 300,
        changetype: "REPLACE",
        records: [{ content: "1 . alpn=h2,http/1.1", disabled: false }],
      },
    ]);
  });

  test("serves the configured staging authority names at the zone apex", () => {
    const rrsets = buildManagedRootRrsets({
      root_label: "newroot",
      challenge_txt_value: "pirate-verification=staging",
      gateway_ipv4: "192.0.2.10",
      shared_tlsa_association: `3 1 1 ${"A".repeat(64)}`,
      ttl_seconds: 300,
      nameservers: ["ns1.staging-hns.", "ns2.staging-hns."],
    });
    expect(rrsets[0]?.records.map((record) => record.content)).toEqual([
      "ns1.staging-hns.",
      "ns2.staging-hns.",
    ]);
  });

  test("serves in-bailiwick nameserver addresses from the signed zone", () => {
    const rrsets = buildManagedRootRrsets({
      root_label: "8s28",
      challenge_txt_value: "pirate-verification=staging",
      gateway_ipv4: "81.15.150.167",
      shared_tlsa_association: `3 1 1 ${"A".repeat(64)}`,
      ttl_seconds: 300,
      nameservers: ["ns1.8s28.", "ns2.8s28."],
      glue_records: [
        { type: "GLUE4", ns: "ns1.8s28.", address: "81.15.150.167" },
        { type: "GLUE4", ns: "ns2.8s28.", address: "94.103.168.209" },
      ],
    });
    expect(
      rrsets.slice(0, 3).map(({ name, type, records }) => ({
        name,
        type,
        content: records.map((record) => record.content),
      })),
    ).toEqual([
      { name: "8s28.", type: "NS", content: ["ns1.8s28.", "ns2.8s28."] },
      { name: "ns1.8s28.", type: "A", content: ["81.15.150.167"] },
      { name: "ns2.8s28.", type: "A", content: ["94.103.168.209"] },
    ]);
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
    let stored: readonly { name: string; type: string }[] = [];
    let patched: readonly { name: string; type: string }[] = [];
    const methods: string[] = [];
    const provision = makePowerDnsRootProvisioner(config, async (url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        // The provider committed the zone and its record sets; only the response was lost.
        const body = JSON.parse(String(init?.body));
        account = body.account;
        stored = body.rrsets;
        throw new Error("response lost after zone commit");
      }
      if (method === "PATCH") patched = JSON.parse(String(init?.body)).rrsets;
      if (method === "GET" && String(url).endsWith("/cryptokeys"))
        return Response.json([{ active: true, ds: [`10875 13 2 ${"a".repeat(64)}`] }]);
      if (method === "GET")
        return account === null
          ? new Response(null, { status: 404 })
          : Response.json({ name: "newroot.", serial: 5, dnssec: true, account, rrsets: stored });
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
    const recovered = await provision(input);
    expect(recovered).toMatchObject({ created: true, dnssec: true });
    expect(methods).not.toContain("POST");
    expect(methods).toContain("PATCH");
    // The zone was created with the current profile, and the retry keeps it:
    // the same record sets are written again and the result records their digest.
    const current = buildManagedRootRrsets({ ...config, ...input }, "wildcard-address-family-v2");
    expect(stored.slice(1).map(({ name, type }) => `${name} ${type}`)).toEqual(
      current.map(({ name, type }) => `${name} ${type}`),
    );
    expect(patched).toEqual(JSON.parse(JSON.stringify(current)));
    expect(new TextDecoder().decode(recovered.managed_zone_bytes)).toContain("::ffff:192.0.2.10");
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
    const patches: { name: string; type: string }[][] = [];
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
          rrsets: [],
        });
      }
      if (method === "PATCH") patches.push(JSON.parse(String(init?.body)).rrsets);
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
    const reconcileInput = {
      root_label: "dankmeme",
      challenge_txt_value: "pirate-verification=fresh",
      expected_ds_records: ds,
    };
    // An adopted zone is recorded with the current profile, and reconciliation
    // writes the profile the provision result recorded.
    await reconcile({
      ...reconcileInput,
      expected_managed_rrset_sha256: result.managed_rrset_sha256,
    });
    expect(calls).toEqual([
      "GET /api/v1/servers/localhost/zones/dankmeme.",
      "GET /api/v1/servers/localhost/zones/dankmeme./cryptokeys",
      "PATCH /api/v1/servers/localhost/zones/dankmeme.",
      "PUT /api/v1/servers/localhost/zones/dankmeme./metadata/TSIG-ALLOW-AXFR",
      "PUT /api/v1/servers/localhost/zones/dankmeme./rectify",
      "PUT /api/v1/servers/localhost/zones/dankmeme./notify",
    ]);
    const types = (rrsets: readonly { name: string; type: string }[] | undefined) =>
      (rrsets ?? []).filter(({ name }) => name === "*.dankmeme.").map(({ type }) => type);
    expect(types(patches[0])).toEqual(["A", "TLSA", "AAAA", "HTTPS"]);

    // A root provisioned before the profile existed keeps its own record sets.
    const earlier = buildManagedRootRrsets({ ...config, ...reconcileInput }, "wildcard-v1");
    const earlierDigest = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(earlier))),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await reconcile({ ...reconcileInput, expected_managed_rrset_sha256: earlierDigest });
    expect(types(patches[1])).toEqual(["A", "TLSA"]);

    // A digest neither profile reproduces means the configuration changed since
    // provisioning; nothing is written and the caller is told which failure it is.
    calls.length = 0;
    await expect(
      reconcile({ ...reconcileInput, expected_managed_rrset_sha256: "0".repeat(64) }),
    ).rejects.toBeInstanceOf(PowerDnsManagedProfileMismatchError);
    expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([]);

    // The digest is required by type. A caller that reaches the reconciler
    // without one anyway is refused the same way; the zone never decides what
    // reconciliation writes.
    calls.length = 0;
    await expect(
      reconcile(
        reconcileInput as typeof reconcileInput & { expected_managed_rrset_sha256: string },
      ),
    ).rejects.toBeInstanceOf(PowerDnsManagedProfileMismatchError);
    expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
  });

  test("provision, reconciliation and inspection agree on one profile for each kind of root", async () => {
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
    const input = { root_label: "newroot", challenge_txt_value: "pirate-verification=session" };
    const dsText = `10875 13 2 ${"a".repeat(64)}`;
    type Stored = { name: string; type: string; ttl: number; records: unknown };
    // A provider that keeps what it is given: create stores the record sets,
    // a patch replaces whole record sets, and every read returns them.
    const provider = (initial: { account: string; rrsets: readonly Stored[] } | null) => {
      let zone =
        initial === null ? null : { account: initial.account, rrsets: [...initial.rrsets] };
      const writes: string[] = [];
      const fetcher = async (url: Request | string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        if (method === "GET" && path.endsWith("/cryptokeys"))
          return Response.json([{ active: true, published: true, ds: [dsText] }]);
        if (method === "GET")
          return zone === null
            ? new Response(null, { status: 404 })
            : Response.json({ name: "newroot.", serial: 7, dnssec: true, ...zone });
        if (method === "POST") {
          if (zone !== null) return new Response(null, { status: 409 });
          const body = JSON.parse(String(init?.body));
          zone = { account: body.account, rrsets: body.rrsets };
          writes.push("POST");
          return Response.json({}, { status: 201 });
        }
        if (method === "PATCH" && zone !== null) {
          const changed: Stored[] = JSON.parse(String(init?.body)).rrsets;
          zone.rrsets = [
            ...zone.rrsets.filter(
              (kept) => !changed.some((next) => next.name === kept.name && next.type === kept.type),
            ),
            ...changed,
          ];
          writes.push("PATCH");
        }
        return new Response(null, { status: 204 });
      };
      const wildcardTypes = () =>
        (zone?.rrsets ?? [])
          .filter(({ name }) => name === "*.newroot.")
          .map(({ type }) => type)
          .sort();
      return { fetcher, writes, wildcardTypes };
    };
    const through = async (
      fetcher: ReturnType<typeof provider>["fetcher"],
      currentRecords: Parameters<
        ReturnType<typeof makePowerDnsRootProvisioner>
      >[0]["current_records"],
    ) => {
      const provisioned = await makePowerDnsRootProvisioner(
        config,
        fetcher,
      )({
        ...input,
        current_records: currentRecords,
      });
      await makePowerDnsRootReconciler(
        config,
        fetcher,
      )({
        ...input,
        expected_ds_records: provisioned.ds_records,
        expected_managed_rrset_sha256: provisioned.managed_rrset_sha256,
      });
      const inspected = await makePowerDnsRootInspector(
        config,
        fetcher,
      )({
        ...input,
        expected_managed_rrset_sha256: provisioned.managed_rrset_sha256,
      });
      return { provisioned, inspected };
    };
    const digestOf = async (profile: "wildcard-v1" | "wildcard-address-family-v2") =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              canonicalJson(buildManagedRootRrsets({ ...config, ...input }, profile)),
            ),
          ),
        ),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const earlier = await digestOf("wildcard-v1");
    const current = await digestOf("wildcard-address-family-v2");
    const reservation = await reservationAccount(input.challenge_txt_value);
    const earlierZone = buildManagedRootRrsets({ ...config, ...input }, "wildcard-v1");

    // A new root is created, reconciled and inspected under the current profile.
    const fresh = provider(null);
    const created = await through(fresh.fetcher, []);
    expect(created.provisioned.managed_rrset_sha256).toBe(current);
    expect(created.inspected.managed_rrset_sha256).toBe(current);
    expect(fresh.wildcardTypes()).toEqual(["A", "AAAA", "HTTPS", "TLSA"]);

    // A root whose zone this session created under the earlier profile keeps it
    // through a provisioning retry, reconciliation and inspection: no record
    // set is added, so its retained zone and its digest stay what they were.
    const retained = provider({ account: reservation, rrsets: earlierZone });
    const kept = await through(retained.fetcher, []);
    expect(kept.provisioned.managed_rrset_sha256).toBe(earlier);
    expect(kept.inspected.managed_rrset_sha256).toBe(earlier);
    expect(retained.wildcardTypes()).toEqual(["A", "TLSA"]);
    expect(retained.writes).not.toContain("POST");

    // A root imported again over a zone from an earlier session records the
    // current profile before any write, and reconciliation then brings the
    // zone to it.
    const adopted = provider({ account: "earlier-reservation", rrsets: earlierZone });
    const provision = makePowerDnsRootProvisioner(config, adopted.fetcher);
    const result = await provision({
      ...input,
      current_records: [
        { type: "NS", ns: "ns1.pirate." },
        { type: "NS", ns: "ns2.pirate." },
        { type: "DS", keyTag: 10_875, algorithm: 13, digestType: 2, digest: "a".repeat(64) },
      ],
    });
    expect(result).toMatchObject({ created: false, managed_rrset_sha256: current });
    expect(adopted.writes).toEqual([]);
    expect(adopted.wildcardTypes()).toEqual(["A", "TLSA"]);
    await makePowerDnsRootReconciler(
      config,
      adopted.fetcher,
    )({
      ...input,
      expected_ds_records: result.ds_records,
      expected_managed_rrset_sha256: result.managed_rrset_sha256,
    });
    expect(adopted.wildcardTypes()).toEqual(["A", "AAAA", "HTTPS", "TLSA"]);
    expect(
      (
        await makePowerDnsRootInspector(
          config,
          adopted.fetcher,
        )({
          ...input,
          expected_managed_rrset_sha256: result.managed_rrset_sha256,
        })
      ).managed_rrset_sha256,
    ).toBe(current);
  });

  test("a create that loses a race to the same reservation keeps the profile already in the zone", async () => {
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
    const input = { root_label: "newroot", challenge_txt_value: "pirate-verification=session" };
    const account = await reservationAccount(input.challenge_txt_value);
    const earlierZone = buildManagedRootRrsets({ ...config, ...input }, "wildcard-v1");
    let reads = 0;
    let patched: readonly { name: string; type: string }[] = [];
    const provision = makePowerDnsRootProvisioner(config, async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && String(url).endsWith("/cryptokeys"))
        return Response.json([{ active: true, ds: [`10875 13 2 ${"a".repeat(64)}`] }]);
      // The first read finds nothing; another executor of this session then creates the zone.
      if (method === "GET")
        return reads++ === 0
          ? new Response(null, { status: 404 })
          : Response.json({
              name: "newroot.",
              serial: 3,
              dnssec: true,
              account,
              rrsets: earlierZone,
            });
      if (method === "POST") return new Response(null, { status: 409 });
      if (method === "PATCH") patched = JSON.parse(String(init?.body)).rrsets;
      return new Response(null, { status: 204 });
    });
    const result = await provision({ ...input, current_records: [] });
    expect(result.created).toBe(true);
    expect(patched.filter(({ name }) => name === "*.newroot.").map(({ type }) => type)).toEqual([
      "A",
      "TLSA",
    ]);
    expect(new TextDecoder().decode(result.managed_zone_bytes)).not.toContain("AAAA");
  });

  test("idempotently deletes one exact abandoned root zone and confirms it is gone", async () => {
    const calls: string[] = [];
    const teardown = makePowerDnsRootTeardown(
      {
        api_url: "http://powerdns.test:8081",
        api_key: "secret-not-logged",
        server_id: "localhost",
      },
      async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${new URL(String(url)).pathname}`);
        // A real authority answers the read-back for a deleted zone with 404.
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
      },
    );
    await teardown({ root_label: "newroot" });
    expect(calls).toEqual([
      "DELETE /api/v1/servers/localhost/zones/newroot.",
      "GET /api/v1/servers/localhost/zones/newroot.",
    ]);
  });

  test("a response body that never finishes rejects at the deadline and aborts the exchange", async () => {
    let signal: AbortSignal | undefined;
    const teardown = makePowerDnsRootTeardown(
      {
        api_url: "http://powerdns.test:8081",
        api_key: "secret-not-logged",
        server_id: "localhost",
      },
      async (_url, init) => {
        signal = init?.signal ?? undefined;
        // Headers arrive, then the body stalls with no underlying handle.
        return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
          status: 204,
        });
      },
    );
    const started = Date.now();
    await expect(teardown({ root_label: "newroot" })).rejects.toThrow("PowerDNS request timed out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(signal?.aborted).toBe(true);
  }, 10_000);

  test("an exchange that fails before reading its body releases it at once", async () => {
    let signal: AbortSignal | undefined;
    const teardown = makePowerDnsRootTeardown(
      {
        api_url: "http://powerdns.test:8081",
        api_key: "secret-not-logged",
        server_id: "localhost",
      },
      async (_url, init) => {
        signal = init?.signal ?? undefined;
        // A body over the read limit is refused before it is consumed.
        return new Response(new Uint8Array(1_048_577), { status: 200 });
      },
    );
    const started = Date.now();
    await expect(teardown({ root_label: "newroot" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signal?.aborted).toBe(true);
  });

  test("a zone still present after the delete is an ambiguous teardown, not a completed one", async () => {
    // Quota is released on a completed teardown, so a 2xx that did not
    // actually remove the zone must not be reported as success: the
    // reservation has to stay held for reconciliation.
    const teardown = makePowerDnsRootTeardown(
      {
        api_url: "http://powerdns.test:8081",
        api_key: "secret-not-logged",
        server_id: "localhost",
      },
      async (_url, init) =>
        (init?.method ?? "GET") === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(
              JSON.stringify({
                name: "newroot.",
                kind: "Native",
                serial: 1,
                dnssec: true,
                rrsets: [],
                account: "",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
    );
    await expect(teardown({ root_label: "newroot" })).rejects.toThrow(
      "PowerDNS zone remains after teardown",
    );
  });
});

describe("teardown variants retain authority unless positive evidence allows retirement (T07)", () => {
  function observed(
    view: "current" | "safe",
    digest: string | null,
    records: readonly HnsRootResourceRecordV1[] = [],
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
        records,
        resource_sha256: digest ?? `${"0".repeat(63)}${view === "current" ? "1" : "2"}`,
      },
    };
  }

  test("every teardown variant retains real authority records despite distinct JSON and wire digests", async () => {
    const records = [
      { type: "NS", ns: "ns1.pirate." },
      { type: "TXT", txt: ["unrelated"] },
    ];
    const observedDigest = await hnsChainResourceDigestV1(records);
    const wire = await preflightEncodeHnsResourceV1(records);
    expect(observedDigest).not.toBe(wire.sha256);
    for (const teardown_kind of ["teardown_provisional_root_v1", "teardown_root_v1"] as const) {
      for (const referencingView of ["current", "safe"] as const) {
        const decision = decideHnsTeardownRetentionV1({
          teardown_kind,
          authority: {
            ns_names: ["ns1.pirate."],
            ds: [],
            challenge_txt_value: null,
          },
          current:
            referencingView === "current"
              ? observed("current", observedDigest, records)
              : observed("current", null),
          safe:
            referencingView === "safe"
              ? observed("safe", observedDigest, records)
              : observed("safe", null),
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
        authority: {
          ns_names: [],
          ds: [],
          challenge_txt_value: null,
        },
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
      authority: {
        ns_names: [],
        ds: [],
        challenge_txt_value: null,
      },
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
      authority: {
        ns_names: [],
        ds: [],
        challenge_txt_value: null,
      },
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
