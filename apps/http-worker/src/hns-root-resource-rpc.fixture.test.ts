import { expect, test } from "bun:test";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { startHnsRootResourceRpcFixture } from "./hns-root-resource-rpc.fixture.ts";

function observer(rpcUrl: string) {
  return makeHsdRootResourceObserver({
    rpc_url: rpcUrl,
    authorization: "Basic fixture",
    chain_network: "regtest",
    genesis_block_hash: `${"0".repeat(63)}1`,
    tree_interval_blocks: 36,
    safe_minimum_confirmations: 12,
    maximum_tip_age_seconds: 86_400,
    maximum_future_tip_seconds: 3_600,
  });
}

for (const view of ["current", "safe"] as const) {
  test(`RPC fixture preserves ${view} block identity across a second boundary`, async () => {
    let requests = 0;
    let crossedSecond = false;
    const fixture = startHnsRootResourceRpcFixture({
      onRequest: async () => {
        requests++;
        if (requests === 2) {
          const before = Math.floor(Date.now() / 1_000);
          await Bun.sleep(1_100);
          crossedSecond = Math.floor(Date.now() / 1_000) > before;
        }
      },
    });
    try {
      const records = [{ type: "TXT" as const, txt: ["fixture-only"] }];
      fixture.setRecords(records);
      fixture.setSafeRecords(records);
      const result = await observer(fixture.url)("harbor", view);
      expect(crossedSecond).toBe(true);
      expect(result).toMatchObject({ kind: "observed", observation: { view, records } });
      expect(fixture.calls.filter((method) => method === "getblockchaininfo")).toHaveLength(2);
    } finally {
      fixture.stop();
    }
  });
}

test("stable fixture timestamps do not hide a malformed resource response", async () => {
  const fixture = startHnsRootResourceRpcFixture();
  try {
    fixture.setFailure("malformed");
    expect(await observer(fixture.url)("harbor", "current")).toEqual({
      kind: "unavailable",
      classification: "malformed_response",
    });
  } finally {
    fixture.stop();
  }
});
