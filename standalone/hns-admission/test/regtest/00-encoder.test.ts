import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../../src/records.ts";
import { NodeFixture, docker, IMAGE } from "./fixture.ts";

test(
  "first gate: real HSD accepts exactly 159 added resource bytes and preserves NS/DS",
  { timeout: 120000 },
  async () => {
    const node = new NodeFixture();
    node.start();
    try {
      await node.ready();
      const genesis = node.rpc("getblockhash", [0]);
      assert.equal(
        genesis,
        "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5",
      );
      const records = [
        { type: "NS", ns: "ns1.example." },
        {
          type: "DS",
          keyTag: 1234,
          algorithm: 13,
          digestType: 2,
          digest: "ab".repeat(32),
        },
      ];
      const plan = await preflight(
        records,
        {
          chainId: 6343,
          registry: "0x" + "11".repeat(20),
          controller: "0x" + "22".repeat(20),
          communityId: "0x" + "33".repeat(32),
        },
        "0x" + "44".repeat(32),
      );
      assert.equal(plan.afterBytes - plan.beforeBytes, 159);
      assert.equal(
        node.encode(plan.records),
        Buffer.from(plan.bytes).toString("hex"),
      );
      const mine = await node.acquire("admissiontest");
      const tx = node.rpc(
        "sendupdate",
        ["admissiontest", { records: plan.records }],
        true,
      ) as { hash: string };
      mine(1);
      const accepted = node.rpc("getrawtransaction", [tx.hash, true]) as {
        vout: { covenant: { items: string[] } }[];
      };
      const resource = accepted.vout
        .flatMap((o) => o.covenant.items)
        .find((hex) => hex === Buffer.from(plan.bytes).toString("hex"));
      assert.ok(
        resource,
        "accepted transaction must contain the exact encoded resource",
      );
      assert.equal(resource.length / 2, plan.afterBytes);
      const observed = node.rpc("getnameresource", ["admissiontest"]) as {
        records: unknown[];
      };
      assert.deepEqual(observed.records.slice(0, 2), records);
      const limit = [
        ...records,
        { type: "TXT", txt: ["a".repeat(255), "b".repeat(200)] },
      ];
      assert.equal(node.encode(limit).length / 2, 512);
      node.rpc("sendupdate", ["admissiontest", { records: limit }], true);
      mine(1);
      const mempool = node.rpc("getrawmempool");
      assert.throws(() =>
        node.rpc(
          "sendupdate",
          [
            "admissiontest",
            {
              records: [
                ...records,
                { type: "TXT", txt: ["a".repeat(255), "b".repeat(201)] },
              ],
            },
          ],
          true,
        ),
      );
      assert.deepEqual(
        node.rpc("getrawmempool"),
        mempool,
        "over-limit resource must not broadcast",
      );
      console.log(
        JSON.stringify({
          image: IMAGE,
          genesis,
          before: plan.beforeBytes,
          after: plan.afterBytes,
          delta: 159,
          tx: tx.hash,
          hsdVersion: docker(
            "exec",
            node.name,
            "node",
            "-p",
            "require('/usr/local/lib/node_modules/hsd/package.json').version",
          ),
        }),
      );
    } finally {
      node.close();
    }
  },
);
