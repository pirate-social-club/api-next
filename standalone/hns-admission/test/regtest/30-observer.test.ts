import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeFixture } from "./fixture.ts";
import { makeSnapshotReader } from "../../src/hsd-snapshot.ts";
import type { HsdRpc } from "../../src/hsd-rpc.ts";
test(
  "real RPC adapter separates current/safe data and follows ownership epochs",
  { timeout: 120000 },
  async () => {
    const n = new NodeFixture();
    n.start();
    try {
      await n.ready();
      const mine = await n.acquire("observertest");
      n.rpc(
        "sendupdate",
        ["observertest", { records: [{ type: "TXT", txt: ["first"] }] }],
        true,
      );
      mine(10);
      const methods: string[] = [];
      const rpc: HsdRpc = {
        call: async (method, params = []) => {
          methods.push(method);
          return n.rpc(method, [...params]);
        },
      };
      const read = makeSnapshotReader(
        rpc,
        {
          network: "regtest",
          treeInterval: 5,
          genesis: String(n.rpc("getblockhash", [0])),
        },
        () => Math.floor(Date.now() / 1000),
      );
      const first = await read("observertest");
      assert.equal(first.active, true);
      assert.equal(first.safeResourceDigest, first.resourceDigest);
      n.rpc(
        "sendupdate",
        ["observertest", { records: [{ type: "TXT", txt: ["second"] }] }],
        true,
      );
      mine(1);
      const update = await read("observertest");
      assert.equal(update.ownershipEpoch, first.ownershipEpoch);
      assert.notEqual(update.resourceDigest, first.resourceDigest);
      assert.notEqual(
        update.safeResourceDigest,
        update.resourceDigest,
        "tip inclusion alone must not establish safe commitment",
      );
      mine(10);
      const mature = await read("observertest");
      assert.equal(mature.safeResourceDigest, mature.resourceDigest);
      assert.equal(mature.safeOwnershipEpoch, mature.ownershipEpoch);
      const nearRenewal = makeSnapshotReader(
        {
          call: async (method, params = []) => {
            const result = await rpc.call(method, params);
            if (method !== "getnameinfo") return result;
            const value = result as {
              info: Record<string, unknown> & {
                stats: Record<string, unknown>;
              };
            };
            return {
              ...value,
              info: {
                ...value.info,
                renewal: 1,
                expired: true,
                stats: { ...value.info.stats, blocksUntilExpire: 1 },
              },
            };
          },
        },
        {
          network: "regtest",
          treeInterval: 5,
          genesis: String(n.rpc("getblockhash", [0])),
        },
        () => Math.floor(Date.now() / 1000),
      );
      const near = await nearRenewal("observertest");
      assert.equal(
        near.active,
        true,
        "no minimum renewal horizon or historical renewal/expired flag gates valid current control",
      );
      assert.equal(near.ownershipEpoch, mature.ownershipEpoch);
      n.rpc(
        "sendtransfer",
        ["observertest", n.rpc("getnewaddress", [], true)],
        true,
      );
      mine(1);
      const pending = await read("observertest");
      assert.equal(pending.transferPending, true);
      assert.equal(pending.ownershipEpoch, first.ownershipEpoch);
      mine(10);
      n.rpc("sendfinalize", ["observertest"], true);
      mine(1);
      const finalized = await read("observertest");
      assert.equal(finalized.transferPending, false);
      assert.notEqual(finalized.ownershipEpoch, first.ownershipEpoch);
      assert.ok(
        methods.every((m) =>
          [
            "getblockchaininfo",
            "getblockhash",
            "getblockheader",
            "getnameinfo",
            "getrawtransaction",
          ].includes(m),
        ),
      );
    } finally {
      n.close();
    }
  },
);
