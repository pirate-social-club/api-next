import { describe, expect, test } from "bun:test";
import { makeHsdRootResourceInspector } from "./hsd.ts";

function rpcResponse(result: unknown): Response {
  return Response.json({ result, error: null, id: null });
}

describe("HSD root resource inspector", () => {
  test("requires an active root and returns its verbatim current record list", async () => {
    const calls: unknown[] = [];
    const responses = [
      rpcResponse({ info: { state: "CLOSED", registered: true, expired: false } }),
      rpcResponse({
        records: [
          { type: "TXT", txt: ["preserve"] },
          { type: "NS", ns: "old.example." },
        ],
      }),
    ];
    const inspect = makeHsdRootResourceInspector(
      { rpc_url: "http://hsd.test:12037", authorization: "Basic opaque" },
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    );
    expect(await inspect("newroot")).toEqual([
      { type: "TXT", txt: ["preserve"] },
      { type: "NS", ns: "old.example." },
    ]);
    expect(calls).toEqual([
      { method: "getnameinfo", params: ["newroot", true] },
      { method: "getnameresource", params: ["newroot", true] },
    ]);
  });

  test("accepts an active re-registered root carrying HSD's historical expired flag", async () => {
    const responses = [
      rpcResponse({
        info: {
          state: "CLOSED",
          registered: true,
          expired: true,
          stats: { renewalPeriodEnd: 433420, blocksUntilExpire: 87098 },
        },
      }),
      rpcResponse({ records: [] }),
    ];
    const inspect = makeHsdRootResourceInspector(
      { rpc_url: "http://hsd.test:12037", authorization: "Basic opaque" },
      async () => {
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    );
    expect(await inspect("technohippies")).toEqual([]);
    expect(responses).toHaveLength(0);
  });

  test.each([
    null,
    { state: "REVOKED", registered: true, expired: false },
    { state: "BIDDING", registered: false, expired: true },
    { state: "CLOSED", registered: false, expired: false },
    { state: "CLOSED", registered: true, expired: "false" },
  ])(
    "refuses an absent, inactive or malformed root before reading its resource: %j",
    async (info) => {
      let calls = 0;
      const inspect = makeHsdRootResourceInspector(
        { rpc_url: "http://hsd.test:12037", authorization: "Basic opaque" },
        async () => {
          calls += 1;
          return rpcResponse({ info });
        },
      );
      await expect(inspect("newroot")).rejects.toThrow();
      expect(calls).toBe(1);
    },
  );
});
