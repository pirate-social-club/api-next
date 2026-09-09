/**
 * Drive controlled Handshake chain progression against a regtest node (T03).
 *
 * Funds a wallet, acquires a name through its auction, publishes a replacement
 * resource, and reports the current and safe views as the chain advances. It
 * mutates only the disposable regtest chain in the container named below and
 * makes no request to any production system.
 */

const NODE = process.env.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
const WALLET = process.env.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
const KEY = process.env.HSD_REGTEST_API_KEY ?? "controlled-progression";
const NAME = process.env.HSD_REGTEST_NAME ?? "t03harness";

const authorization = `Basic ${Buffer.from(`x:${KEY}`).toString("base64")}`;

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
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

await wallet("sendupdate", [
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
]);
await mine(1, address);
const inclusion = await height();
console.log(`inclusion height ${inclusion}: ${JSON.stringify(await views())}`);

for (let advanced = 5; advanced <= 30; advanced += 5) {
  await mine(5, address);
  const observed = await views();
  console.log(`+${advanced} (height ${await height()}): ${JSON.stringify(observed)}`);
  if (observed.safe) break;
}
