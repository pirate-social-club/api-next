import { expect, test } from "bun:test";
import { holdRunLease } from "./run-lease.mjs";

const timing = { ttlSeconds: 180, renewEveryMs: 40_000, maxSeconds: 4_800 };
const refused = (code = "PR003") => Object.assign(new Error("refused"), { code });

function world(overrides: Record<string, unknown> = {}) {
  let clock = 1_000_000;
  let tick: (() => void) | null = null;
  const calls: string[] = [];
  const events: Array<{ kind: string }> = [];
  let fence = 7;
  const lease = {
    acquire: async (runId: string, ttl: number, max: number) => {
      calls.push(`acquire:${runId}:${ttl}:${max}`);
      return String(fence);
    },
    renew: async (runId: string, held: string, ttl: number) => {
      calls.push(`renew:${runId}:${held}:${ttl}`);
      fence += 1;
      return String(fence);
    },
    release: async (runId: string, held: string) => {
      calls.push(`release:${runId}:${held}`);
    },
    ...overrides,
  };
  return {
    calls,
    events,
    lease,
    advance: (ms: number) => {
      clock += ms;
    },
    /** One firing of the heartbeat timer, with its renewal awaited. */
    beat: async () => {
      tick?.();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    cleared: () => tick === null,
    hold: (runId = "win-1") =>
      holdRunLease({
        lease,
        runId,
        timing,
        now: () => clock,
        elapsed: () => clock,
        setTimer: (callback: () => void) => {
          tick = callback;
          return 1;
        },
        clearTimer: () => {
          tick = null;
        },
        onEvent: (event: { kind: string }) => events.push(event),
      }),
  };
}

test("the lease is acquired with the bounded durations and renewed with the current fence", async () => {
  const w = world();
  const held = await w.hold();
  expect(w.calls).toEqual(["acquire:win-1:180:4800"]);
  held.assertHeld();
  w.advance(40_000);
  await w.beat();
  w.advance(40_000);
  await w.beat();
  // Each renewal presents the fence the previous one returned.
  expect(w.calls.slice(1)).toEqual(["renew:win-1:7:180", "renew:win-1:8:180"]);
  expect(held.state()).toMatchObject({ fence: "9", renewals: 2, lost: null, released: false });
  held.assertHeld();
});

test("a run identifier the database would refuse is refused before anything is asked", async () => {
  const w = world();
  await expect(w.hold("Bad Run")).rejects.toThrow("identifier refused");
  expect(w.calls).toEqual([]);
});

test("a refused renewal loses the lease for good and stops the heartbeat", async () => {
  const w = world({
    renew: async () => {
      throw refused();
    },
  });
  const held = await w.hold();
  w.advance(40_000);
  await w.beat();
  expect(() => held.assertHeld()).toThrow("Run lease lost: renewal refused by the database");
  expect(w.cleared()).toBe(true);
  expect(w.events.map((event) => event.kind)).toEqual(["acquired", "lost"]);
  // Nothing renews a lost lease, however often it is asked.
  await held.renewNow();
  expect(() => held.assertHeld()).toThrow("Run lease lost");
});

test("a renewal that could not be asked is tried again and is not a loss while the lease lasts", async () => {
  let fail = true;
  let fence = 7;
  const w = world({
    renew: async () => {
      if (fail) throw new Error("connection reset");
      fence += 1;
      return String(fence);
    },
  });
  const held = await w.hold();
  w.advance(40_000);
  await w.beat();
  w.advance(40_000);
  await w.beat();
  held.assertHeld();
  expect(w.events.map((event) => event.kind)).toEqual([
    "acquired",
    "renewal-unanswered",
    "renewal-unanswered",
  ]);
  fail = false;
  w.advance(40_000);
  await w.beat();
  held.assertHeld();
  expect(held.state()).toMatchObject({ renewals: 1, lost: null });
});

test("a lease that cannot be renewed in time is treated as lost when it runs out", async () => {
  const w = world({
    renew: async () => {
      throw new Error("connection reset");
    },
  });
  const held = await w.hold();
  for (let beats = 0; beats < 4; beats++) {
    w.advance(40_000);
    await w.beat();
  }
  held.assertHeld();
  // 180 seconds after acquisition with no renewal, the database has let it expire.
  w.advance(21_000);
  await w.beat();
  expect(() => held.assertHeld()).toThrow("Run lease lost: lease expired");
  expect(w.cleared()).toBe(true);
});

test("a heartbeat that never fires still cannot let an expired lease be used", async () => {
  const w = world();
  const held = await w.hold();
  // A stalled process: no timer fired for the whole time to live.
  w.advance(180_000);
  expect(() => held.assertHeld()).toThrow(
    "Run lease lost: lease expired before it could be renewed",
  );
});

test("the local expiry is never later than the absolute deadline", async () => {
  const w = world();
  const short = { ...timing, maxSeconds: 200 };
  let clock = 0;
  const held = await holdRunLease({
    lease: w.lease,
    runId: "win-1",
    timing: short,
    now: () => clock,
    elapsed: () => clock,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  clock = 100_000;
  await held.renewNow();
  expect(held.state().expiresAt).toBe(held.state().absoluteDeadline);
  clock = 200_000;
  expect(() => held.assertHeld()).toThrow("Run lease lost");
});

test("release stops the heartbeat, uses the current fence, and is harmless when repeated", async () => {
  const w = world();
  const held = await w.hold();
  w.advance(40_000);
  await w.beat();
  expect(await held.release()).toEqual({ released: true });
  expect(w.calls.at(-1)).toBe("release:win-1:8");
  expect(w.cleared()).toBe(true);
  expect(await held.release()).toEqual({ released: true, repeated: true });
  expect(w.calls.filter((call) => call.startsWith("release:"))).toHaveLength(1);
  expect(() => held.assertHeld()).toThrow("already released");
});

test("a refused release is reported and never retried into a renewal", async () => {
  const w = world({
    release: async () => {
      throw refused();
    },
  });
  const held = await w.hold();
  expect(await held.release()).toEqual({ released: false, refused: true });
  expect(w.calls.some((call) => call.startsWith("renew:"))).toBe(false);
  expect(w.events.at(-1)?.kind).toBe("release-refused");
});

test("overlapping heartbeats share one renewal", async () => {
  let inFlight = 0;
  let most = 0;
  let fence = 7;
  const w = world({
    renew: async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      fence += 1;
      return String(fence);
    },
  });
  const held = await w.hold();
  await Promise.all([held.renewNow(), held.renewNow(), held.renewNow()]);
  expect(most).toBe(1);
  expect(held.state().renewals).toBe(1);
});

test("setting the wall clock back cannot keep an expired lease in use", async () => {
  const w = world({
    renew: async () => {
      throw new Error("connection reset");
    },
  });
  let wall = Date.parse("2026-10-06T12:00:00.000Z");
  let monotonic = 5_000;
  const held = await holdRunLease({
    lease: w.lease,
    runId: "win-1",
    timing,
    now: () => wall,
    elapsed: () => monotonic,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  held.assertHeld();
  // 179 seconds pass: still inside the time to live.
  monotonic += 179_000;
  wall += 179_000;
  held.assertHeld();
  // Two more seconds pass while the wall clock is set back an hour.
  monotonic += 2_000;
  wall -= 3_600_000;
  expect(() => held.assertHeld()).toThrow("Run lease lost: lease expired");
});

test("setting the wall clock forward does not lose a lease that is still live", async () => {
  const w = world();
  let wall = Date.parse("2026-10-06T12:00:00.000Z");
  let monotonic = 5_000;
  const held = await holdRunLease({
    lease: w.lease,
    runId: "win-1",
    timing,
    now: () => wall,
    elapsed: () => monotonic,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  monotonic += 60_000;
  wall += 86_400_000;
  held.assertHeld();
  // Evidence timestamps are placed from the monotonic interval, not the jumped clock.
  expect(held.state().expiresAt).toBe("2026-10-06T12:03:00.000Z");
});

test("the absolute cap is measured on the monotonic clock too", async () => {
  const w = world();
  let wall = Date.parse("2026-10-06T12:00:00.000Z");
  let monotonic = 0;
  const held = await holdRunLease({
    lease: w.lease,
    runId: "win-1",
    timing: { ...timing, maxSeconds: 200 },
    now: () => wall,
    elapsed: () => monotonic,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  monotonic = 100_000;
  await held.renewNow();
  // Renewed for 180 seconds, but capped 200 seconds after acquisition.
  monotonic = 199_000;
  wall -= 7_200_000;
  held.assertHeld();
  monotonic = 200_000;
  expect(() => held.assertHeld()).toThrow("Run lease lost");
});
