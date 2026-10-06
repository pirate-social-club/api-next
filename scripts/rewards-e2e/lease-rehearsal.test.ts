import { expect, test } from "bun:test";
import { rehearseRunLease } from "./lease-rehearsal.mjs";

const timing = { ttlSeconds: 180, renewEveryMs: 40_000, maxSeconds: 4_800 };

/** A small model of the isolated database, the jobs Worker and a killable runner. */
function world(
  faults: { runtimeCanAcquire?: boolean; jobsNeverPause?: boolean; owed?: boolean } = {},
) {
  let clock = 0;
  let paused = true;
  let revision = 10;
  let reason = "start";
  let fence = 0;
  let runId: string | null = null;
  let expiresAt = 0;
  let holderAlive = false;
  let flags = false;
  const log: string[] = [];
  const live = () => runId !== null && clock < expiresAt;
  // The holder renews while it lives; the jobs Worker ticks once a minute.
  const tick = () => {
    if (holderAlive && live()) expiresAt = clock + timing.ttlSeconds * 1000;
    if (!faults.jobsNeverPause && flags && !paused && !live() && clock % 60_000 < 5_000) {
      paused = true;
      revision += 1;
      reason = "reward_run_lease_expired";
    }
  };
  const refuse = (code: string) => Object.assign(new Error(code), { code });
  const db = {
    read: async (text: string) => {
      if (text.includes("reward_operations_run_lease"))
        return [{ run_id: runId, fence: String(fence), live: live() }];
      return [{ paused, revision: String(revision), reason }];
    },
    asRuntime: async (text: string) => {
      if (text.includes("require_reward_run_authority_v1"))
        return !paused && live() ? null : "PR001";
      if (text.includes("acquire_reward_run_lease_v1") && faults.runtimeCanAcquire) return null;
      return "42501";
    },
    control: async (target: boolean, expected: string, why: string) => {
      if (expected !== String(revision)) throw refuse("PR002");
      if (paused !== target) {
        paused = target;
        revision += 1;
        reason = why;
      }
      log.push(target ? "pause" : "resume");
      return { control: { paused, revision: String(revision) } };
    },
    lease: {
      acquire: async (id: string, ttl: number) => {
        if (!paused || live()) throw refuse("PR003");
        runId = id;
        fence += 1;
        expiresAt = clock + ttl * 1000;
        return String(fence);
      },
      renew: async (id: string, held: string, ttl: number) => {
        if (id !== runId || held !== String(fence) || !live()) throw refuse("PR003");
        fence += 1;
        expiresAt = clock + ttl * 1000;
        return String(fence);
      },
      release: async (id: string, held: string) => {
        if (id !== runId || held !== String(fence)) throw refuse("PR003");
        expiresAt = Math.min(expiresAt, clock);
      },
    },
  };
  const records: Array<Record<string, unknown>> = [];
  return {
    log,
    records,
    state: () => ({ paused, flags, live: live(), reason }),
    run: () =>
      rehearseRunLease({
        db,
        runIdPrefix: "rehearsal-1",
        timing,
        now: () => clock,
        sleep: async (ms: number) => {
          // The in-process holder's own heartbeat is modelled by renewing as time passes.
          for (let passed = 0; passed < ms; passed += 5_000) {
            clock += 5_000;
            if (!holderAlive && runId === "rehearsal-1-held" && live() && !paused)
              expiresAt = clock + timing.ttlSeconds * 1000;
            tick();
          }
        },
        enableFlags: async () => {
          flags = true;
          log.push("flags-on");
        },
        disableFlags: async () => {
          flags = false;
          log.push("flags-off");
          return { flagsOff: true };
        },
        readShutdownInventory: async () => ({ owed: faults.owed ? "1" : "0" }),
        assertShutdownInventory: (inventory: { owed: string }) => {
          if (inventory.owed !== "0") throw new Error("Rewards shutdown refused: owed");
        },
        spawnHolder: async (id: string) => {
          await db.lease.acquire(id, timing.ttlSeconds);
          await db.control(false, String(revision), `holder ${id}`);
          holderAlive = true;
          log.push("holder-spawned");
          return {
            kill: async () => {
              if (holderAlive) log.push("holder-killed");
              holderAlive = false;
            },
          };
        },
        record: (entry: Record<string, unknown>) => records.push(entry),
      }),
  };
}

test("a clean rehearsal passes every finding and ends paused with flags off", async () => {
  const w = world();
  const result = await w.run();
  expect(result.findings.filter((finding) => !finding.ok)).toEqual([]);
  expect(result.passed).toBe(true);
  expect(w.state()).toMatchObject({ paused: true, flags: false, live: false });
  expect(w.state().reason).toBe("reward_run_lease_expired");
  // The rehearsal itself resumed once and paused once; the lost runner resumed
  // once and was never paused by anything but the jobs Worker.
  expect(w.log).toEqual([
    "flags-on",
    "resume",
    "pause",
    "resume",
    "holder-spawned",
    "holder-killed",
    "flags-off",
  ]);
  expect(result.findings.map((finding) => finding.name)).toContain(
    "authority is refused after the lease runs out",
  );
});

test("a runtime role that can hold a lease fails the rehearsal", async () => {
  const w = world({ runtimeCanAcquire: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(
    result.findings.find((finding) => finding.name === "runtime cannot acquire"),
  ).toMatchObject({
    ok: false,
  });
  expect(w.state()).toMatchObject({ paused: true, flags: false });
});

test("a jobs Worker that never pauses fails the rehearsal, which then pauses the brake itself", async () => {
  const w = world({ jobsNeverPause: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  const failed = result.findings.filter((finding) => !finding.ok).map((finding) => finding.name);
  expect(failed).toContain("the jobs Worker paused the brake after expiry");
  expect(failed).toContain("closeout had to pause the brake itself");
  // Authority was still refused by the database on its own, before any pause.
  expect(
    result.findings.find(
      (finding) => finding.name === "authority is refused after the lease runs out",
    ),
  ).toMatchObject({ ok: true, detail: { brakePausedWhenFirstRefused: false } });
  expect(w.state()).toMatchObject({ paused: true, flags: false });
});

test("a stack that owes something is refused before anything is enabled", async () => {
  const w = world({ owed: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(w.log).toEqual([]);
  expect(w.state()).toMatchObject({ paused: true, flags: false });
});
