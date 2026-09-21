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
export const hsdRegtestGenesis = "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5";

const required = process.env.HNS_REGTEST_TEST_REQUIRED === "1";

export type HsdRegtestIdentity = Readonly<{
  chain: unknown;
  genesis: unknown;
}>;

export function hsdRegtestIdentityError(identity: HsdRegtestIdentity): string | null {
  if (identity.chain !== "regtest") {
    return `HSD regtest required, received chain ${JSON.stringify(identity.chain)}`;
  }
  if (identity.genesis !== hsdRegtestGenesis) {
    return `HSD regtest genesis mismatch: expected ${hsdRegtestGenesis}, received ${JSON.stringify(identity.genesis)}`;
  }
  return null;
}

export function hsdRegtestEndpointError(label: string, raw: string): string | null {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    return `${label} must be an http://127.0.0.1 endpoint`;
  }
  return null;
}

function assertLoopbackEndpoint(label: string, raw: string): void {
  const failure = hsdRegtestEndpointError(label, raw);
  if (failure !== null) throw new Error(failure);
}

type HsdRpc = (url: string, method: string, params: readonly unknown[]) => Promise<unknown>;

export async function probeHsdRegtestIdentity(request: HsdRpc = rpc): Promise<HsdRegtestIdentity> {
  const information = (await request(hsdRegtestNodeUrl, "getblockchaininfo", [])) as {
    readonly chain?: unknown;
  };
  return {
    chain: information.chain,
    genesis: await request(hsdRegtestNodeUrl, "getblockhash", [0]),
  };
}

export async function probeHsdRegtestWallet(request: HsdRpc = rpc): Promise<void> {
  const information = await request(walletUrl, "getwalletinfo", []);
  if (information === null || typeof information !== "object") {
    throw new Error("HSD regtest wallet returned malformed readiness data");
  }
}

export async function requireHsdRegtest(request: HsdRpc = rpc): Promise<void> {
  if (hsdRegtestConnectionString === undefined || hsdRegtestConnectionString.trim() === "") {
    throw new Error("required HNS regtest PostgreSQL fixture is missing");
  }
  assertLoopbackEndpoint("HSD regtest node", hsdRegtestNodeUrl);
  assertLoopbackEndpoint("HSD regtest wallet", walletUrl);
  const failure = hsdRegtestIdentityError(await probeHsdRegtestIdentity(request));
  if (failure !== null) throw new Error(failure);
  await probeHsdRegtestWallet(request);
}

export async function hsdRegtestReachable(): Promise<boolean> {
  if (required) {
    await requireHsdRegtest();
    return true;
  }
  if (hsdRegtestConnectionString === undefined) return false;
  try {
    await requireHsdRegtest();
    return true;
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

export async function markHnsRegtestSuiteComplete(
  variable: string,
  contents: string,
): Promise<void> {
  if (!required) return;
  const path = process.env[variable];
  if (path === undefined || path.trim() === "") {
    throw new Error(`${variable} is required in required HNS regtest mode`);
  }
  await Bun.write(path, `${contents}\n`);
}
