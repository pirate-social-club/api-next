import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeFixture } from "./fixture.ts";
import { makeSnapshotReader } from "../../src/hsd-snapshot.ts";
import type { HsdRpc } from "../../src/hsd-rpc.ts";
import { Effect } from "effect";
import { observerLayer } from "../../src/hsd-observer.ts";
import { HnsObserver } from "../../src/service.ts";
import { state, binding } from "../fixtures.ts";
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
      const transport: typeof fetch = async (_url, init) => {
        const query = JSON.parse(init!.body as string);
        return Response.json({
          id: query.id,
          error: null,
          result: n.rpc(query.method, query.params),
        });
      };
      // Two transport identities over this one real-node fixture isolate the
      // current/safe decision. The separate partition case supplies two nodes.
      const adapter = observerLayer(
        {
          network: "regtest",
          treeInterval: 5,
          genesis: String(n.rpc("getblockhash", [0])),
          nodes: [
            { url: "http://a.fixture.test", authorization: "fixture-only" },
            { url: "http://b.fixture.test", authorization: "fixture-only" },
          ],
        },
        transport,
      );
      const decision = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const observer = yield* HnsObserver;
            return yield* observer
              .observe({
                ...state(),
                binding: { ...binding, tld: "observertest" },
                ownershipEpoch: first.ownershipEpoch,
              })
              .pipe(Effect.result);
          }).pipe(Effect.provide(adapter)),
        );
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
      const pendingDecision = await decision();
      assert.ok(pendingDecision._tag === "Success");
      assert.deepEqual(pendingDecision.success, {
        status: "waiting",
        reason: "transfer_pending",
      });
      mine(10);
      const finalizeTx = n.rpc("sendfinalize", ["observertest"], true) as {
        hash: string;
      };
      mine(1);
      const finalized = await read("observertest");
      assert.equal(finalized.transferPending, false);
      assert.notEqual(finalized.ownershipEpoch, first.ownershipEpoch);
      const provisional = await decision();
      assert.ok(provisional._tag === "Failure");
      assert.equal(
        provisional.failure.reason,
        "observer_stale",
        "a provisional FINALIZE cannot permanently reject the ceremony",
      );
      const rawFinalize = n.rpc("getrawtransaction", [finalizeTx.hash, false]);
      n.rpc("invalidateblock", [finalized.tipHash.slice(2)]);
      const rolledBack = await decision();
      assert.ok(rolledBack._tag === "Success");
      assert.deepEqual(
        rolledBack.success,
        { status: "waiting", reason: "transfer_pending" },
        "rollback restores the original authority without a new ceremony",
      );
      if (!(n.rpc("getrawmempool") as string[]).includes(finalizeTx.hash))
        n.rpc("sendrawtransaction", [rawFinalize]);
      mine(10);
      const stable = await decision();
      assert.ok(stable._tag === "Success");
      assert.deepEqual(
        stable.success,
        { status: "denied", reason: "ownership_changed" },
        "stable new ownership still revokes old control",
      );
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
