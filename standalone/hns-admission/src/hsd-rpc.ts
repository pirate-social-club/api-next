import { Schema } from "effect";
import { strictJson } from "./strict-json.ts";
export const Hash64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const HexBytes = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{2})*$/),
);
export const Integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type RpcMethod =
  | "getblockchaininfo"
  | "getblockhash"
  | "getblockheader"
  | "getnameinfo"
  | "getrawtransaction";
export class HsdUnavailable extends Error {
  readonly reason:
    | "observer_timeout"
    | "observer_stale"
    | "ownership_history_unavailable";
  constructor(reason: HsdUnavailable["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
export interface RpcConfig {
  url: string;
  authorization: string;
}
export interface HsdRpc {
  call: (
    method: RpcMethod,
    params?: readonly unknown[],
    signal?: AbortSignal,
  ) => Promise<unknown>;
}
export function makeRpc(
  config: RpcConfig,
  fetcher: typeof fetch = fetch,
): HsdRpc {
  const url = new URL(config.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !config.authorization
  )
    throw new Error("invalid_rpc_config");
  return {
    async call(method, params = [], signal) {
      if (
        ![
          "getblockchaininfo",
          "getblockhash",
          "getblockheader",
          "getnameinfo",
          "getrawtransaction",
        ].includes(method)
      )
        throw new HsdUnavailable("observer_stale");
      const local = AbortSignal.timeout(5000);
      try {
        const response = await fetcher(config.url, {
          method: "POST",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, local]) : local,
          headers: {
            authorization: config.authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: 1, method, params }),
        });
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("application/json")
        )
          throw new HsdUnavailable("observer_timeout");
        const reader = response.body?.getReader();
        if (!reader) throw new HsdUnavailable("observer_stale");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 1048576) {
              await reader.cancel();
              throw new HsdUnavailable("observer_stale");
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const envelope = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.Literal(1),
            result: Schema.Unknown,
            error: Schema.Unknown,
          }),
        )(strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), {
          onExcessProperty: "error",
        });
        if (envelope.error !== null)
          throw new HsdUnavailable(
            method === "getrawtransaction"
              ? "ownership_history_unavailable"
              : "observer_stale",
          );
        return envelope.result;
      } catch (e) {
        if (e instanceof HsdUnavailable) throw e;
        throw new HsdUnavailable("observer_timeout");
      }
    },
  };
}
export const ChainInfo = Schema.Struct({
  chain: Schema.String,
  blocks: Integer,
  headers: Integer,
  bestblockhash: Hash64,
});
export const Header = Schema.Struct({
  hash: Hash64,
  height: Integer,
  time: Integer,
  treeroot: Hash64,
});
export const NameInfo = Schema.Struct({
  name: Schema.String,
  nameHash: Hash64,
  state: Schema.String,
  registered: Schema.Boolean,
  owner: Schema.Struct({ hash: Hash64, index: Integer }),
  data: HexBytes,
  transfer: Integer,
  stats: Schema.Struct({ blocksUntilExpire: Schema.Int }),
});
export const Transaction = Schema.Struct({
  txid: Hash64,
  blockhash: Hash64,
  vin: Schema.Array(Schema.Struct({ txid: Hash64, vout: Integer })),
  vout: Schema.Array(
    Schema.Struct({
      n: Integer,
      covenant: Schema.Struct({
        action: Schema.String,
        items: Schema.Array(HexBytes),
      }),
    }),
  ),
});
export const decode = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  data: unknown,
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(data);
  } catch {
    throw new HsdUnavailable("observer_stale");
  }
};
