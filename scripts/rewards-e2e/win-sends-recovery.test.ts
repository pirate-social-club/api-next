import { expect, test } from "bun:test";
import {
  assertGasWalletRegistered,
  completeWinnerSends,
  isolatedGasWallet,
} from "./win-sends-recovery.mjs";

const credits = [
  {
    credit_id: "credit-study",
    account_id: "study",
    state: "sent",
    amount_atomic: "500000",
    paid_atomic: "500000",
  },
  {
    credit_id: "credit-karaoke",
    account_id: "karaoke",
    state: "sent",
    amount_atomic: "500000",
    paid_atomic: "500000",
  },
];
const zero = {
  unpaid_credits: "0",
  leg_liabilities: "0",
  sponsor_liabilities: "0",
  open_offers: "0",
  open_legs: "0",
  unresolved_drawings: "0",
  unresolved_funding: "0",
  unresolved_chain_effects: "0",
  unresolved_gas_topups: "0",
};

type Faults = {
  flagsOff?: boolean;
  noGasWallet?: boolean;
  foreignOpen?: string;
  foreignSend?: boolean;
  sendFails?: string;
  /** Only this credit's send fails, before the app records anything for it. */
  failCredit?: string;
  karaokeAlreadyConfirmed?: boolean;
  liveLease?: boolean;
  finalityLagMs?: number;
  observationFails?: string;
  studyImmediatelyConfirmed?: boolean;
};

/** The isolated stack after the failed win: paused, flags on, one study send retryable. */
function world(faults: Faults = {}) {
  let clock = 0;
  let paused = true;
  let revision = 34;
  let leaseLive = faults.liveLease ?? false;
  const flags = {
    http: faults.flagsOff ? "false" : "true",
    jobs: faults.flagsOff ? "false" : "true",
  };
  const sends: Array<{ send_id: string; credit_id: string; status: string }> = [
    { send_id: "send-study", credit_id: "credit-study", status: "retryable" },
  ];
  if (faults.karaokeAlreadyConfirmed)
    sends.push({ send_id: "send-karaoke", credit_id: "credit-karaoke", status: "confirmed" });
  const log: string[] = [];
  const records: unknown[] = [];
  let lockCleared = false;
  const extra = faults.foreignSend
    ? [{ send_id: "send-other", credit_id: "credit-other", status: "retryable" }]
    : [];
  const inventory = () => ({
    ...zero,
    ...(faults.foreignOpen ? { [faults.foreignOpen]: "1" } : {}),
    unresolved_winner_sends: String(
      [...sends, ...extra].filter((send) => send.status !== "confirmed").length,
    ),
  });
  const db = {
    read: async (text: string) => {
      if (text.includes("reward_operations_control"))
        return [{ paused, revision: String(revision) }];
      if (text.includes("reward_gas_topup_wallets"))
        return faults.noGasWallet ? [] : [{ signer_address: isolatedGasWallet }];
      return [{ required: true, live: leaseLive }];
    },
    control: async (target: boolean, expected: string) => {
      if (expected !== String(revision)) throw Object.assign(new Error("PR002"), { code: "PR002" });
      paused = target;
      revision += 1;
      log.push(target ? "pause" : "resume");
      return { control: { paused, revision: String(revision) } };
    },
    lease: {
      acquire: async () => {
        leaseLive = true;
        log.push("lease");
        return "1";
      },
      renew: async () => "2",
      release: async () => {
        leaseLive = false;
        log.push("release");
      },
    },
  };
  return {
    log,
    records,
    state: () => ({ paused, flags: { ...flags }, sends, lockCleared, leaseLive }),
    run: () =>
      completeWinnerSends({
        pinned: { runId: "win-1", legId: "leg-1", leaseQuery: "lease" },
        db,
        flags: {
          read: async () => ({ ...flags }),
          disableAll: async () => {
            flags.http = "false";
            flags.jobs = "false";
            log.push("flags-off");
          },
        },
        readShutdownInventory: async () => inventory(),
        readLegCredits: async () => credits,
        // A send on another leg is counted globally but is not read as this leg's.
        readLegSends: async () => [...sends],
        openHost: async (check: () => Promise<void>) => {
          await check();
          log.push("host");
          return { close: async () => log.push("host-closed") };
        },
        sendFor: async (
          _host: unknown,
          credit: { credit_id: string },
          _run: unknown,
          check: () => Promise<void>,
        ) => {
          await check();
          log.push(`send:${credit.credit_id}`);
          if (faults.sendFails && (!faults.failCredit || faults.failCredit === credit.credit_id))
            throw new Error(faults.sendFails);
          const existing = sends.find((send) => send.credit_id === credit.credit_id);
          if (existing)
            existing.status = faults.studyImmediatelyConfirmed ? "confirmed" : "pending";
          else
            sends.push({
              send_id: `send-${credit.credit_id}`,
              credit_id: credit.credit_id,
              status: "pending",
            });
          return { creditId: credit.credit_id, sendId: credit.credit_id };
        },
        observeFor: async (_host: unknown, credit: { credit_id: string }) => {
          expect(paused).toBe(true);
          expect(leaseLive).toBe(false);
          log.push(`observe:${credit.credit_id}`);
          if (faults.observationFails) throw Error(faults.observationFails);
          if (clock >= (faults.finalityLagMs ?? 0)) {
            const send = sends.find((send) => send.credit_id === credit.credit_id);
            if (send) send.status = "confirmed";
          }
        },
        checkServing: async () => {
          expect(flags).toEqual({ http: "true", jobs: "true" });
        },
        clearLock: () => {
          lockCleared = true;
        },
        record: (entry: unknown) => records.push(entry),
        leaseClock: { setTimer: () => 0, clearTimer: () => undefined },
        now: () => clock,
        waitMs: 1000,
        passiveWaitMs: 30000,
        sleep: async () => {
          clock += 5000;
        },
      }),
  };
}

