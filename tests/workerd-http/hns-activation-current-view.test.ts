import { expect, test } from "vitest";
import {
  decodeHnsResourceV1,
  preflightEncodeHnsResourceV1,
} from "../../packages/application/src/namespace-ownership/hns-resource-codec.ts";
import type { HnsRootResourceRecordV1 } from "../../packages/application/src/namespace-ownership/hns-root-import-plan.ts";
import { makeHsdRootResourceObserver } from "../../packages/platform-cf/src/namespace-ownership/hns-root-resource-observer.ts";

/**
 * Runtime proof that the shared bracketed observer and the real wire codec
 * execute inside the Worker runtime. Request-scoped I/O runs through the
 * observer's injected fetcher and the codec's crypto; nothing here touches a
 * local port.
 */

const config = {
  rpc_url: "https://hsd.workerd.test/rpc",
  authorization: "Basic opaque",
  chain_network: "regtest",
  genesis_block_hash: `${"0".repeat(63)}1`,
  tree_interval_blocks: 36,
  safe_minimum_confirmations: 12,
  maximum_tip_age_seconds: 600,
  maximum_future_tip_seconds: 60,
} as const;

const tipHash = "aa".repeat(32);

function rpcResponse(result: unknown): Response {
  return Response.json({ result, error: null, id: null });
}

test("the shared observer and wire codec run inside the Worker runtime", async () => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const records: readonly HnsRootResourceRecordV1[] = [
    { type: "NS", ns: "ns1.pirate." },
    { type: "DS", keyTag: 1, algorithm: 13, digestType: 2, digest: "a".repeat(64) },
    { type: "TXT", txt: ["pirate-verification=challenge"] },
  ];
  const chainInfo = {
    chain: "regtest",
    blocks: 812_345,
    headers: 812_345,
    mediantime: nowSeconds,
    bestblockhash: tipHash,
  };
  const tipHeader = {
    hash: tipHash,
    height: 812_345,
    mediantime: nowSeconds,
    time: nowSeconds,
    confirmations: 1,
  };
  const responses = [
    rpcResponse(chainInfo),
    rpcResponse(tipHeader),
    rpcResponse({ info: { state: "CLOSED", registered: true, expired: false, height: 800_000 } }),
    rpcResponse({ records }),
    rpcResponse(chainInfo),
    rpcResponse(tipHeader),
  ];
  const calls: unknown[] = [];
  const observe = makeHsdRootResourceObserver(
    config,
    async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    },
    () => Date.now(),
  );
  const result = await observe("newroot", "current");
  expect(result.kind).toBe("observed");
  if (result.kind !== "observed") throw new Error("unreachable");
  expect(result.observation.records).toEqual(records);
  const encoded = await preflightEncodeHnsResourceV1(records);
  expect(encoded.sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(decodeHnsResourceV1(encoded.bytes)).toEqual(records);
  // The observation's canonical-JSON digest hashes a different byte sequence
  // from the wire encoding; only the codec's output may qualify a plan.
  expect(result.observation.resource_sha256).not.toBe(encoded.sha256);
  expect(calls).toEqual([
    { method: "getblockchaininfo", params: [] },
    { method: "getblockheader", params: [tipHash, true] },
    { method: "getnameinfo", params: ["newroot", false] },
    { method: "getnameresource", params: ["newroot", false] },
    { method: "getblockchaininfo", params: [] },
    { method: "getblockheader", params: [tipHash, true] },
  ]);
});
