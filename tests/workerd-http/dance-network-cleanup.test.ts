/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runInDurableObject, env as testEnv } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DanceNetworkRateLimiterDO } from "../../packages/platform-cf/src/dance-network-admission-do.ts";
import { DANCE_NETWORK_DAY_MS } from "../../packages/platform-cf/src/dance-network-admission-model.ts";
import {
  DANCE_NETWORK_CLEANUP_COORDINATOR,
  danceNetworkRegistryName,
} from "../../packages/platform-cf/src/dance-network-cleanup.ts";

const env = testEnv as unknown as {
  DANCE_NETWORK_RATE_LIMITER: DurableObjectNamespace<DanceNetworkRateLimiterDO>;
};
const namespace = env.DANCE_NETWORK_RATE_LIMITER;
const coordinator = () => namespace.getByName(DANCE_NETWORK_CLEANUP_COORDINATOR);
const day = () => Math.floor(Date.now() / DANCE_NETWORK_DAY_MS);
const bucket = (d = day(), n = 1) => `dance-network-v1:${d}:${n.toString(16).padStart(64, "0")}`;
const commandDigest = "a".repeat(64);
const DANCE_NETWORK_REGISTRY_LIMIT = 1024;
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  // Reset only the bindings attached to this isolated Workerd pool.
  await reset();
});

it("midnight during alarm establishment cannot recreate erased counters", async () => {
  const d = day(),
    name = bucket(d),
    stub = namespace.getByName(name);
  await coordinator().maintain();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await runInDurableObject(stub, async (instance, state) => {
    const setAlarm = state.storage.setAlarm.bind(state.storage);
    const scheduling = vi
      .spyOn(state.storage, "setAlarm")
      .mockImplementationOnce(async (...args) => {
        await setAlarm(...args);
        clock.mockReturnValue((d + 1) * DANCE_NETWORK_DAY_MS + 1);
      });
    try {
      await expect(
        Promise.resolve(instance.admit({ bucketName: name, commandDigest })),
      ).rejects.toThrow("Expired Dance network bucket");
      expect(await state.storage.getAlarm()).toBeNull();
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%'")
          .toArray(),
      ).toEqual([]);
    } finally {
      scheduling.mockRestore();
    }
  });
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 0, remaining: 0 });
});
async function tables(stub: DurableObjectStub<DanceNetworkRateLimiterDO>) {
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name LIKE 'dance_network_%' ORDER BY name")
      .toArray(),
  );
}

it("bootstrap maintenance is independent of intake; stale coverage writes no bucket data", async () => {
  const name = bucket(),
    stub = namespace.getByName(name);
  await expect(Promise.resolve(stub.admit({ bucketName: name, commandDigest }))).rejects.toThrow(
    "coverage unavailable",
  );
  expect(await tables(stub)).toEqual([]);
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 0 });
  expect(await stub.admit({ bucketName: name, commandDigest })).toMatchObject({ allowed: true });
  await runInDurableObject(coordinator(), async (_instance, state) => {
    state.storage.sql.exec("UPDATE dance_network_maintenance SET observed_at=0");
  });
  const other = bucket(day(), 2);
  await expect(
    Promise.resolve(namespace.getByName(other).admit({ bucketName: other, commandDigest })),
  ).rejects.toThrow("coverage unavailable");
  expect(await tables(namespace.getByName(other))).toEqual([]);
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 1, remaining: 1 });
});

it("role and day fences precede metadata; bucket cleanup cannot erase coordinator or registry", async () => {
  await coordinator().maintain();
  const registry = namespace.getByName(danceNetworkRegistryName(day()));
  await expect(Promise.resolve(registry.registerDay(day()))).rejects.toThrow("identity");
  await expect(Promise.resolve(coordinator().registerBucket(day(), bucket()))).rejects.toThrow(
    "identity",
  );
  await expect(
    Promise.resolve(registry.registerBucket(day() - 1, bucket(day() - 1))),
  ).rejects.toThrow();
  expect(await tables(registry)).toEqual([]);
  await coordinator().registerDay(day());
  await registry.registerBucket(day(), bucket());
  const before = await tables(registry);
  await expect(Promise.resolve(registry.clearBucket(bucket(day() - 1)))).rejects.toThrow(
    "Invalid Dance cleanup bucket",
  );
  await runInDurableObject(registry, async (instance) => {
    await expect(Promise.resolve(instance.alarm())).rejects.toThrow("control object");
  });
  await runInDurableObject(coordinator(), async (instance) => {
    await expect(Promise.resolve(instance.alarm())).rejects.toThrow("control object");
  });
  expect(await tables(registry)).toEqual(before);
});

it("orphan date discovery still drains after multiple missed days without intake freshness", async () => {
  await coordinator().maintain();
  const d = day();
  await coordinator().registerDay(d);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 5 * DANCE_NETWORK_DAY_MS);
  const next = bucket(d + 5);
  await expect(
    Promise.resolve(namespace.getByName(next).admit({ bucketName: next, commandDigest })),
  ).rejects.toThrow("coverage unavailable");
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 0, remaining: 0 });
  expect(await namespace.getByName(next).admit({ bucketName: next, commandDigest })).toMatchObject({
    allowed: true,
  });
});