test("both winners send on, the run closes out clean and the lock is cleared", async () => {
  const w = world();
  const result = await w.run();
  expect(result.errors).toEqual([]);
  expect(result.passed).toBe(true);
  expect(w.log).toEqual([
    "lease",
    "resume",
    "host",
    "send:credit-study",
    "send:credit-karaoke",
    "pause",
    "release",
    "observe:credit-study",
    "observe:credit-karaoke",
    "host-closed",
    "flags-off",
  ]);
  expect(w.state()).toMatchObject({ paused: true, lockCleared: true, leaseLive: false });
  expect(w.state().flags).toEqual({ http: "false", jobs: "false" });
});

test("both hashes are submitted before delayed finality, then observed beyond the signing deadline while paused", async () => {
  const w = world({ finalityLagMs: 15000 });
  expect((await w.run()).passed).toBe(true);
  const release = w.log.indexOf("release");
  expect(w.log.indexOf("send:credit-study")).toBeLessThan(release);
  expect(w.log.indexOf("send:credit-karaoke")).toBeLessThan(release);
  expect(w.log.slice(release + 1).some((entry) => entry.startsWith("send:"))).toBe(false);
  expect(w.log.filter((entry) => entry.startsWith("observe:")).length).toBe(8);
});

test("passive finality timeout or a failed observation keeps flags and lock while authority is ended", async () => {
  for (const faults of [{ finalityLagMs: 60000 }, { observationFails: "RPC unavailable" }]) {
    const w = world(faults);
    expect((await w.run()).passed).toBe(false);
    expect(w.state()).toMatchObject({
      paused: true,
      leaseLive: false,
      lockCleared: false,
      flags: { http: "true", jobs: "true" },
    });
  }
});

test("a send already confirmed is not sent again", async () => {
  const w = world({ karaokeAlreadyConfirmed: true });
  expect((await w.run()).passed).toBe(true);
  expect(w.log.filter((entry) => entry.startsWith("send:"))).toEqual(["send:credit-study"]);
});

test("a failed send pauses, releases and leaves the flags on and the lock in place", async () => {
  const w = world({ sendFails: "App command refused: HTTP 502" });
  const result = await w.run();
  expect(result.passed).toBe(false);
  expect(result.errors[0]).toContain("HTTP 502");
  expect(result.errors.some((error: string) => error.startsWith("obligations remain"))).toBe(true);
  expect(w.log.slice(-3)).toEqual(["pause", "release", "host-closed"]);
  expect(w.state()).toMatchObject({ paused: true, lockCleared: false, leaseLive: false });
  expect(w.state().flags).toEqual({ http: "true", jobs: "true" });
});

test("nothing is resumed when anything but the pinned winner sends is open", async () => {
  for (const category of [
    "unresolved_funding",
    "unpaid_credits",
    "unresolved_chain_effects",
    "open_offers",
  ]) {
    const w = world({ foreignOpen: category });
    await expect(w.run()).rejects.toThrow(`${category} is open`);
    expect(w.log).toEqual([]);
  }
  const foreign = world({ foreignSend: true });
  await expect(foreign.run()).rejects.toThrow("outside the pinned leg");
  expect(foreign.log).toEqual([]);
});

test("nothing is resumed without a registered gas wallet, with flags off, or with a live lease", async () => {
  const gas = world({ noGasWallet: true });
  await expect(gas.run()).rejects.toThrow("gas top-up wallet is not registered");
  const off = world({ flagsOff: true });
  await expect(off.run()).rejects.toThrow("both flags on");
  const live = world({ liveLease: true });
  await expect(live.run()).rejects.toThrow("none live");
  for (const w of [gas, off, live]) expect(w.log).toEqual([]);
});

test("the gas wallet check accepts only the isolated gas wallet", () => {
  expect(() => assertGasWalletRegistered([])).toThrow("not registered");
  expect(() =>
    assertGasWalletRegistered([{ signer_address: "0x0000000000000000000000000000000000000001" }]),
  ).toThrow("not registered");
  expect(assertGasWalletRegistered([{ signer_address: isolatedGasWallet }])).toEqual({
    gasWallet: isolatedGasWallet,
  });
});

test("flags stay on when a send failed before it had a row, so the recovery can be retried", async () => {
  const w = world({
    sendFails: "App command refused: HTTP 503",
    failCredit: "credit-karaoke",
    studyImmediatelyConfirmed: true,
  });
  const result = await w.run();
  expect(result.passed).toBe(false);
  // Study confirmed and Karaoke has no row, so every shutdown category reads zero.
  expect(result.shutdown?.unresolved_winner_sends).toBe("0");
  expect(w.state().flags).toEqual({ http: "true", jobs: "true" });
  expect(w.state()).toMatchObject({ paused: true, lockCleared: false, leaseLive: false });
  expect(result.errors.some((error: string) => error.includes("onward sends not confirmed"))).toBe(
    true,
  );
});
