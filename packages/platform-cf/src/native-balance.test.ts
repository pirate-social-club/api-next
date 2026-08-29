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
});
