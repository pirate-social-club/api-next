import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";

/**
 * One in-process HSD JSON-RPC boundary fixture for the activation gatherer
 * tests. It answers the bracketed current-view read the shared observer makes
 * and nothing else; the records it serves are the test's chain state, so an
 * expected wire digest can be prepared from the same records independently of
 * any observation.
 */
export type HnsRootResourceRpcFixture = Readonly<{
  readonly url: string;
  readonly calls: readonly string[];
  setRecords: (records: readonly HnsRootResourceRecordV1[]) => void;
  setFailure: (mode: "ok" | "transport" | "malformed" | "resource_absent" | "resourceless") => void;
  setChainNetwork: (network: string) => void;
  stop: () => void;
}>;

const TIP_HEIGHT = 812_345;
const TIP_HASH = "aa".repeat(32);

export function startHnsRootResourceRpcFixture(options?: {
  readonly onRequest?: () => Promise<void>;
}): HnsRootResourceRpcFixture {
  let records: readonly HnsRootResourceRecordV1[] = [];
  let failure: "ok" | "transport" | "malformed" | "resource_absent" | "resourceless" = "ok";
  let network = "regtest";
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const requestBody = (await request.json().catch(() => null)) as {
        readonly method?: unknown;
      } | null;
      const method = typeof requestBody?.method === "string" ? requestBody.method : "";
      calls.push(method);
      if (options?.onRequest !== undefined) await options.onRequest();
      if (failure === "transport") {
        return new Response("provider unavailable", { status: 503 });
      }
      if (failure === "malformed") {
        return new Response("<html>gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const result = (value: unknown): Response =>
        Response.json({ result: value, error: null, id: null });
      switch (method) {
        case "getblockchaininfo":
          return result({
            chain: network,
            blocks: TIP_HEIGHT,
            headers: TIP_HEIGHT,
            mediantime: nowSeconds,
            bestblockhash: TIP_HASH,
          });
        case "getblockheader":
          return result({
            hash: TIP_HASH,
            height: TIP_HEIGHT,
            mediantime: nowSeconds,
            time: nowSeconds,
            confirmations: 1,
          });
        case "getnameinfo":
          return result(
            failure === "resource_absent"
              ? { info: { state: "OPENING", registered: false } }
              : { info: { state: "CLOSED", registered: true, expired: false, height: 800_000 } },
          );
        case "getnameresource":
          return result(failure === "resourceless" ? null : { records: [...records] });
        default:
          return new Response("unexpected method", { status: 500 });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    calls,
    setRecords: (value) => {
      records = value;
    },
    setFailure: (value) => {
      failure = value;
    },
    setChainNetwork: (value) => {
      network = value;
    },
    stop: () => {
      server.stop(true);
    },
  };
}