it("failed registry erasure keeps discovery until a later exact empty-state observation", async () => {
  await coordinator().maintain();
  const d = day(),
    name = bucket(d);
  await namespace.getByName(name).admit({ bucketName: name, commandDigest });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + DANCE_NETWORK_DAY_MS);
  const registry = namespace.getByName(danceNetworkRegistryName(d));
  await runInDurableObject(registry, async (_instance, state) => {
    const deletion = vi
      .spyOn(state.storage, "deleteAll")
      .mockRejectedValueOnce(new Error("fixture registry erasure failure"));
    try {
      expect(await coordinator().maintain()).toMatchObject({
        healthy: false,
        days: 1,
        failures: 1,
      });
    } finally {
      deletion.mockRestore();
    }
  });
  expect(await tables(namespace.getByName(name))).toEqual([]);
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 0, remaining: 0 });
  expect(await tables(registry)).toEqual([]);
});

it("overlapping alarm and cleanup share one erasure and cannot rearm an erased day", async () => {
  await coordinator().maintain();
  const d = day(),
    name = bucket(d),
    stub = namespace.getByName(name);
  await stub.admit({ bucketName: name, commandDigest });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + DANCE_NETWORK_DAY_MS);
  await runInDurableObject(stub, async (instance, state) => {
    const original = state.storage.deleteAll.bind(state.storage);
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const deletion = vi.spyOn(state.storage, "deleteAll").mockImplementationOnce(async () => {
      await wait;
      await original();
    });
    try {
      const alarm = instance.alarm(),
        cleanup = instance.clearBucket(name);
      finish();
      expect((await Promise.all([alarm, cleanup]))[1]).toBe(true);
      expect(deletion).toHaveBeenCalledOnce();
      expect(await state.storage.getAlarm()).toBeNull();
      await expect(instance.admit({ bucketName: name, commandDigest })).rejects.toThrow("Expired");
      expect(await state.storage.getAlarm()).toBeNull();
      expect((await state.storage.list({ limit: 1 })).size).toBe(0);
    } finally {
      deletion.mockRestore();
    }
  });
});

it("registry cap deduplicates first and refuses the next network before its alarm or counter", async () => {
  await coordinator().maintain();
  await coordinator().registerDay(day());
  const d = day(),
    registry = namespace.getByName(danceNetworkRegistryName(d));
  await registry.registerBucket(d, bucket(d, 1));
  await runInDurableObject(registry, async (_instance, state) => {
    state.storage.transactionSync(() => {
      for (let n = 2; n <= DANCE_NETWORK_REGISTRY_LIMIT; n++)
        state.storage.sql.exec("INSERT INTO dance_network_registry VALUES(?)", bucket(d, n));
    });
  });
  await registry.registerBucket(d, bucket(d, 1));
  const name = bucket(d, DANCE_NETWORK_REGISTRY_LIMIT + 1),
    stub = namespace.getByName(name);
  await expect(Promise.resolve(stub.admit({ bucketName: name, commandDigest }))).rejects.toThrow(
    "registry full",
  );
  expect(await tables(stub)).toEqual([]);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("cron drains expired counters with their alarms and erases the daily registry before discovery", async () => {
  const now = Date.now(),
    d = day(),
    name = bucket(d),
    stub = namespace.getByName(name);
  await coordinator().maintain();
  await stub.admit({ bucketName: name, commandDigest });
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 1, remaining: 1 });
  // Keep ordinary bucket alarms idle: this exercises the separate discovery path.
  vi.spyOn(Date, "now").mockReturnValue(now + DANCE_NETWORK_DAY_MS);
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 0, remaining: 0 });
  expect(await tables(stub)).toEqual([]);
  expect(await tables(namespace.getByName(danceNetworkRegistryName(d)))).toEqual([]);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
  });
  await expect(Promise.resolve(stub.admit({ bucketName: name, commandDigest }))).rejects.toThrow(
    "Expired",
  );
  expect(await tables(stub)).toEqual([]);
  const next = bucket(d + 1);
  expect(await namespace.getByName(next).admit({ bucketName: next, commandDigest })).toMatchObject({
    allowed: true,
  });
});

it("one failed deletion does not starve later buckets; an overdue unknown day closes fresh intake", async () => {
  const now = Date.now(),
    d = day(),
    first = bucket(d, 1),
    second = bucket(d, 2);
  await coordinator().maintain();
  await namespace.getByName(first).admit({ bucketName: first, commandDigest });
  await namespace.getByName(second).admit({ bucketName: second, commandDigest });
  vi.spyOn(Date, "now").mockReturnValue(now + 2 * DANCE_NETWORK_DAY_MS);
  await runInDurableObject(namespace.getByName(first), async (_instance, state) => {
    const deletion = vi
      .spyOn(state.storage, "deleteAll")
      .mockRejectedValue(new Error("fixture deletion failure"));
    try {
      expect(await coordinator().maintain()).toMatchObject({
        healthy: false,
        days: 1,
        remaining: 1,
      });
      expect(await tables(namespace.getByName(second))).toEqual([]);
      const next = bucket(d + 2);
      await expect(
        Promise.resolve(namespace.getByName(next).admit({ bucketName: next, commandDigest })),
      ).rejects.toThrow("coverage unavailable");
      expect(await tables(namespace.getByName(next))).toEqual([]);
    } finally {
      deletion.mockRestore();
    }
  });
  expect(await coordinator().maintain()).toMatchObject({ healthy: true, days: 0, remaining: 0 });
});
