import { expect, test } from "bun:test";
import { rehearseRunLease } from "./lease-rehearsal.mjs";
import { holdRunLease } from "./run-lease.mjs";

const timing = { ttlSeconds: 180, renewEveryMs: 40_000, maxSeconds: 4_800 };

type Faults = {
  runtimeCanAcquire?: boolean;
  jobsNeverPause?: boolean;
  owed?: boolean;
  /** The database grants authority whenever the brake is running, lease or no lease. */
  authorityIgnoresLease?: boolean;
  /** Where in its minute the jobs Worker's schedule falls. */
  cronPhaseMs?: number;
  /** The holder's timer never fires, so nothing renews. */
  heartbeatNeverFires?: boolean;
  /** The jobs flag is turned on but the answer is lost. */
  enableAnswerLost?: boolean;
  /** How many times turning the flags off fails without changing anything. */
  disableFailures?: number;
  /** Turning the flags off takes effect but its answer is lost. */
  disableAnswerLost?: boolean;
};

/**
 * A small model of the isolated database, the two Worker flags, the jobs Worker
 * and a killable runner. Time moves only when the rehearsal sleeps; timers are
 * the model's own, so the real heartbeat in `holdRunLease` is what renews.
 */
function world(faults: Faults = {}) {
  let clock = 0;
  let paused = true;
  let revision = 10;
  let reason = "start";
  let fence = 0;
  let runId: string | null = null;
  let expiresAt = 0;
  let disableFailures = faults.disableFailures ?? 0;
  const flags = { http: "false", jobs: "false" };
  const timers = new Set<{ callback: () => void; every: number; next: number }>();
  const log: string[] = [];
  const live = () => runId !== null && clock < expiresAt;
  const leaseClock = {
    elapsed: () => clock,
    setTimer: (callback: () => void, every: number) => {
      const timer = { callback, every, next: clock + every };
      if (!faults.heartbeatNeverFires) timers.add(timer);
      return timer;
    },
    clearTimer: (timer: { callback: () => void; every: number; next: number }) => {
      timers.delete(timer);
    },
  };
  // The jobs Worker runs its rewards cycle once a minute, and only while its flag is on.
  const jobsCycle = () => {
    if (faults.jobsNeverPause || flags.jobs !== "true") return;
    if ((clock + (faults.cronPhaseMs ?? 0)) % 60_000 !== 0) return;
    if (!paused && !live()) {
      paused = true;
      revision += 1;
      reason = "reward_run_lease_expired";
      log.push("jobs-pause");
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
      if (text.includes("require_reward_run_authority_v1")) {
        if (faults.authorityIgnoresLease) return paused ? "PR001" : null;
        return !paused && live() ? null : "PR001";
      }
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
        log.push(`renew:${id}`);
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
    state: () => ({ paused, flags: { ...flags }, live: live(), reason }),
    run: () =>
      rehearseRunLease({
        db,
        runIdPrefix: "rehearsal-1",
        timing,
        leaseClock,
        now: () => clock,
        sleep: async (ms: number) => {
          for (let passed = 0; passed < ms; passed += 5_000) {
            clock += 5_000;
            for (const timer of [...timers]) {
              if (clock < timer.next) continue;
              timer.next += timer.every;
              timer.callback();
            }
            // Let a renewal the timer started finish before time moves again.
            await new Promise((done) => setImmediate(done));
            jobsCycle();
          }
        },
        flags: {
          read: async () => ({ ...flags }),
          enableJobs: async () => {
            flags.jobs = "true";
            log.push("jobs-flag-on");
            if (faults.enableAnswerLost) throw new Error("Isolated flag outcome uncertain");
          },
          disableAll: async () => {
            log.push("flags-off-asked");
            if (disableFailures > 0) {
              disableFailures -= 1;
              throw new Error("refused");
            }
            flags.http = "false";
            flags.jobs = "false";
            if (faults.disableAnswerLost) throw new Error("Isolated flag outcome uncertain");
            return { flagsOff: true };
          },
        },
        readShutdownInventory: async () => ({ owed: faults.owed ? "1" : "0" }),
        assertShutdownInventory: (inventory: { owed: string }) => {
          if (inventory.owed !== "0") throw new Error("Rewards shutdown refused: owed");
        },
        // A second runner, with its own real heartbeat, that can be lost.
        spawnHolder: async (id: string) => {
          const mine = new Set<object>();
          await holdRunLease({
            lease: db.lease,
            runId: id,
            timing,
            elapsed: leaseClock.elapsed,
            setTimer: (callback: () => void, every: number) => {
              const timer = leaseClock.setTimer(callback, every);
              mine.add(timer);
              return timer;
            },
            clearTimer: leaseClock.clearTimer,
          });
          await db.control(false, String(revision), `holder ${id}`);
          log.push("holder-spawned");
          let alive = true;
          return {
            kill: async () => {
              if (alive) log.push("holder-killed");
              alive = false;
              // A killed process renews nothing and tells nobody.
              for (const timer of mine) timers.delete(timer as never);
            },
          };
        },
        record: (entry: Record<string, unknown>) => records.push(entry),
      }),
  };
}

const failedNames = (result: { findings: Array<{ name: string; ok: boolean }> }) =>
  result.findings.filter((finding) => !finding.ok).map((finding) => finding.name);
const expiryAlone = "authority is refused on lease expiry alone, with the brake still running";

test("a clean rehearsal passes every finding and ends paused with flags off", async () => {
  const w = world();
  const result = await w.run();
  expect(result.findings.filter((finding) => !finding.ok)).toEqual([]);
  expect(result.passed).toBe(true);
  expect(w.state()).toMatchObject({
    paused: true,
    flags: { http: "false", jobs: "false" },
    live: false,
    reason: "reward_run_lease_expired",
  });
  // The held lease was kept live by the real heartbeat, four renewals in 195 seconds.
  expect(w.log.filter((entry) => entry === "renew:rehearsal-1-held")).toHaveLength(4);
  expect(
    result.findings.find((finding) => finding.name === "the heartbeat renewed the lease"),
  ).toMatchObject({ ok: true, detail: { renewals: 4, fenceAtAcquire: "1", fenceNow: "5" } });
  // Expiry is observed, with the brake running, before the jobs flag is ever turned on.
  expect(result.findings.find((finding) => finding.name === expiryAlone)).toMatchObject({
    ok: true,
    detail: { refusal: "PR001", brakePausedBefore: false, brakePausedAfter: false },
  });
  const order = w.log.filter((entry) => !entry.startsWith("renew:"));
  expect(order).toEqual([
    "resume",
    "pause",
    "resume",
    "holder-spawned",
    "holder-killed",
    "jobs-flag-on",
    "jobs-pause",
    "flags-off-asked",
  ]);
});

test("a database that ignores lease expiry fails whatever the jobs schedule", async () => {
  for (let cronPhaseMs = 0; cronPhaseMs < 60_000; cronPhaseMs += 5_000) {
    const w = world({ authorityIgnoresLease: true, cronPhaseMs });
    const result = await w.run();
    expect(result.passed).toBe(false);
    expect(failedNames(result)).toContain(expiryAlone);
    expect(result.findings.find((finding) => finding.name === expiryAlone)).toMatchObject({
      detail: { refusal: null, brakePausedBefore: false },
    });
    expect(w.state()).toMatchObject({ paused: true, flags: { http: "false", jobs: "false" } });
  }
});

test("a correct database passes whatever the jobs schedule", async () => {
  for (let cronPhaseMs = 0; cronPhaseMs < 60_000; cronPhaseMs += 5_000) {
    const result = await world({ cronPhaseMs }).run();
    expect(failedNames(result)).toEqual([]);
  }
});

test("a heartbeat that never fires fails the rehearsal instead of passing on the first grant", async () => {
  const w = world({ heartbeatNeverFires: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(w.log.some((entry) => entry.startsWith("renew:"))).toBe(false);
  expect(w.state()).toMatchObject({ paused: true, flags: { http: "false", jobs: "false" } });
});

test("a runtime role that can hold a lease fails the rehearsal", async () => {
  const w = world({ runtimeCanAcquire: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(failedNames(result)).toContain("runtime cannot acquire");
  expect(w.state()).toMatchObject({ paused: true, flags: { http: "false", jobs: "false" } });
});

test("a jobs Worker that never pauses fails the rehearsal, which then pauses the brake itself", async () => {
  const w = world({ jobsNeverPause: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(failedNames(result)).toEqual([
    "the jobs Worker paused the brake after expiry",
    "closeout had to pause the brake itself",
  ]);
  expect(w.state()).toMatchObject({ paused: true, flags: { http: "false", jobs: "false" } });
});

test("a flag turned on with its answer lost is still turned off and read back", async () => {
  const w = world({ enableAnswerLost: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(failedNames(result)).toContain("rehearsal completed its steps");
  expect(
    result.findings.find((finding) => finding.name === "both flags read back off at closeout"),
  ).toMatchObject({ ok: true, detail: { http: "false", jobs: "false" } });
  expect(w.state()).toMatchObject({ paused: true, flags: { http: "false", jobs: "false" } });
});

test("turning the flags off is asked again after a failure and believed only from a read", async () => {
  const once = world({ disableFailures: 1 });
  expect((await once.run()).passed).toBe(true);
  expect(once.log.filter((entry) => entry === "flags-off-asked")).toHaveLength(2);
  expect(once.state().flags).toEqual({ http: "false", jobs: "false" });

  const lost = world({ disableAnswerLost: true });
  expect((await lost.run()).passed).toBe(true);
  expect(lost.log.filter((entry) => entry === "flags-off-asked")).toHaveLength(1);

  const never = world({ disableFailures: 9 });
  const result = await never.run();
  expect(result.passed).toBe(false);
  expect(
    result.findings.find((finding) => finding.name === "both flags read back off at closeout"),
  ).toMatchObject({ ok: false, detail: { http: "false", jobs: "true" } });
  expect(never.state()).toMatchObject({ paused: true, flags: { jobs: "true" } });
});

test("a stack that owes something is refused before anything is changed", async () => {
  const w = world({ owed: true });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(w.log).toEqual([]);
  expect(w.state()).toMatchObject({ paused: true, flags: { http: "false", jobs: "false" } });
});
