import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";
import { hsdSafeCommitmentHeightV1 } from "@pirate/application/namespace-ownership";

/**
 * One in-process HSD JSON-RPC boundary fixture for the activation gatherer
 * and joint-ceremony tests. It answers the bracketed current and safe reads
 * the shared observer makes; the records it serves are the test's chain
 * state, so an expected wire digest can be prepared from the same records
 * independently of any observation. The safe view resolves through one
 * deterministic commitment block so the ceremony can establish finality
 * without a live node.
 */
export type HnsRootResourceRpcFixture = Readonly<{
  readonly url: string;
  readonly calls: readonly string[];
  setRecords: (records: readonly HnsRootResourceRecordV1[]) => void;
  setSafeRecords: (records: readonly HnsRootResourceRecordV1[]) => void;
  setFailure: (mode: "ok" | "transport" | "malformed" | "resource_absent" | "resourceless") => void;
  setChainNetwork: (network: string) => void;
  stop: () => void;
}>;

const TIP_HEIGHT = 812_345;
const TIP_HASH = "aa".repeat(32);
const TREE_INTERVAL_BLOCKS = 36;
const SAFE_CONFIRMATIONS = 12;
const COMMITMENT_HEIGHT = hsdSafeCommitmentHeightV1(
  TIP_HEIGHT,
  TREE_INTERVAL_BLOCKS,
  SAFE_CONFIRMATIONS,
);
const COMMITMENT_HASH = "bb".repeat(32);
const COMMITMENT_TREE_ROOT = "cc".repeat(32);

export function startHnsRootResourceRpcFixture(options?: {
  readonly onRequest?: () => Promise<void>;
}): HnsRootResourceRpcFixture {
  let records: readonly HnsRootResourceRecordV1[] = [];
  let safeRecords: readonly HnsRootResourceRecordV1[] | null = null;
  let failure: "ok" | "transport" | "malformed" | "resource_absent" | "resourceless" = "ok";
  let network = "regtest";
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const requestBody = (await request.json().catch(() => null)) as {
        readonly method?: unknown;
        readonly params?: unknown;
      } | null;
      const method = typeof requestBody?.method === "string" ? requestBody.method : "";
      calls.push(method);
      if (options?.onRequest !== undefined) await options.onRequest();
      if (failure === "transport") {
        return new Response("provider unavailable", { status: 503 });
      }
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const result = (value: unknown): Response =>
        Response.json({ result: value, error: null, id: null });
      const params = Array.isArray(requestBody?.params) ? requestBody.params : [];
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
          return params[0] === COMMITMENT_HASH
            ? result({
                hash: COMMITMENT_HASH,
                height: COMMITMENT_HEIGHT,
                mediantime: nowSeconds,
                time: nowSeconds,
                confirmations: SAFE_CONFIRMATIONS,
                // hsd spells this `treeroot`; the observer accepts it.
                treeroot: COMMITMENT_TREE_ROOT,
              })
            : result({
                hash: TIP_HASH,
                height: TIP_HEIGHT,
                mediantime: nowSeconds,
                time: nowSeconds,
                confirmations: 1,
              });
        case "getblockbyheight":
          return result({ hash: COMMITMENT_HASH });
        case "getnameinfo":
          return result(
            failure === "resource_absent"
              ? { info: { state: "OPENING", registered: false } }
              : { info: { state: "CLOSED", registered: true, expired: false, height: 800_000 } },
          );
        case "getnameresource":
          if (failure === "malformed") {
            // The anchor reads stay healthy and only the name read carries
            // unparseable bytes under a JSON content type, so the observer
            // reaches its decoder and classifies malformed_response rather
            // than classifying the node itself as unavailable.
            return new Response('{"result":', {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (failure === "resourceless") return result(null);
          return result({
            records: [...(params[1] === true ? (safeRecords ?? records) : records)],
          });
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
    setSafeRecords: (value) => {
      safeRecords = value;
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
