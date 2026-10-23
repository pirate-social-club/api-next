/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { runInDurableObject, env as testEnv } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { DanceNetworkRateLimiterDO } from "../../packages/platform-cf/src/dance-network-admission-do.ts";
import { DANCE_NETWORK_DAY_MS } from "../../packages/platform-cf/src/dance-network-admission-model.ts";

const env = testEnv as unknown as {
  DANCE_NETWORK_RATE_LIMITER: DurableObjectNamespace<DanceNetworkRateLimiterDO>;
};
const digest = (n: number) => n.toString(16).padStart(64, "0");
const bucket = (day = Math.floor(Date.now() / DANCE_NETWORK_DAY_MS)) =>
  `dance-network-v1:${day}:${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;

describe("Dance daily network SQLite admission", () => {
  it("persists another cleanup attempt when erasure fails", async () => {
    const bucketName = bucket();
    const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(bucketName);
    await stub.admit({ bucketName, commandDigest: digest(1) });
    await runInDurableObject(stub, async (instance: DanceNetworkRateLimiterDO, state) => {
      state.storage.sql.exec("UPDATE dance_network_day SET end_ms=0 WHERE id=1");
      const deletion = vi
        .spyOn(state.storage, "deleteAll")
        .mockRejectedValueOnce(new Error("deletion unavailable"));
      const before = Date.now();
      try {
        await expect(instance.alarm()).rejects.toThrow("deletion unavailable");
        expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 60_000);
        expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 60_000);
        expect(
          state.storage.sql.exec("SELECT count(*) AS n FROM dance_network_commands").toArray(),
        ).toEqual([{ n: 1 }]);
      } finally {
        deletion.mockRestore();
      }
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
          .toArray(),
      ).toEqual([]);
    });
  });
  it("cleans scheduler-only metadata after a boundary refusal or rolled-back write", async () => {
    const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(bucket());
    await runInDurableObject(stub, async (instance: DanceNetworkRateLimiterDO, state) => {
      await state.storage.setAlarm(Date.now() + DANCE_NETWORK_DAY_MS);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
          .toArray(),
      ).toEqual([]);
    });
  });
  it("a failed first alarm leaves no command or bucket metadata", async () => {
    const bucketName = bucket();
    const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(bucketName);
    await runInDurableObject(stub, async (instance: DanceNetworkRateLimiterDO, state) => {
      const scheduling = vi
        .spyOn(state.storage, "setAlarm")
        .mockRejectedValueOnce(new Error("alarm unavailable"));
      try {
        await expect(instance.admit({ bucketName, commandDigest: digest(1) })).rejects.toThrow(
          "alarm unavailable",
        );
        expect(
          state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
            .toArray(),
        ).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        scheduling.mockRestore();
      }
    });
    expect(await stub.admit({ bucketName, commandDigest: digest(1) })).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });
  it("serializes concurrent reservations, deduplicates retries and bounds stored rows", async () => {
    const bucketName = bucket();
    const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(bucketName);
    const results = await Promise.all(
      Array.from({ length: 130 }, (_, n) => stub.admit({ bucketName, commandDigest: digest(n) })),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(120);
    expect(results.filter((result) => !result.allowed)).toHaveLength(10);
    const admitted = results.findIndex((result) => result.allowed);
    expect(await stub.admit({ bucketName, commandDigest: digest(admitted) })).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT count(*) AS n FROM dance_network_commands").toArray(),
      ).toEqual([{ n: 120 }]);
      expect(await state.storage.getAlarm()).toBe(
        (Math.floor(Date.now() / DANCE_NETWORK_DAY_MS) + 1) * DANCE_NETWORK_DAY_MS,
      );
    });
  });

  it("refuses wrong object identity, expired days and malformed commands before creating metadata", async () => {
    for (const mode of ["wrong-id", "expired", "future", "malformed"] as const) {
      const day = Math.floor(Date.now() / DANCE_NETWORK_DAY_MS);
      const bucketName = bucket(mode === "expired" ? day - 1 : mode === "future" ? day + 1 : day);
      const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(
        mode === "wrong-id" ? bucket() : bucketName,
      );
      await expect(
        Promise.resolve(
          stub.admit({
            bucketName,
            commandDigest: mode === "malformed" ? "raw-command" : digest(1),
          }),
        ),
      ).rejects.toThrow();
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
            .toArray(),
        ).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
      });
    }
  });

  it("rearms an early alarm and erases the complete expired application store", async () => {
    const bucketName = bucket();
    const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(bucketName);
    await stub.admit({ bucketName, commandDigest: digest(1) });
    await runInDurableObject(stub, async (instance: DanceNetworkRateLimiterDO, state) => {
      const end = await state.storage.getAlarm();
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(end);
      expect(
        state.storage.sql.exec("SELECT count(*) AS n FROM dance_network_commands").toArray(),
      ).toEqual([{ n: 1 }]);
      state.storage.sql.exec("UPDATE dance_network_day SET end_ms=0 WHERE id=1");
      await instance.alarm();
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
          .toArray(),
      ).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("an expired RPC cleans retained rows and cannot reopen an erased old-day object", async () => {
    const bucketName = bucket(Math.floor(Date.now() / DANCE_NETWORK_DAY_MS) - 1);
    const stub = env.DANCE_NETWORK_RATE_LIMITER.getByName(bucketName);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE dance_network_day(id INTEGER PRIMARY KEY, end_ms INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO dance_network_day VALUES(1,0)");
      state.storage.sql.exec("CREATE TABLE dance_network_commands(digest TEXT PRIMARY KEY)");
      state.storage.sql.exec("INSERT INTO dance_network_commands VALUES(?)", digest(1));
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        Promise.resolve(stub.admit({ bucketName, commandDigest: digest(2) })),
      ).rejects.toThrow("Expired Dance network bucket");
      await runInDurableObject(stub, async (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
            .toArray(),
        ).toEqual([]);
      });
    }
  });
});
