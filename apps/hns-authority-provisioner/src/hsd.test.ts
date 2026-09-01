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

  test("refuses an inactive root before reading its resource", async () => {
    let calls = 0;
    const inspect = makeHsdRootResourceInspector(
      { rpc_url: "http://hsd.test:12037", authorization: "Basic opaque" },
      async () => {
        calls += 1;
        return rpcResponse({ info: { state: "CLOSED", registered: true, expired: true } });
      },
    );
    await expect(inspect("newroot")).rejects.toThrow("HSD root is not active");
    expect(calls).toBe(1);
  });
});
