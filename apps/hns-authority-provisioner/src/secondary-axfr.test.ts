import { describe, expect, test } from "bun:test";
import {
  makePowerDnsSecondaryAxfrAuthorizer,
  type PowerDnsSecondaryAxfrConfig,
} from "./secondary-axfr.ts";

const root = "e2ef867cbfad33d41a7837ff6ad";
const challenge = "pirate-verification=owned";
const zoneName = `${root}.`;
const metadataPath = `/zones/${zoneName}/metadata/TSIG-ALLOW-AXFR`;
const config: PowerDnsSecondaryAxfrConfig = {
  api_url: "http://secondary.test:8081",
  api_key: "fixture-api-key",
  server_id: "localhost",
  expected_master_address: "127.0.0.21",
  expected_account: "isolated-staging-fixture",
  axfr_tsig_key_name: "fixture-transfer.",
};

function transferredZone() {
  return {
    name: zoneName,
    kind: "Slave",
    masters: [config.expected_master_address],
    account: config.expected_account,
    dnssec: true,
    serial: 2026092650,
    rrsets: [
      {
        name: `_pirate.${zoneName}`,
        type: "TXT",
        records: [{ content: JSON.stringify(challenge), disabled: false }],
      },
      {
        name: `_pirate.${zoneName}`,
        type: "RRSIG",
        records: [{ content: "signed-challenge", disabled: false }],
      },
      { name: zoneName, type: "DNSKEY", records: [{ content: "key", disabled: false }] },
      { name: zoneName, type: "RRSIG", records: [{ content: "signed-apex", disabled: false }] },
    ],
  };
}

