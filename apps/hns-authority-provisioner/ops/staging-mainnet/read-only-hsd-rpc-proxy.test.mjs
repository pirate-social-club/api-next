import { strict as assert } from "node:assert";
import { once } from "node:events";
import { test } from "node:test";
import { allowedHsdReadRequest, createReadOnlyHsdRpcProxy } from "./read-only-hsd-rpc-proxy.mjs";

test("the staging reader admits only the five observation calls", () => {
  assert.equal(allowedHsdReadRequest({ method: "getblockchaininfo", params: [] }), true);
  assert.equal(allowedHsdReadRequest({ method: "getblockheader", params: ["a".repeat(64), true] }), true);
  assert.equal(allowedHsdReadRequest({ method: "getblockbyheight", params: [348_900, true, false] }), true);
  assert.equal(allowedHsdReadRequest({ method: "getnameinfo", params: ["8s28", false] }), true);
  assert.equal(allowedHsdReadRequest({ method: "getnameresource", params: ["8s28", true] }), true);
  assert.equal(allowedHsdReadRequest({ method: "sendrawtransaction", params: ["00"] }), false);
  assert.equal(allowedHsdReadRequest({ method: "getblockbyheight", params: [348_900, false, true] }), false);
});

test("the staging reader authenticates, refuses a broadcast, and forwards a bounded read", async () => {
  const calls = [];
  const server = createReadOnlyHsdRpcProxy({
    clientKey: "client-test-key",
    upstreamKey: "upstream-test-key",
    fetcher: async (_url, init) => {
      calls.push(init);
      return Response.json({ result: { chain: "main" }, error: null });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const authorization = `Basic ${Buffer.from("x:client-test-key").toString("base64")}`;
  const send = (method, params, authenticated = true) => fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: authenticated ? { authorization } : {},
    body: JSON.stringify({ method, params }),
  });
  try {
    assert.equal((await send("getblockchaininfo", [], false)).status, 401);
    assert.equal((await send("sendrawtransaction", ["00"])).status, 403);
    const read = await send("getblockchaininfo", []);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { result: { chain: "main" }, error: null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("x:upstream-test-key").toString("base64")}`);
  } finally {
    server.close();
    await once(server, "close");
  }
});
