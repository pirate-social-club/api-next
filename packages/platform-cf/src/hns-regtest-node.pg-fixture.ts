/**
 * The shared regtest-node fixture for the live HNS chain suites.
 *
 * Endpoint selection, authorization, reachability probing and JSON-RPC are
 * identical across the composed-path, service-loop-entrypoint and
 * incident-evidence suites; those concerns live here once. Each suite keeps
 * its own assertions, name progression and database schema.
 */

export const hsdRegtestConnectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
export const hsdRegtestNodeUrl = process.env.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
const walletUrl = process.env.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
const apiKey = process.env.HSD_REGTEST_API_KEY ?? "controlled-progression";
export const hsdRegtestAuthorization = `Basic ${Buffer.from(`x:${apiKey}`).toString("base64")}`;

export async function hsdRegtestReachable(): Promise<boolean> {
  if (hsdRegtestConnectionString === undefined) return false;
  try {
    const response = await fetch(hsdRegtestNodeUrl, {
      method: "POST",
      headers: { authorization: hsdRegtestAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ method: "getblockchaininfo", params: [] }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await response.json()) as { readonly result?: { readonly chain?: string } };
    return body.result?.chain === "regtest";
  } catch {
    return false;
  }
}

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: hsdRegtestAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { readonly result?: unknown; readonly error?: unknown };
  if (body.error !== null && body.error !== undefined) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

export const hsdRegtestNode = (method: string, params: readonly unknown[] = []) =>
  rpc(hsdRegtestNodeUrl, method, params);
export const hsdRegtestWallet = (method: string, params: readonly unknown[] = []) =>
  rpc(walletUrl, method, params);
export const hsdRegtestHeight = async (): Promise<number> =>
  ((await hsdRegtestNode("getblockchaininfo")) as { readonly blocks: number }).blocks;
