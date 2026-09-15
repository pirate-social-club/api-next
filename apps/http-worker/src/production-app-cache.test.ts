import { describe, expect, test } from "bun:test";
import { makeRetryingPromiseCache } from "./production-app-cache.ts";

describe("production Worker composition cache", () => {
  test("does not retain a rejected composition", async () => {
    let attempts = 0;
    const load = makeRetryingPromiseCache(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("reward composition unavailable");
      return "ready";
    });

    await expect(load(undefined)).rejects.toThrow("reward composition unavailable");
    await expect(load(undefined)).resolves.toBe("ready");
    expect(attempts).toBe(2);
  });

  test("reuses a successful immutable composition", async () => {
    let attempts = 0;
    const load = makeRetryingPromiseCache(async () => {
      attempts += 1;
      return { status: "ready" };
    });

    const first = await load(undefined);
    const second = await load(undefined);
    expect(second).toBe(first);
    expect(attempts).toBe(1);
  });
});
