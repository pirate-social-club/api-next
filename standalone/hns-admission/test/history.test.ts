import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSnapshotReader } from "../src/hsd-snapshot.ts";
import { HsdUnavailable, type HsdRpc } from "../src/hsd-rpc.ts";
import { preflightEncodeHnsResourceV1 } from "../src/resource-codec.ts";

async function historyFixture(
  depth: number,
  emptyUpdate = false,
  maxHistory?: number,
) {
  const hash = (value: number) => value.toString(16).padStart(64, "0");
  const resource = async (text: string) =>
    Buffer.from(
      (await preflightEncodeHnsResourceV1([{ type: "TXT", txt: [text] }]))
        .bytes,
    ).toString("hex");
  const original = await resource("original"),
    published = await resource("published");
  const nameHash = hash(999),
    block = (height: number) => hash(10000 + height);
  let calls = 0;
  const rpc: HsdRpc = {
    call: async (method, params = []) => {
      calls++;
      if (method === "getblockchaininfo")
        return {
          chain: "regtest",
          blocks: 1000,
          headers: 1000,
          bestblockhash: block(1000),
        };
      if (method === "getblockhash")
        return params[0] === 0 ? hash(1) : block(Number(params[0]));
      if (method === "getblockheader") {
        const height = parseInt(String(params[0]), 16) - 10000;
        return { hash: params[0], height, time: height, treeroot: hash(2) };
      }
      if (method === "getnameinfo")
        return {
          info: {
            name: "historytest",
            nameHash,
            state: "CLOSED",
            registered: true,
            owner: { hash: hash(100 + depth - 1), index: 0 },
            data: published,
            transfer: 0,
            stats: { blocksUntilExpire: 1000 },
          },
        };
      if (method === "getrawtransaction") {
        const index = parseInt(String(params[0]), 16) - 100;
        return {
          txid: params[0],
          blockhash: block(index + 1),
          vin: index === 0 ? [] : [{ txid: hash(100 + index - 1), vout: 0 }],
          vout: [
            {
              n: 0,
              covenant: {
                action:
                  index === 0
                    ? "REGISTER"
                    : index === 1 || (emptyUpdate && index === depth - 1)
                      ? "UPDATE"
                      : "RENEW",
                items: [
                  nameHash,
                  "00000000",
                  index === 0 ? original : index === 1 ? published : "",
                ],
              },
            },
          ],
        };
      }
      throw Error("unexpected_rpc");
    },
  };
  const read = makeSnapshotReader(
    rpc,
    {
      network: "regtest",
      genesis: hash(1),
      treeInterval: 5,
      ...(maxHistory === undefined ? {} : { maxHistory }),
    },
    () => 1000,
  );
  return { read: () => read("historytest"), calls: () => calls };
}

test("empty UPDATE preserves publication inclusion across transfer cancellation", async () => {
  const fixture = await historyFixture(3, true);
  const snapshot = await fixture.read();
  assert.equal(
    snapshot.inclusionHeight,
    2,
    "an empty UPDATE must not fall back to REGISTER",
  );
  assert.equal(snapshot.inclusionTime, 2);
  assert.equal(snapshot.safeResourceDigest, snapshot.resourceDigest);
});

test("a full 64-step snapshot reuses canonical history reads across current and safe views", async () => {
  const fixture = await historyFixture(64);
  await fixture.read();
  assert.ok(
    fixture.calls() <= 200,
    `snapshot used ${fixture.calls()} RPC calls`,
  );
});

test("history depth exhaustion is unavailable and an explicit bounded larger walk supports busy names", async () => {
  const bounded = await historyFixture(65);
  await assert.rejects(
    () => bounded.read(),
    (error: unknown) =>
      error instanceof HsdUnavailable &&
      error.reason === "ownership_history_unavailable",
  );
  const larger = await historyFixture(65, false, 256);
  assert.equal((await larger.read()).active, true);
});
