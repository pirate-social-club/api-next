/**
 * Drive controlled Handshake chain progression against a regtest node (T03).
 *
 * Funds a wallet, acquires a name through its auction, publishes a replacement
 * resource, and reports the current and safe views as the chain advances. It
 * mutates only the disposable regtest chain in the container named below and
 * makes no request to any production system.
 */

import assert from "node:assert/strict";
import { makeHsdRootResourceObserver } from "../apps/hns-authority-provisioner/src/hsd.ts";

if (Bun.argv.slice(2).join(" ") !== "--execute") {
  throw new Error("Pass --execute to mutate the disposable regtest chain");
}

const NODE = process.env.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
const WALLET = process.env.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
const KEY = process.env.HSD_REGTEST_API_KEY ?? "controlled-progression";
const NAME = process.env.HSD_REGTEST_NAME ?? "t03harness";
const GENESIS = "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5";

for (const endpoint of [NODE, WALLET]) {
  assert.equal(new URL(endpoint).hostname, "127.0.0.1", "regtest must use loopback");
}

const authorization = `Basic ${Buffer.from(`x:${KEY}`).toString("base64")}`;

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { readonly result?: unknown; readonly error?: unknown };
  if (body.error !== null && body.error !== undefined) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

const node = (method: string, params: readonly unknown[] = []) => rpc(NODE, method, params);
const wallet = (method: string, params: readonly unknown[] = []) => rpc(WALLET, method, params);

const height = async (): Promise<number> =>
  ((await node("getblockchaininfo")) as { readonly blocks: number }).blocks;

async function mine(count: number, address: string): Promise<void> {
  await node("generatetoaddress", [count, address]);
}

async function views(): Promise<{ readonly current: boolean; readonly safe: boolean }> {
  return {
    current: (await node("getnameresource", [NAME, false])) !== null,
    safe: (await node("getnameresource", [NAME, true])) !== null,
  };
}

assert.equal(await node("getblockhash", [0]), GENESIS, "refuse a non-regtest chain");
const observe = makeHsdRootResourceObserver({
  rpc_url: NODE,
  authorization,
  chain_network: "regtest",
  genesis_block_hash: GENESIS,
  tree_interval_blocks: 5,
  safe_minimum_confirmations: 12,
  maximum_tip_age_seconds: 86_400,
  maximum_future_tip_seconds: 3_600,
});

const address = (await wallet("getnewaddress", [])) as string;
console.log(`funding ${address}`);
await mine(120, address);
console.log(`height ${await height()}`);

await wallet("sendopen", [NAME]);
await mine(8, address);
await wallet("sendbid", [NAME, 5, 10]);
await mine(6, address);
await wallet("sendreveal", [NAME]);
await mine(12, address);
console.log(`auction closed at height ${await height()}`);

const update = (await wallet("sendupdate", [
  NAME,
  {
    records: [
      { type: "NS", ns: "ns1.pirate." },
      { type: "NS", ns: "ns2.pirate." },
      { type: "TXT", txt: [`pirate-verification=${NAME}`] },
      {
        type: "DS",
        keyTag: 19_787,
        algorithm: 13,
        digestType: 2,
        digest: "f07f6e6058d9023d0c2025edb531558423ff71064c159b987d0c5dbca12f9071",
      },
    ],
  },
])) as { readonly hash: string; readonly hex: string };
await mine(1, address);
const inclusion = await height();
console.log(`inclusion height ${inclusion}: ${JSON.stringify(await views())}`);
const inclusionHash = await node("getblockhash", [inclusion]);
const initial = await observe(NAME, "current");
assert.equal(initial.kind, "observed");
if (initial.kind !== "observed") throw new Error("current observation unavailable");
const expectedDigest = initial.observation.resource_sha256;
assert.equal((await views()).safe, false);

for (let advanced = 5; advanced <= 30; advanced += 5) {
  await mine(5, address);
  const observed = await views();
  console.log(`+${advanced} (height ${await height()}): ${JSON.stringify(observed)}`);
  if (observed.safe) break;
}
const converged = await observe(NAME, "safe");
assert.equal(converged.kind, "observed");
if (converged.kind !== "observed") throw new Error("safe observation unavailable");
assert.equal(converged.observation.resource_sha256, expectedDigest);

// Orphan the UPDATE and its descendants, then rebroadcast the same approved
// transaction. Creating a new UPDATE would try to spend the wallet's pending
// credit twice; a reorg does not require a second owner authorization.
await node("invalidateblock", [inclusionHash]);
assert.equal(await height(), inclusion - 1);
const orphaned = await observe(NAME, "current");
assert.ok(
  orphaned.kind === "finding" ||
    (orphaned.kind === "observed" && orphaned.observation.resource_sha256 !== expectedDigest),
);
const resent = await node("sendrawtransaction", [update.hex]);
assert.equal(resent, update.hash, "rebroadcast must retain the approved transaction identity");
await mine(1, address);
const republished = await observe(NAME, "current");
assert.equal(republished.kind, "observed");
if (republished.kind !== "observed") throw new Error("republished observation unavailable");
assert.equal(republished.observation.resource_sha256, expectedDigest);
assert.equal((await views()).safe, false);
await mine(15, address);
const restored = await observe(NAME, "safe");
assert.equal(restored.kind, "observed");
if (restored.kind !== "observed") throw new Error("restored safe observation unavailable");
assert.equal(restored.observation.resource_sha256, expectedDigest);
console.log(
  JSON.stringify({
    name: NAME,
    inclusion,
    update: update.hash,
    reorg_republished: true,
    current_safe_converged: true,
    resource_sha256: expectedDigest,
  }),
);