describe("PowerDNS secondary AXFR authorization", () => {
  test("waits for the exact transferred zone, preserves existing keys, and reads back the new permission", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    let zoneGets = 0;
    let keys = ["existing-key."];
    const authorize = makePowerDnsSecondaryAxfrAuthorizer(
      config,
      async (url, init) => {
        const method = init?.method ?? "GET";
        const path = new URL(String(url)).pathname;
        calls.push(`${method} ${path}`);
        if (path.endsWith(metadataPath)) {
          if (method === "PUT") {
            keys = (JSON.parse(String(init?.body)) as { metadata: string[] }).metadata;
            return Response.json({ kind: "TSIG-ALLOW-AXFR", metadata: keys });
          }
          return Response.json({ kind: "TSIG-ALLOW-AXFR", metadata: keys });
        }
        zoneGets += 1;
        return zoneGets === 1
          ? new Response(null, { status: 404 })
          : Response.json(transferredZone());
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    await authorize({ root_label: root, challenge_txt_value: challenge });
    expect(waits).toEqual([250]);
    expect(keys).toEqual(["existing-key.", "fixture-transfer."]);
    expect(calls).toEqual([
      `GET /api/v1/servers/localhost/zones/${zoneName}`,
      `GET /api/v1/servers/localhost/zones/${zoneName}`,
      `GET /api/v1/servers/localhost${metadataPath}`,
      `GET /api/v1/servers/localhost/zones/${zoneName}`,
      `PUT /api/v1/servers/localhost${metadataPath}`,
      `GET /api/v1/servers/localhost${metadataPath}`,
    ]);
  });

  test("refuses another zone, master, account, or challenge before any metadata write", async () => {
    for (const drift of [
      { name: "other-root." },
      { kind: "Master" },
      { masters: ["127.0.0.99"] },
      { account: "another-account" },
      {
        rrsets: [
          {
            name: `_pirate.${zoneName}`,
            type: "TXT",
            records: [{ content: '"other"', disabled: false }],
          },
        ],
      },
    ]) {
      const calls: string[] = [];
      const authorize = makePowerDnsSecondaryAxfrAuthorizer(
        config,
        async (_url, init) => {
          calls.push(init?.method ?? "GET");
          return Response.json({ ...transferredZone(), ...drift });
        },
        async () => undefined,
      );
      await expect(
        authorize({ root_label: root, challenge_txt_value: challenge }),
      ).rejects.toThrow();
      expect(calls).toEqual(["GET"]);
    }
  });

  test("does not write when transfer or DNSSEC evidence is absent", async () => {
    for (const zone of [
      null,
      { ...transferredZone(), dnssec: false },
      { ...transferredZone(), rrsets: [] },
    ]) {
      const methods: string[] = [];
      const authorize = makePowerDnsSecondaryAxfrAuthorizer(
        config,
        async (_url, init) => {
          methods.push(init?.method ?? "GET");
          return zone === null ? new Response(null, { status: 404 }) : Response.json(zone);
        },
        async () => undefined,
      );
      await expect(authorize({ root_label: root, challenge_txt_value: challenge })).rejects.toThrow(
        "transfer is incomplete",
      );
      expect(methods).toEqual(["GET", "GET", "GET"]);
    }
  });

  test("refuses metadata read, write, and readback failures", async () => {
    for (const failure of ["read", "write", "readback"] as const) {
      let metadataGets = 0;
      let writes = 0;
      const authorize = makePowerDnsSecondaryAxfrAuthorizer(
        config,
        async (url, init) => {
          const method = init?.method ?? "GET";
          const path = new URL(String(url)).pathname;
          if (!path.endsWith(metadataPath)) return Response.json(transferredZone());
          if (method === "PUT") {
            writes += 1;
            return failure === "write"
              ? new Response(null, { status: 503 })
              : new Response(null, { status: 204 });
          }
          metadataGets += 1;
          if (failure === "read" && metadataGets === 1) return new Response(null, { status: 503 });
          return Response.json({
            kind: "TSIG-ALLOW-AXFR",
            metadata: [],
          });
        },
        async () => undefined,
      );
      await expect(
        authorize({ root_label: root, challenge_txt_value: challenge }),
      ).rejects.toThrow();
      expect(writes).toBe(failure === "read" ? 0 : 1);
    }
  });

  test("an already retained permission is read without another PUT", async () => {
    const methods: string[] = [];
    const authorize = makePowerDnsSecondaryAxfrAuthorizer(
      { ...config, axfr_tsig_key_name: "fixture-transfer" },
      async (url, init) => {
        methods.push(init?.method ?? "GET");
        return new URL(String(url)).pathname.endsWith(metadataPath)
          ? Response.json({ kind: "TSIG-ALLOW-AXFR", metadata: ["fixture-transfer."] })
          : Response.json(transferredZone());
      },
      async () => undefined,
    );
    await authorize({ root_label: root, challenge_txt_value: challenge });
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("writes the canonical dotted key when configured without a trailing dot", async () => {
    let retained: string[] = [];
    const authorize = makePowerDnsSecondaryAxfrAuthorizer(
      { ...config, axfr_tsig_key_name: "fixture-transfer" },
      async (url, init) => {
        if (!new URL(String(url)).pathname.endsWith(metadataPath))
          return Response.json(transferredZone());
        if (init?.method === "PUT") {
          retained = (JSON.parse(String(init.body)) as { metadata: string[] }).metadata;
          return new Response(null, { status: 204 });
        }
        return Response.json({ kind: "TSIG-ALLOW-AXFR", metadata: retained });
      },
      async () => undefined,
    );
    await authorize({ root_label: root, challenge_txt_value: challenge });
    expect(retained).toEqual(["fixture-transfer."]);
  });

  test("an ambiguous committed metadata write is reconciled on the next fenced retry", async () => {
    const methods: string[] = [];
    let retained: string[] = [];
    const authorize = makePowerDnsSecondaryAxfrAuthorizer(
      config,
      async (url, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (!new URL(String(url)).pathname.endsWith(metadataPath))
          return Response.json(transferredZone());
        if (method === "PUT") {
          retained = [config.axfr_tsig_key_name];
          throw new Error("metadata response lost after commit");
        }
        return Response.json({ kind: "TSIG-ALLOW-AXFR", metadata: retained });
      },
      async () => undefined,
    );
    await expect(authorize({ root_label: root, challenge_txt_value: challenge })).rejects.toThrow(
      "response lost",
    );
    await authorize({ root_label: root, challenge_txt_value: challenge });
    expect(methods.filter((method) => method === "PUT")).toHaveLength(1);
  });
});
