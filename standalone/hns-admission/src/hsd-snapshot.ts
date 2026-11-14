import { Schema } from "effect";
import {
  decode,
  ChainInfo,
  Header,
  NameInfo,
  Transaction,
  HsdUnavailable,
  type HsdRpc,
  Hash64,
} from "./hsd-rpc.ts";
import { safeEntryHeight } from "./observation.ts";
import {
  decodeHnsResourceV1,
  preflightEncodeHnsResourceV1,
} from "./resource-codec.ts";
import { fromHex, toHex } from "./records.ts";
import type { HnsRootResourceRecordV1 } from "./resource-types.ts";
export interface ChainConfig {
  network: "main" | "regtest";
  genesis: string;
  treeInterval: number;
  maxHistory?: number;
}
type Name = typeof NameInfo.Type;
type Tx = typeof Transaction.Type;
export type Snapshot = {
  active: boolean;
  tipHash: string;
  tipHeight: number;
  tipTime: number;
  safeHeight: number;
  safeRoot: string;
  fetchedAt: number;
  records: readonly HnsRootResourceRecordV1[];
  resourceDigest: string;
  ownershipEpoch: string;
  safeResourceDigest: string;
  safeOwnershipEpoch: string;
  inclusionHash: string;
  inclusionHeight: number;
  inclusionTime: number;
  transferPending: boolean;
};
const empty = "0x" + "00".repeat(32);
async function digest(value: string) {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export function makeSnapshotReader(
  rpc: HsdRpc,
  config: ChainConfig,
  now: () => number,
) {
  const genesis = Schema.decodeUnknownSync(Hash64)(
    config.genesis.replace(/^0x/, ""),
  );
  if (
    config.treeInterval !== (config.network === "main" ? 36 : 5) ||
    !Number.isInteger(config.maxHistory ?? 64) ||
    (config.maxHistory ?? 64) < 1 ||
    (config.maxHistory ?? 64) > 256
  )
    throw new Error("invalid_observer_config");
  return async (tld: string, signal?: AbortSignal): Promise<Snapshot> => {
    const call = (
      method: Parameters<HsdRpc["call"]>[0],
      params: readonly unknown[] = [],
    ) => rpc.call(method, params, signal);
    const before = decode(ChainInfo, await call("getblockchaininfo"));
    if (
      before.chain !== config.network ||
      before.blocks !== before.headers ||
      (await call("getblockhash", [0])) !== genesis
    )
      throw new HsdUnavailable("observer_stale");
    const tip = decode(
      Header,
      await call("getblockheader", [before.bestblockhash, true]),
    );
    if (tip.hash !== before.bestblockhash || tip.height !== before.blocks)
      throw new HsdUnavailable("observer_stale");
    const safeHeight = safeEntryHeight(tip.height, config.treeInterval);
    const safeHash = decode(Hash64, await call("getblockhash", [safeHeight]));
    const safeHeader = decode(
      Header,
      await call("getblockheader", [safeHash, true]),
    );
    if (safeHeader.hash !== safeHash || safeHeader.height !== safeHeight)
      throw new HsdUnavailable("observer_stale");
    const nameResult = decode(
      Schema.Struct({ info: Schema.Unknown }),
      await call("getnameinfo", [tld, false]),
    );
    const safeResult = decode(
      Schema.Struct({ info: Schema.Unknown }),
      await call("getnameinfo", [tld, true]),
    );
    const cache = new Map<string, Tx>();
    const readTx = async (hash: string) => {
      let tx = cache.get(hash);
      if (!tx) {
        tx = decode(Transaction, await call("getrawtransaction", [hash, true]));
        if (tx.txid !== hash)
          throw new HsdUnavailable("ownership_history_unavailable");
        cache.set(hash, tx);
      }
      return tx;
    };
    const history = async (name: Name) => {
      let point = name.owner;
      let inclusion: { hash: string; height: number; time: number } | undefined;
      let continuous = true;
      for (let depth = 0; depth < (config.maxHistory ?? 64); depth++) {
        const tx = await readTx(point.hash),
          output = tx.vout[point.index];
        if (
          !output ||
          output.n !== point.index ||
          output.covenant.items[0] !== name.nameHash
        )
          throw new HsdUnavailable("ownership_history_unavailable");
        const header = decode(
          Header,
          await call("getblockheader", [tx.blockhash, true]),
        );
        if (
          header.hash !== tx.blockhash ||
          header.height > tip.height ||
          (await call("getblockhash", [header.height])) !== tx.blockhash
        )
          throw new HsdUnavailable("ownership_history_unavailable");
        const action = output.covenant.action;
        if (action === "REGISTER" || action === "UPDATE") {
          if (output.covenant.items[2] === name.data && continuous)
            inclusion = {
              hash: "0x" + header.hash,
              height: header.height,
              time: header.time,
            };
          else continuous = false;
        }
        if (action === "REGISTER" || action === "FINALIZE") {
          const epoch = await digest(
            [
              "pirate.hns-owner-epoch/1",
              genesis,
              point.hash,
              String(point.index),
            ].join(":"),
          );
          return {
            epoch,
            inclusion: inclusion ?? {
              hash: "0x" + header.hash,
              height: header.height,
              time: header.time,
            },
          };
        }
        if (!["UPDATE", "RENEW", "TRANSFER"].includes(action))
          throw new HsdUnavailable("ownership_history_unavailable");
        const previous = tx.vin[point.index];
        if (!previous)
          throw new HsdUnavailable("ownership_history_unavailable");
        point = { hash: previous.txid, index: previous.vout };
      }
      throw new HsdUnavailable("ownership_history_unavailable");
    };
    const active = (value: unknown): Name | null => {
      if (value === null) return null;
      const flags = decode(
        Schema.Struct({ state: Schema.String, registered: Schema.Boolean }),
        value,
      );
      if (flags.state !== "CLOSED" || !flags.registered) return null;
      const name = decode(NameInfo, value);
      if (name.name !== tld) throw new HsdUnavailable("observer_stale");
      return name.state === "CLOSED" &&
        name.registered &&
        name.stats.blocksUntilExpire > 0
        ? name
        : null;
    };
    const current = active(nameResult.info),
      safe = active(safeResult.info);
    const records = current
      ? decodeHnsResourceV1(fromHex("0x" + (current.data || "00")))
      : [];
    const resource = await preflightEncodeHnsResourceV1(records);
    const currentHistory = current ? await history(current) : null;
    const safeHistory = safe ? await history(safe) : null;
    const safeBytes = safe
      ? await preflightEncodeHnsResourceV1(
          decodeHnsResourceV1(fromHex("0x" + (safe.data || "00"))),
        )
      : null;
    const after = decode(ChainInfo, await call("getblockchaininfo"));
    if (
      after.bestblockhash !== before.bestblockhash ||
      after.blocks !== before.blocks
    )
      throw new HsdUnavailable("observer_stale");
    return {
      active: current !== null,
      tipHash: "0x" + tip.hash,
      tipHeight: tip.height,
      tipTime: tip.time,
      safeHeight,
      safeRoot: "0x" + safeHeader.treeroot,
      fetchedAt: now(),
      records,
      resourceDigest: "0x" + resource.sha256,
      ownershipEpoch: currentHistory?.epoch ?? empty,
      safeResourceDigest: safeBytes ? "0x" + safeBytes.sha256 : empty,
      safeOwnershipEpoch: safeHistory?.epoch ?? empty,
      inclusionHash: currentHistory?.inclusion.hash ?? empty,
      inclusionHeight: currentHistory?.inclusion.height ?? 0,
      inclusionTime: currentHistory?.inclusion.time ?? 0,
      transferPending: current !== null && current.transfer !== 0,
    };
  };
}
