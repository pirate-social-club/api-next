/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as testEnv } from "cloudflare:test";

import { CRON_LOCK_NAME, type ScheduledCronLockDO } from "@pirate/platform-cf";
import { describe, expect, it } from "vitest";

const env = testEnv as unknown as { CRON_LOCK: DurableObjectNamespace<ScheduledCronLockDO> };

// The lease is keyed per lane: one deterministic DO instance per lane name.
const stub = () => env.CRON_LOCK.getByName(`${CRON_LOCK_NAME}:spike`);

describe("ScheduledCronLockDO lease semantics (workerd)", () => {
  it("acquires when free, denies a second owner, releases fenced", async () => {
    const s = stub();
    expect(await s.tryAcquire(60_000, "owner-a", 1_000)).toBe(true);
    expect(await s.tryAcquire(60_000, "owner-b", 1_500)).toBe(false);

    // Release by the WRONG owner must not free the lease.
    await s.release("owner-b");
    expect(await s.tryAcquire(60_000, "owner-c", 2_000)).toBe(false);

    // Owner-fenced release by the holder does free it.
    await s.release("owner-a");
    expect(await s.tryAcquire(60_000, "owner-c", 3_000)).toBe(true);
    await s.release("owner-c");
  });

  it("renews for the same owner and expires by timestamp", async () => {
    const s = stub();
    expect(await s.tryAcquire(5_000, "owner-a", 10_000)).toBe(true);
    // Same owner reacquires (renewal) with a fresh expiry.
    expect(await s.tryAcquire(5_000, "owner-a", 12_000)).toBe(true);
    expect(await s.tryAcquire(5_000, "owner-b", 14_000)).toBe(false);
    // At now >= 17_000 the lease (expiresAt 17_000) is expired: takeover.
    expect(await s.tryAcquire(5_000, "owner-b", 17_000)).toBe(true);
    const lease = await s.currentLease();
    expect(lease?.owner).toBe("owner-b");
    await s.release("owner-b");
  });
});
