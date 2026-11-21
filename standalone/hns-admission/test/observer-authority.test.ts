import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { agree } from "../src/observation.ts";
import { observerLayer } from "../src/hsd-observer.ts";
import { HnsObserver } from "../src/service.ts";
import { observation, state, binding, hash, address } from "./fixtures.ts";

const expected = {
  chainId: 6343,
  registry: address,
  controller: address,
  communityId: hash,
  network: "regtest",
  genesis: hash,
  challenge: observation().challenge,
  resourceDigest: hash,
  ownershipEpoch: hash,
};

test("provisional FINALIZE is unavailable, rollback recovers, and only stable ownership change denies", () => {
  const original = observation();
  const provisional = { ...original, ownershipEpoch: "0x" + "33".repeat(32) };
  assert.deepEqual(agree(provisional, provisional, 1000, expected), {
    status: "unavailable",
    reason: "observer_stale",
  });
  assert.equal(agree(original, original, 1000, expected).status, "verified");
  const stable = {
    ...provisional,
    safeOwnershipEpoch: provisional.ownershipEpoch,
  };
  assert.deepEqual(agree(stable, stable, 1000, expected), {
    status: "denied",
    reason: "ownership_changed",
  });
});

function absentObserver(ageSeconds: number, oneDown = false) {
  const now = Math.floor(Date.now() / 1000),
    tip = "22".repeat(32),
    genesis = "11".repeat(32);
  const transport: typeof fetch = async (_url, init) => {
    if (oneDown && String(_url).includes("b.fixture"))
      throw Error("fixture_observer_down");
    const query = JSON.parse(init!.body as string);
    let result: unknown;
    if (query.method === "getblockchaininfo")
      result = {
        chain: "regtest",
        blocks: 10,
        headers: 10,
        bestblockhash: tip,
      };
    else if (query.method === "getblockhash")
      result = query.params[0] === 0 ? genesis : tip;
    else if (query.method === "getblockheader")
      result = {
        hash: query.params[0],
        height: query.params[0] === genesis ? 0 : 10,
        time: now - ageSeconds,
        treeroot: genesis,
      };
    else if (query.method === "getnameinfo") result = { info: null };
    else throw new Error("unexpected_rpc_method");
    return Response.json({ id: query.id, error: null, result });
  };
  return observerLayer(
    {
      network: "regtest",
      genesis: "0x" + genesis,
      treeInterval: 5,
      nodes: [
        { url: "https://a.fixture.test", authorization: "fixture-only" },
        { url: "https://b.fixture.test", authorization: "fixture-only" },
      ],
    },
    transport,
  );
}

test("one unreachable observer remains unavailable under the current explicit two-observer policy", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const observer = yield* HnsObserver;
      assert.equal(
        (yield* observer.baseline(binding).pipe(Effect.flip)).reason,
        "observer_timeout",
      );
      assert.equal(
        (yield* observer.observe(state()).pipe(Effect.flip)).reason,
        "observer_timeout",
      );
    }).pipe(Effect.provide(absentObserver(0, true))),
  );
});

test("matching tips within HSD's two-hour future allowance do not make existing mature proof unavailable", () => {
  const future = { ...observation(), tipTime: 8200 };
  assert.equal(agree(future, future, 1000, expected).status, "verified");
  assert.equal(
    agree(
      { ...future, tipTime: 8201 },
      { ...future, tipTime: 8201 },
      1000,
      expected,
    ).status,
    "unavailable",
  );
});

test("stale agreeing absence cannot revoke or refuse current control", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const observer = yield* HnsObserver;
      const seen = yield* observer.observe(state()).pipe(Effect.flip);
      assert.equal(seen.reason, "chain_freshness_unconfirmed");
      const baseline = yield* observer.baseline(binding).pipe(Effect.flip);
      assert.equal(baseline.reason, "chain_freshness_unconfirmed");
    }).pipe(Effect.provide(absentObserver(21601))),
  );
});

test("fresh stable absence still refuses a name that is no longer owned", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const observer = yield* HnsObserver;
      assert.deepEqual(yield* observer.observe(state()), {
        status: "denied",
        reason: "ownership_changed",
      });
      const baseline = yield* observer.baseline(binding).pipe(Effect.flip);
      assert.equal(baseline.reason, "namespace_not_owned");
    }).pipe(Effect.provide(absentObserver(0))),
  );
});

test("both decision timestamps must agree before normalized evidence is selected", () => {
  const a = observation();
  for (const field of ["tipTime", "inclusionTime"] as const) {
    const b = { ...a, [field]: a[field] + 1 };
    assert.deepEqual(
      agree(a, b, 1000, expected),
      { status: "unavailable", reason: "observer_disagreement" },
      field,
    );
  }
});

test("production reader refuses conflicting reported timestamps for the same block hash", async () => {
  const now = Math.floor(Date.now() / 1000),
    genesis = "11".repeat(32),
    tip = "22".repeat(32),
    past = "33".repeat(32),
    nameHash = "44".repeat(32),
    txid = "aa".repeat(32);
  for (const field of ["tipTime", "inclusionTime"] as const) {
    const transport: typeof fetch = async (url, init) => {
      const q = JSON.parse(init!.body as string),
        contradictory = String(url).includes("b.fixture");
      let result: unknown;
      if (q.method === "getblockchaininfo")
        result = {
          chain: "regtest",
          blocks: 10,
          headers: 10,
          bestblockhash: tip,
        };
      else if (q.method === "getblockhash")
        result = q.params[0] === 0 ? genesis : q.params[0] === 8 ? past : tip;
      else if (q.method === "getblockheader") {
        const historical = q.params[0] === past;
        const offset =
          contradictory &&
          ((historical && field === "inclusionTime") ||
            (!historical && field === "tipTime"))
            ? 1
            : 0;
        result = {
          hash: q.params[0],
          height: historical ? 8 : 10,
          time: now - (historical ? 60 : 0) + offset,
          treeroot: genesis,
        };
      } else if (q.method === "getnameinfo")
        result = {
          info: {
            name: binding.tld,
            nameHash,
            state: "CLOSED",
            registered: true,
            owner: { hash: txid, index: 0 },
            data: "00",
            transfer: 0,
            stats: { blocksUntilExpire: 1000 },
          },
        };
      else if (q.method === "getrawtransaction")
        result = {
          txid,
          blockhash: past,
          vin: [],
          vout: [
            {
              n: 0,
              covenant: {
                action: "REGISTER",
                items: [nameHash, "00000000", "00"],
              },
            },
          ],
        };
      else throw new Error("unexpected_rpc_method");
      return Response.json({ id: q.id, error: null, result });
    };
    const layer = observerLayer(
      {
        network: "regtest",
        genesis: "0x" + genesis,
        treeInterval: 5,
        nodes: [
          { url: "https://a.fixture.test", authorization: "fixture-only" },
          { url: "https://b.fixture.test", authorization: "fixture-only" },
        ],
      },
      transport,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HnsObserver;
        const denied = yield* observer.baseline(binding).pipe(Effect.flip);
        assert.equal(denied.reason, "observer_disagreement", field);
        const existing = yield* observer.observe(state()).pipe(Effect.flip);
        assert.equal(existing.reason, "observer_disagreement", field);
      }).pipe(Effect.provide(layer)),
    );
  }
});
