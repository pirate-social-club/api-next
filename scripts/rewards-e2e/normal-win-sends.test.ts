import { expect, test } from "bun:test";
import { completeNormalWin, passiveSettlementClock } from "./normal-win-sends.mjs";

test("normal wins claim and settle both credits before replacing the run lease with capped onward completion", async () => {
  const calls: string[] = [];
  const result = await completeNormalWin({
    run: { runId: "win-1", deadline: Date.now() + 1000 },
    legId: "leg-1",
    host: { pages: { study: {}, karaoke: {} } },
    allocated: {},
    driver: {},
    db: {
      read: async () => [{ paused: false, revision: "10" }],
      control: async (paused: boolean, revision: string) => {
        expect(paused).toBe(true);
        expect(revision).toBe("10");
        calls.push("pause");
      },
    },
    lease: {
      release: async () => {
        calls.push("release");
        return { released: true };
      },
      state: () => ({ lost: null }),
    },
    check: async () => {
      calls.push("authority");
    },
    record: () => {},
    claim: async (_page: unknown, role: string) => {
      calls.push(`claim:${role}`);
    },
    wait: async () => {
      calls.push("server-zero");
    },
    finish: async (input: { pinned: { runId: string }; clearLock: () => void }) => {
      expect(input.pinned.runId).toBe("win-1");
      calls.push("onward");
      input.clearLock();
      return {
        runId: "win-1",
        legId: "leg-1",
        errors: [],
        sends: [],
        passed: true,
        brake: { paused: true, revision: "12" },
      };
    },
  });
  expect(result.passed).toBe(true);
  expect(calls).toEqual([
    "claim:study",
    "claim:karaoke",
    "server-zero",
    "authority",
    "pause",
    "release",
    "onward",
  ]);
});

test("a failed original lease release prevents a second signing phase", async () => {
  let finished = false;
  await expect(
    completeNormalWin({
      run: { runId: "win-1", deadline: Date.now() + 1000 },
      legId: "leg-1",
      host: { pages: { study: {}, karaoke: {} } },
      allocated: {},
      driver: {},
      db: { read: async () => [{ paused: false, revision: "10" }], control: async () => {} },
      lease: { release: async () => ({ released: false }), state: () => ({ lost: null }) },
      check: async () => {},
      record: () => {},
      claim: async () => {},
      wait: async () => {},
      finish: async () => {
        finished = true;
        return { runId: "win-1", legId: "leg-1", errors: [], sends: [], passed: true };
      },
    }),
  ).rejects.toThrow("release not verified");
  expect(finished).toBe(false);
});

test("post-finality settlement evidence cannot continue if authority has been reacquired", async () => {
  let live = false;
  const clock = passiveSettlementClock(
    {
      read: async (sql: string) =>
        sql.includes("run_lease") ? [{ live }] : [{ paused: true, revision: "12" }],
    },
    { paused: true, revision: "12" },
  );
  await clock.check();
  live = true;
  await expect(clock.check()).rejects.toThrow("no live lease");
});
