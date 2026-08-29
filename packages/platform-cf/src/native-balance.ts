export type NativeBalanceJsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;

/** Reads one native balance without accepting or persisting wallet secrets. */
export async function readNativeBalance(
  rpc: NativeBalanceJsonRpc,
  account: string,
): Promise<bigint> {
  if (!ADDRESS.test(account)) throw new Error("invalid native balance account");
  const value = await rpc("eth_getBalance", [account.toLowerCase(), "latest"]);
  if (typeof value !== "string" || !QUANTITY.test(value)) {
    throw new Error("invalid native balance response");
  }
  return BigInt(value);
}
