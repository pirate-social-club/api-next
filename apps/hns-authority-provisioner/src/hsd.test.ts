import { describe, expect, test } from "bun:test";
import { hsdSafeCommitmentHeightV1 } from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "./hsd.ts";

const config = {
  rpc_url: "http://hsd.test:12037",
  authorization: "Basic opaque",
  chain_network: "main",
  genesis_block_hash: `${"0".repeat(63)}1`,
  tree_interval_blocks: 36,
  safe_minimum_confirmations: 12,
  maximum_tip_age_seconds: 7_200,
  maximum_future_tip_seconds: 3_600,
} as const;

const nowMs = Date.parse("2026-09-09T12:00:00Z");
const tipMedianTime = Date.parse("2026-09-09T11:59:30Z") / 1_000;
const tipHash = "aa".repeat(32);
const tipHeaderTime = tipMedianTime + 30;

function rpcResponse(result: unknown): Response {
  return Response.json({ result, error: null, id: null });
}

function chainInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: "main",
    blocks: 812_345,
    headers: 812_345,
    mediantime: tipMedianTime,
    bestblockhash: tipHash,
    ...overrides,
  };
}

function tipHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: tipHash,
    height: 812_345,
    mediantime: tipMedianTime,
    time: tipHeaderTime,
    confirmations: 1,
    ...overrides,
  };
}

function activeNameInfo(height = 800_000): Record<string, unknown> {
  return {
    info: { state: "CLOSED", registered: true, expired: false, height },
  };
}

function resource(records: readonly unknown[]): Record<string, unknown> {
  return { records: [...records] };
}

