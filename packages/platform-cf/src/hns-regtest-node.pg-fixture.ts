/**
 * The shared regtest-node fixture for the live HNS chain suites.
 *
 * Endpoint selection, authorization, reachability probing and JSON-RPC are
 * identical across the composed-path, service-loop-entrypoint and
 * incident-evidence suites; those concerns live here once. Each suite keeps
 * its own assertions, name progression and database schema.
 * HNS_REGTEST_TEST_CONTEXT=pg-only disables every RPC/probe before transport.
 * Import-time validation rejects unknown contexts and pg-only/required conflicts.
 */

export const hsdRegtestGenesis = "ae3895cf597eff05b19e02a70ceeeecb9dc72dbfe6504a50e9343a72f06a87c5";

/** Call before PG-only discovery; module initialization applies this same check. */
export function validateHnsRegtestTestContext(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): "hns" | "pg-only" {
  const context = environment.HNS_REGTEST_TEST_CONTEXT;
  if (context !== undefined && context !== "hns" && context !== "pg-only")
    throw new Error("HNS_REGTEST_TEST_CONTEXT must be hns or pg-only when provided");
  if (context === "pg-only" && environment.HNS_REGTEST_TEST_REQUIRED === "1")
    throw new Error("HNS_REGTEST_TEST_CONTEXT=pg-only conflicts with HNS_REGTEST_TEST_REQUIRED=1");
  return context ?? "hns";
}

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

/** Independent immutable RPC context: tests inject transport without shared env/fetch mutation. */
export function createHsdRegtestFixture(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: {
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    readonly writeSentinel?: (path: string, contents: string) => Promise<unknown>;
  } = {},
) {
  const context = validateHnsRegtestTestContext(environment);
  const required = environment.HNS_REGTEST_TEST_REQUIRED === "1";
  const hsdRegtestConnectionString = environment.CONTROL_PLANE_POSTGRES_TEST_URL;
  const hsdRegtestNodeUrl = environment.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
  const hsdRegtestWalletUrl = environment.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
  const walletUrl = hsdRegtestWalletUrl;
  const apiKey = environment.HSD_REGTEST_API_KEY ?? "controlled-progression";
  const hsdRegtestAuthorization = `Basic ${Buffer.from(`x:${apiKey}`).toString("base64")}`;
  const requestFetch = dependencies.fetch ?? fetch;
  const writeSentinel =
    dependencies.writeSentinel ?? ((path: string, contents: string) => Bun.write(path, contents));
  function assertRpcAllowed(): void {
    if (context === "pg-only") throw new Error("HNS RPC is disabled in pg-only test context");
  }

  async function probeHsdRegtestIdentity(request: HsdRpc = rpc): Promise<HsdRegtestIdentity> {
    assertRpcAllowed();
    const information = (await request(hsdRegtestNodeUrl, "getblockchaininfo", [])) as {
      readonly chain?: unknown;
    };
    return {
      chain: information.chain,
      genesis: await request(hsdRegtestNodeUrl, "getblockhash", [0]),
    };
  }

  async function probeHsdRegtestWallet(request: HsdRpc = rpc): Promise<void> {
    assertRpcAllowed();
    const information = await request(walletUrl, "getwalletinfo", []);
    if (information === null || typeof information !== "object") {
      throw new Error("HSD regtest wallet returned malformed readiness data");
    }
  }

  async function requireHsdRegtest(request: HsdRpc = rpc): Promise<void> {
    assertRpcAllowed();
    if (hsdRegtestConnectionString === undefined || hsdRegtestConnectionString.trim() === "") {
      throw new Error("required HNS regtest PostgreSQL fixture is missing");
    }
    await requireHsdRegtestChain(request);
  }

  async function requireHsdRegtestChain(request: HsdRpc = rpc): Promise<void> {
    assertRpcAllowed();
    assertLoopbackEndpoint("HSD regtest node", hsdRegtestNodeUrl);
    assertLoopbackEndpoint("HSD regtest wallet", walletUrl);
    const failure = hsdRegtestIdentityError(await probeHsdRegtestIdentity(request));
    if (failure !== null) throw new Error(failure);
    await probeHsdRegtestWallet(request);
  }

  async function hsdRegtestReachable(): Promise<boolean> {
    if (context === "pg-only") return false;
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
    assertRpcAllowed();
    const response = await requestFetch(url, {
      method: "POST",
      redirect: "error",
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

  const hsdRegtestNode = (method: string, params: readonly unknown[] = []) =>
    rpc(hsdRegtestNodeUrl, method, params);
  const hsdRegtestWallet = (method: string, params: readonly unknown[] = []) =>
    rpc(walletUrl, method, params);
  const hsdRegtestHeight = async (): Promise<number> =>
    ((await hsdRegtestNode("getblockchaininfo")) as { readonly blocks: number }).blocks;

  async function markHnsRegtestSuiteComplete(variable: string, contents: string): Promise<void> {
    if (!required) return;
    const path = environment[variable];
    if (path === undefined || path.trim() === "") {
      throw new Error(`${variable} is required in required HNS regtest mode`);
    }
    await writeSentinel(path, `${contents}\n`);
  }
  return {
    hsdRegtestConnectionString,
    hsdRegtestNodeUrl,
    hsdRegtestWalletUrl,
    hsdRegtestAuthorization,
    probeHsdRegtestIdentity,
    probeHsdRegtestWallet,
    requireHsdRegtest,
    requireHsdRegtestChain,
    hsdRegtestReachable,
    hsdRegtestNode,
    hsdRegtestWallet,
    hsdRegtestHeight,
    markHnsRegtestSuiteComplete,
  };
}

// Every public RPC/probe export shares the validated module context. No import-time RPC.
export const {
  hsdRegtestConnectionString,
  hsdRegtestNodeUrl,
  hsdRegtestWalletUrl,
  hsdRegtestAuthorization,
  probeHsdRegtestIdentity,
  probeHsdRegtestWallet,
  requireHsdRegtest,
  requireHsdRegtestChain,
  hsdRegtestReachable,
  hsdRegtestNode,
  hsdRegtestWallet,
  hsdRegtestHeight,
  markHnsRegtestSuiteComplete,
} = createHsdRegtestFixture(process.env);
