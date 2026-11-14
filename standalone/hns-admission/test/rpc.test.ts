import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRpc } from "../src/hsd-rpc.ts";
test("RPC transport bounds responses, refuses redirects/writes and preserves unavailable history", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "fixture-only",
    );
    assert.equal(JSON.parse(init!.body as string).method, "getblockhash");
    return Response.json({ id: 1, error: null, result: "blockhash" });
  };
  const rpc = makeRpc(
    { url: "https://observer.test/rpc", authorization: "fixture-only" },
    fetcher,
  );
  assert.equal(await rpc.call("getblockhash", [0]), "blockhash");
  await assert.rejects(() => rpc.call("sendupdate" as never), /observer_stale/);
  assert.equal(calls, 1);
  const missing = makeRpc(
    { url: "https://observer.test", authorization: "fixture-only" },
    async () =>
      Response.json({ id: 1, result: null, error: { message: "missing" } }),
  );
  await assert.rejects(
    () => missing.call("getrawtransaction"),
    /ownership_history_unavailable/,
  );
  const oversized = makeRpc(
    { url: "https://observer.test", authorization: "fixture-only" },
    async () =>
      new Response(" ".repeat(1048577), {
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(() => oversized.call("getblockhash"), /observer_stale/);
  const malformed = makeRpc(
    { url: "https://observer.test", authorization: "fixture-only" },
    async () =>
      new Response('{"id":1,"id":1,"error":null,"result":1}', {
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(
    () => malformed.call("getblockhash"),
    /observer_timeout/,
  );
});
