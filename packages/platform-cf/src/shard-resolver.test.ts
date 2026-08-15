import { describe, expect, test } from "bun:test";
import { queueRetryBackoffSeconds, queueRetryDelaySeconds } from "./queue-retry";
import {
  BindingPending,
  CommunityBindingResolver,
  CommunityDecommissioned,
  CommunityNotRouted,
  type CommunityRoutingRow,
} from "./shard-resolver";

// Invariants carried from the old community-binding-resolver.smoke.test.ts,
// exercised against an injected routing-row reader (the SQL directory read
// lives in the adapter that owns I/O).

const NOW_BASE = 1_700_000_000_000;

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = NOW_BASE;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function row(overrides: Partial<CommunityRoutingRow> = {}): CommunityRoutingRow {
  return {
    community_id: "cmty_synthetic_0001",
    provisioning_state: "ready",
    shard_worker_id: "community-shard-001",
    binding_name: "DB_CMTY_SYNTHETIC_0001",
    region: "enam",
    decommissioned_at: null,
    ...overrides,
  };
}

function directory(initial: CommunityRoutingRow | null) {
  let current = initial;
  let reads = 0;
  return {
    set(next: CommunityRoutingRow | null) {
      current = next;
    },
    reads: () => reads,
    read: async (_communityId: string) => {
      reads += 1;
      return current;
    },
  };
}

describe("CommunityBindingResolver", () => {
  test("routing entries are cached for the 60s TTL, then re-read", async () => {
    const clock = makeClock();
    const resolver = new CommunityBindingResolver({ now: clock.now });
    const dir = directory(row());

    expect((await resolver.resolve(dir.read, "cmty_synthetic_0001")).region).toBe("enam");
    dir.set(row({ region: "weur" }));

    clock.advance(59_000);
    expect((await resolver.resolve(dir.read, "cmty_synthetic_0001")).region).toBe("enam");
    clock.advance(2_000);
    expect((await resolver.resolve(dir.read, "cmty_synthetic_0001")).region).toBe("weur");
  });

  test("degraded rows are still routable but use the shorter 5s TTL", async () => {
    const clock = makeClock();
    const resolver = new CommunityBindingResolver({ now: clock.now });
    const dir = directory(row({ provisioning_state: "degraded" }));

    const first = await resolver.resolve(dir.read, "cmty_synthetic_0001");
    expect(first.provisioningState).toBe("degraded");
    expect(first.region).toBe("enam");
    dir.set(row({ provisioning_state: "degraded", region: "weur" }));

    clock.advance(4_000);
    expect((await resolver.resolve(dir.read, "cmty_synthetic_0001")).region).toBe("enam");
    clock.advance(2_000);
    expect((await resolver.resolve(dir.read, "cmty_synthetic_0001")).region).toBe("weur");
  });

  test("decommissioned communities fail closed and are cached on the short TTL", async () => {
    const clock = makeClock();
    const resolver = new CommunityBindingResolver({ now: clock.now });
    const dir = directory(
      row({
        provisioning_state: "decommissioned",
        decommissioned_at: "t0",
        shard_worker_id: null,
        binding_name: null,
      }),
    );

    await expect(resolver.resolve(dir.read, "cmty_synthetic_0001")).rejects.toBeInstanceOf(
      CommunityDecommissioned,
    );
    expect(dir.reads()).toBe(1);

    clock.advance(4_000);
    await expect(resolver.resolve(dir.read, "cmty_synthetic_0001")).rejects.toBeInstanceOf(
      CommunityDecommissioned,
    );
    expect(dir.reads()).toBe(1);

    clock.advance(2_000);
    await expect(resolver.resolve(dir.read, "cmty_synthetic_0001")).rejects.toBeInstanceOf(
      CommunityDecommissioned,
    );
    expect(dir.reads()).toBe(2);
  });

  test("a provisioning row throws retryable binding_pending and is not cached", async () => {
    const clock = makeClock();
    const resolver = new CommunityBindingResolver({ now: clock.now });
    const dir = directory(row({ provisioning_state: "provisioning" }));

    const failure = await resolver.resolve(dir.read, "cmty_synthetic_0001").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BindingPending);
    expect((failure as BindingPending).retryable).toBe(true);

    // The deploy completes; because the throw was not cached, the next
    // resolve sees 'ready' immediately (no TTL to wait out).
    dir.set(row());
    expect((await resolver.resolve(dir.read, "cmty_synthetic_0001")).provisioningState).toBe(
      "ready",
    );
  });

  test("an unknown community throws CommunityNotRouted", async () => {
    const resolver = new CommunityBindingResolver();
    const dir = directory(null);
    await expect(resolver.resolve(dir.read, "cmty_missing")).rejects.toBeInstanceOf(
      CommunityNotRouted,
    );
  });

  test("invalidate drops the cached entry so a routing change is observed", async () => {
    const clock = makeClock();
    const resolver = new CommunityBindingResolver({ now: clock.now });
    const dir = directory(row());
    await resolver.resolve(dir.read, "cmty_synthetic_0001");
    dir.set(row({ provisioning_state: "decommissioned", decommissioned_at: "t2" }));
    resolver.invalidate("cmty_synthetic_0001");
    await expect(resolver.resolve(dir.read, "cmty_synthetic_0001")).rejects.toBeInstanceOf(
      CommunityDecommissioned,
    );
  });
});

describe("queue retry policy", () => {
  test("matches the old consumers' deterministic backoff (5s base, x2, 300s cap, exponent<=6)", () => {
    // Both old copies computed these exact values.
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(queueRetryBackoffSeconds)).toEqual([
      5, 10, 20, 40, 80, 160, 300, 300, 300,
    ]);
    expect(queueRetryBackoffSeconds(0)).toBe(5);
    expect(queueRetryBackoffSeconds(-3)).toBe(5);
  });

  test("jitters within [backoff/2, backoff] and never below the 5s floor", () => {
    expect(queueRetryDelaySeconds(5, () => 0)).toBe(40);
    expect(queueRetryDelaySeconds(5, () => 1)).toBe(80);
    expect(queueRetryDelaySeconds(5, () => 0.5)).toBe(60);
    expect(queueRetryDelaySeconds(1, () => 0)).toBe(5);
    expect(queueRetryDelaySeconds(20, () => 1)).toBe(300);
  });
});
