import { describe, expect, test } from "bun:test";
import {
  assertHnsMemberRecords,
  buildHnsMemberRecordPatch,
  type HnsMemberRecordTarget,
  makePowerDnsMemberWriter,
} from "./member-records.ts";
import { buildManagedRootRrsets, reservationAccount } from "./powerdns.ts";

const target: HnsMemberRecordTarget = {
  root_label: "example",
  handle_label: "member",
  grant_id: "grant-member",
  gateway_ipv4: "192.0.2.10",
  shared_tlsa_association: `3 1 1 ${"a".repeat(64)}`,
  ttl_seconds: 300,
  publish: true,
};
const challenge = "pirate-verification=test";
const roots = buildManagedRootRrsets({ ...target, challenge_txt_value: challenge });

describe("explicit HNS member records", () => {
  test("adds exact A and TLSA owners without changing root, app or wildcard", () => {
    const patch = buildHnsMemberRecordPatch(target, roots);
    expect(patch.map((item) => `${item.name} ${item.type}`)).toEqual([
      "member.example. A",
      "_443._tcp.member.example. TLSA",
      "_pirate-member.member.example. TXT",
    ]);
    expect(patch[0]?.records[0]?.content).toBe(target.gateway_ipv4);
    expect(patch[1]?.records[0]?.content).toBe(target.shared_tlsa_association);
    assertHnsMemberRecords(target, [...roots, ...patch]);
  });

  test("recovers a provider success whose database acknowledgement was lost", () => {
    const first = buildHnsMemberRecordPatch(target, roots);
    expect(buildHnsMemberRecordPatch(target, [...roots, ...first])).toEqual(first);
  });

  test("rotates both address and certificate from its own retained records", () => {
    const before = buildHnsMemberRecordPatch(target, roots);
    const next = {
      ...target,
      gateway_ipv4: "192.0.2.20",
      shared_tlsa_association: `3 1 1 ${"b".repeat(64)}`,
    };
    const after = buildHnsMemberRecordPatch(next, [...roots, ...before]);
    assertHnsMemberRecords(next, [...roots, ...after]);
    expect(() => assertHnsMemberRecords(target, after)).toThrow("readback differs");
  });

  test("withdraws only the three publisher-owned rrsets and tolerates replay", () => {
    const initial = buildHnsMemberRecordPatch(target, roots);
    const withdraw = { ...target, publish: false };
    const patch = buildHnsMemberRecordPatch(withdraw, [...roots, ...initial]);
    expect(patch.every((item) => item.changetype === "DELETE" && item.records.length === 0)).toBe(
      true,
    );
    expect(patch.map((item) => item.name)).toEqual(initial.map((item) => item.name));
    expect(buildHnsMemberRecordPatch(withdraw, roots)).toEqual([]);
    assertHnsMemberRecords(withdraw, roots);
  });

  test("refuses an unowned record or a marker belonging to another grant", () => {
    const initial = buildHnsMemberRecordPatch(target, roots);
    expect(() => buildHnsMemberRecordPatch(target, initial.slice(0, 2))).toThrow(
      "ownership conflict",
    );
    expect(() =>
      buildHnsMemberRecordPatch({ ...target, grant_id: "grant-other" }, initial),
    ).toThrow("ownership conflict");
  });

  test("does not delete or overwrite an operator's changed record", () => {
    const initial = buildHnsMemberRecordPatch(target, roots);
    const changed = initial.map((item) =>
      item.type === "A"
        ? {
            ...item,
            records: [{ content: "192.0.2.99", disabled: false }],
          }
        : item,
    );
    expect(() => buildHnsMemberRecordPatch(target, changed)).toThrow("ownership conflict");
    expect(() => buildHnsMemberRecordPatch({ ...target, publish: false }, changed)).toThrow(
      "ownership conflict",
    );
  });

  test("refuses app, wildcard, dotted labels and malformed TLSA inputs", () => {
    for (const handle_label of ["app", "*", "other.member", "_tcp"]) {
      expect(() => buildHnsMemberRecordPatch({ ...target, handle_label }, roots)).toThrow(
        "target is invalid",
      );
    }
    expect(() =>
      buildHnsMemberRecordPatch({ ...target, shared_tlsa_association: "bad" }, roots),
    ).toThrow("target is invalid");
  });

  test("writes, rectifies, notifies and reads back; retry repairs a lost response", async () => {
    let rrsets: readonly unknown[] = roots;
    let serial = 1;
    let loseResponse = true;
    const account = await reservationAccount(challenge);
    const methods: string[] = [];
    const writer = makePowerDnsMemberWriter(
      { api_url: "http://provider.test", api_key: "test", server_id: "localhost" },
      async (_url, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body)) as { rrsets: readonly unknown[] };
          rrsets = [...roots, ...patch.rrsets];
          serial++;
          if (loseResponse) {
            loseResponse = false;
            throw new Error("lost response");
          }
        }
        return init?.method === "GET"
          ? Response.json({ name: "example.", account, dnssec: true, serial, rrsets })
          : new Response(null, { status: 204 });
      },
    );
    const input = { ...target, challenge_txt_value: challenge };
    await expect(writer(input)).rejects.toThrow("lost response");
    expect(await writer(input)).toBe(3);
    expect(methods).toEqual(["GET", "PATCH", "GET", "PATCH", "PUT", "PUT", "GET"]);
    assertHnsMemberRecords(target, rrsets);
  });

  test("refuses a zone from another reservation before mutation", async () => {
    const methods: string[] = [];
    const writer = makePowerDnsMemberWriter(
      { api_url: "http://provider.test", api_key: "test", server_id: "localhost" },
      async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          name: "example.",
          account: "other",
          dnssec: true,
          serial: 1,
          rrsets: roots,
        });
      },
    );
    await expect(writer({ ...target, challenge_txt_value: challenge })).rejects.toThrow(
      "reservation differs",
    );
    expect(methods).toEqual(["GET"]);
  });
});
