import { describe, expect, test } from "bun:test";
import { readNativeBalance } from "./native-balance";

describe("native balance reader", () => {
  test("uses the bounded JSON-RPC contract without wallet secrets", async () => {
    const calls: Array<{ method: string; params: readonly unknown[] }> = [];
    const account = `0x${"a".repeat(40)}`;
    const balance = await readNativeBalance(async (method, params) => {
      calls.push({ method, params });
      return "0x2a";
    }, account.toUpperCase());

    expect(balance).toBe(42n);
    expect(calls).toEqual([{ method: "eth_getBalance", params: [account, "latest"] }]);
  });

  test("rejects malformed accounts and quantities", async () => {
    await expect(readNativeBalance(async () => "0x1", "not-an-address")).rejects.toThrow(
      "invalid native balance account",
    );
    await expect(readNativeBalance(async () => "0x00", `0x${"b".repeat(40)}`)).rejects.toThrow(
      "invalid native balance response",
    );
  });

  test("pins an exact block and refuses negative heights before sending RPC", async () => {
    const calls: Array<readonly unknown[]> = [];
    const rpc = async (_method: string, params: readonly unknown[]) => {
      calls.push(params);
      return "0x2a";
    };
    const account = `0x${"b".repeat(40)}`;
    expect(await readNativeBalance(rpc, account, 100n)).toBe(42n);
    expect(await readNativeBalance(rpc, account, 0n)).toBe(42n);
    expect(calls).toEqual([
      [account, "0x64"],
      [account, "0x0"],
    ]);
    await expect(readNativeBalance(rpc, account, -1n)).rejects.toThrow(
      "invalid native balance block",
    );
    expect(calls).toHaveLength(2);
  });
});