describe("HSD root resource observer", () => {
  test("reads the current view with safe=false and returns verbatim records inside an equal anchor bracket", async () => {
    const calls: unknown[] = [];
    const responses = [
      rpcResponse(chainInfo()),
      rpcResponse(tipHeader()),
      rpcResponse(activeNameInfo()),
      rpcResponse(
        resource([
          { type: "TXT", txt: ["preserve"] },
          { type: "NS", ns: "old.example." },
        ]),
      ),
      rpcResponse(chainInfo()),
      rpcResponse(tipHeader()),
    ];
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      () => nowMs,
    );
    const result = await observe("newroot", "current");
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") throw new Error("unreachable");
    expect(result.observation.records).toEqual([
      { type: "TXT", txt: ["preserve"] },
      { type: "NS", ns: "old.example." },
    ]);
    expect(result.observation.view).toBe("current");
    expect(result.observation.tip_height).toBe(812_345);
    expect(result.observation.update_inclusion_height).toBe(800_000);
    expect(result.observation.commitment).toBeNull();
    expect(result.observation.anchor.height).toBe(812_345);
    expect(calls).toEqual([
      { method: "getblockchaininfo", params: [] },
      { method: "getblockheader", params: [tipHash, true] },
      { method: "getnameinfo", params: ["newroot", false] },
      { method: "getnameresource", params: ["newroot", false] },
      { method: "getblockchaininfo", params: [] },
      { method: "getblockheader", params: [tipHash, true] },
    ]);
  });

  test("reads the safe view with safe=true and retains the selected commitment root, height and hash", async () => {
    const calls: unknown[] = [];
    const commitmentHeight = hsdSafeCommitmentHeightV1(812_345, 36, 12);
    expect(commitmentHeight).toBe(812_340);
    const commitmentHash = "cc".repeat(32);
    const commitmentRoot = "ee".repeat(32);
    const responses = [
      rpcResponse(chainInfo()),
      rpcResponse(tipHeader()),
      rpcResponse(activeNameInfo(800_001)),
      rpcResponse({ hash: commitmentHash }),
      rpcResponse({
        hash: commitmentHash,
        height: commitmentHeight,
        mediantime: tipMedianTime - 600,
        time: tipHeaderTime - 600,
        confirmations: 6,
        // hsd spells this `treeroot` in getblockheader.
        treeroot: commitmentRoot,
      }),
      rpcResponse(resource([{ type: "NS", ns: "ns1.pirate." }])),
      rpcResponse(chainInfo()),
      rpcResponse(tipHeader()),
    ];
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      () => nowMs,
    );
    const result = await observe("newroot", "safe");
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") throw new Error("unreachable");
    expect(result.observation.view).toBe("safe");
    expect(result.observation.commitment).toEqual({
      selection_basis: "hsd_getsaferoot_compatible",
      commitment_height: 812_340,
      commitment_block_hash: commitmentHash,
      commitment_tree_root: commitmentRoot,
      tip_height: 812_345,
      tree_interval_blocks: 36,
      minimum_confirmations: 12,
    });
    expect(result.observation.records).toEqual([{ type: "NS", ns: "ns1.pirate." }]);
    expect(calls).toEqual([
      { method: "getblockchaininfo", params: [] },
      { method: "getblockheader", params: [tipHash, true] },
      { method: "getnameinfo", params: ["newroot", true] },
      // Verbose: hsd returns a hex string otherwise, which the observer
      // cannot read. A live regtest node established this (T03).
      { method: "getblockbyheight", params: [812_340, true, false] },
      { method: "getblockheader", params: [commitmentHash, true] },
      { method: "getnameresource", params: ["newroot", true] },
      { method: "getblockchaininfo", params: [] },
      { method: "getblockheader", params: [tipHash, true] },
    ]);
  });

  test("accepts an active re-registered root carrying HSD's historical expired flag", async () => {
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getblockchaininfo") return rpcResponse(chainInfo());
        if (request.method === "getblockheader") return rpcResponse(tipHeader());
        if (request.method === "getnameinfo") {
          return rpcResponse({
            info: {
              state: "CLOSED",
              registered: true,
              expired: true,
              stats: { renewalPeriodEnd: 433_420, blocksUntilExpire: 87_098 },
              height: 800_002,
            },
          });
        }
        if (request.method === "getnameresource") return rpcResponse(null);
        throw new Error("unexpected request");
      },
      () => nowMs,
    );
    const result = await observe("technohippies", "current");
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") throw new Error("unreachable");
    expect(result.observation.records).toEqual([]);
    expect(result.observation.update_inclusion_height).toBe(800_002);
  });

  test("diverges between the current and safe view on the same name without conflating them", async () => {
    const currentRecords = [{ type: "NS", ns: "ns2.pirate." }];
    const safeRecords = [{ type: "NS", ns: "old.example." }];
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (request.method === "getblockchaininfo") return rpcResponse(chainInfo());
        if (request.method === "getblockheader" && request.params[0] === tipHash) {
          return rpcResponse(tipHeader());
        }
        if (request.method === "getnameinfo") return rpcResponse(activeNameInfo());
        if (request.method === "getnameresource") {
          return rpcResponse(resource(request.params[1] === true ? safeRecords : currentRecords));
        }
        if (request.method === "getblockbyheight") {
          return rpcResponse({ hash: "dd".repeat(32) });
        }
        if (request.method === "getblockheader") {
          return rpcResponse(
            tipHeader({ treeRoot: "ee".repeat(32), hash: "dd".repeat(32), height: 812_340 }),
          );
        }
        throw new Error(`unexpected request ${request.method}`);
      },
      () => nowMs,
    );
    const current = await observe("newroot", "current");
    const safe = await observe("newroot", "safe");
    if (current.kind !== "observed" || safe.kind !== "observed") throw new Error("unreachable");
    expect(current.observation.records).toEqual(currentRecords);
    expect(safe.observation.records).toEqual(safeRecords);
    expect(current.observation.resource_sha256).not.toBe(safe.observation.resource_sha256);
    expect(current.observation.view).not.toBe(safe.observation.view);
  });

  test("rejects a moved anchor between the bracketing reads as chain_moving unavailable evidence", async () => {
    let chainReads = 0;
    const advancedHash = "bb".repeat(32);
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (request.method === "getblockchaininfo") {
          chainReads += 1;
          // The chain advances between the first bracket and the second.
          if (chainReads <= 1) return rpcResponse(chainInfo());
          return rpcResponse(
            chainInfo({
              blocks: 812_346,
              headers: 812_346,
              bestblockhash: advancedHash,
              mediantime: tipMedianTime + 600,
            }),
          );
        }
        if (request.method === "getblockheader") {
          if (request.params[0] === advancedHash) {
            return rpcResponse(
              tipHeader({
                hash: advancedHash,
                height: 812_346,
                mediantime: tipMedianTime + 600,
                time: tipHeaderTime + 600,
              }),
            );
          }
          return rpcResponse(tipHeader());
        }
        if (request.method === "getnameinfo") return rpcResponse(activeNameInfo());
        if (request.method === "getnameresource") return rpcResponse(resource([]));
        throw new Error(`unexpected request ${request.method}`);
      },
      () => nowMs,
    );
    const result = await observe("newroot", "current");
    expect(result).toEqual({ kind: "unavailable", classification: "chain_moving" });
  });

  test.each([
    ["wrong_network", (): Record<string, unknown> => chainInfo({ chain: "regtest" })],
    ["node_stale", (): Record<string, unknown> => chainInfo({ headers: 812_300 })],
    ["malformed_response", (): Record<string, unknown> => chainInfo({ blocks: "many" })],
  ] as const)(
    "classifies an unhealthy node as %s before any name read",
    async (classification, chain) => {
      let calls = 0;
      const observe = makeHsdRootResourceObserver(
        config,
        async () => {
          calls += 1;
          return rpcResponse(chain());
        },
        () => nowMs,
      );
      expect(await observe("newroot", "current")).toEqual({
        kind: "unavailable",
        classification,
      });
      expect(calls).toBe(1);
    },
  );

  test("classifies a node whose tip median time is too old as node_stale", async () => {
    const staleMedianTime = Date.parse("2026-09-08T12:00:00Z") / 1_000;
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getblockchaininfo") {
          return rpcResponse(chainInfo({ mediantime: staleMedianTime }));
        }
        if (request.method === "getblockheader") {
          return rpcResponse(tipHeader({ mediantime: staleMedianTime }));
        }
        throw new Error("unexpected request");
      },
      () => nowMs,
    );
    expect(await observe("newroot", "current")).toEqual({
      kind: "unavailable",
      classification: "node_stale",
    });
  });

  test("classifies transport failure and malformed envelopes as unavailable evidence", async () => {
    const transportObserver = makeHsdRootResourceObserver(
      config,
      async () => {
        throw new Error("connection refused");
      },
      () => nowMs,
    );
    expect(await transportObserver("newroot", "current")).toEqual({
      kind: "unavailable",
      classification: "transport_failure",
    });
    const malformedObserver = makeHsdRootResourceObserver(
      config,
      async () => new Response("<html>gateway</html>", { status: 200 }),
      () => nowMs,
    );
    expect(await malformedObserver("newroot", "current")).toEqual({
      kind: "unavailable",
      classification: "transport_failure",
    });
  });

  test("reports a name without an active CLOSED registration as a resource_absent finding", async () => {
    let nameReads = 0;
    const observe = makeHsdRootResourceObserver(
      config,
      async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (request.method === "getblockchaininfo") return rpcResponse(chainInfo());
        if (request.method === "getblockheader") return rpcResponse(tipHeader());
        if (request.method === "getnameinfo") {
          nameReads += 1;
          return rpcResponse({ info: { state: "OPENING", registered: false } });
        }
        throw new Error("unexpected request");
      },
      () => nowMs,
    );
    const result = await observe("newroot", "current");
    expect(result.kind).toBe("finding");
    if (result.kind === "finding") {
      expect(result.classification).toBe("resource_absent");
      expect(result.anchor.height).toBe(812_345);
    }
    expect(nameReads).toBe(1);
  });

  test("computes the HSD safe commitment height across interval boundaries", () => {
    // Mainnet tree interval 36, safe threshold 12: mod >= 12 keeps the tip.
    expect(hsdSafeCommitmentHeightV1(812_345, 36, 12)).toBe(812_340);
    expect(hsdSafeCommitmentHeightV1(812_352, 36, 12)).toBe(812_352);
    expect(hsdSafeCommitmentHeightV1(812_348, 36, 12)).toBe(812_340);
    expect(hsdSafeCommitmentHeightV1(36, 36, 12)).toBe(36);
    expect(hsdSafeCommitmentHeightV1(0, 36, 12)).toBe(0);
  });
});
