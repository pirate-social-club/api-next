import { expect, test } from "bun:test";
import { recoverSettlement, recoveryDeadline } from "./settlement-recovery.mjs";

const cleanShutdown = new Proxy({}, { get: () => "0" });
const leg = (refunded: string, spent = "0", fulfilled = "0") => ({
  leg_id: "leg",
  status: "ended",
  funded_atomic: "1000000",
  spent_atomic: spent,
  fulfilled_atomic: fulfilled,
  refunded_atomic: refunded,
  reserved_atomic: "0",
});
const inventory = (overrides = {}) => ({
  legs: [leg("0")],
  drawings: [],
  shares: [],
  purchases: [],
  credits: [],
  refunds: [],
  ...overrides,
});
const roles = [
  { name: "study", accountId: "study-account" },
  { name: "karaoke", accountId: "karaoke-account" },
];

function harness(states: ReturnType<typeof inventory>[], options = {}) {
  let clock = 0;
  let reads = 0;
  const calls: string[] = [];
  return {
    calls,
    run: () =>
      recoverSettlement({
        deadline: 60000,
        roles,
        expectedRevision: "3",
        readControl: async () => ({ paused: false, revision: "3" }),
        readInventory: async () => states[Math.min(reads++, states.length - 1)],
        readShutdownInventory: async () => cleanShutdown,
        advance: async () => {
          calls.push("advance");
        },
        claim: async (role: string) => {
          calls.push(`claim-${role}`);
        },
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
        ...options,
      }),
  };
}

test("a funded leg without a ticket settles once its refund confirms", async () => {
  const refunded = inventory({
    legs: [leg("1000000")],
    drawings: [{ status: "closed_no_entries" }],
    refunds: [{ state: "confirmed", amount_atomic: "1000000" }],
  });
  const { run, calls } = harness([inventory(), inventory(), refunded]);
  const result = await run();
  expect(result.settled).toBe(true);
  expect(calls).toEqual([]);
});

test("a purchased ticket is settled once, then its refund closes the leg", async () => {
  const ticket = { state: "confirmed", ticket_id: "7", ticket_status: "held" };
  const purchased = inventory({ purchases: [ticket], drawings: [{ status: "tickets_confirmed" }] });
  const lost = inventory({
    legs: [leg("990000", "10000")],
    purchases: [{ ...ticket, ticket_status: "no_win" }],
    drawings: [{ status: "no_win" }],
    refunds: [{ state: "confirmed", amount_atomic: "990000" }],
  });
  const { run, calls } = harness([purchased, purchased, lost]);
  const result = await run();
  expect(result.settled).toBe(true);
  expect(calls).toEqual(["advance"]);
});

test("a refused advance is never replayed and ends in a bounded stop", async () => {
  const purchased = inventory({
    purchases: [{ state: "confirmed", ticket_id: "7", ticket_status: "held" }],
    drawings: [{ status: "tickets_confirmed" }],
  });
  let attempts = 0;
  const { run } = harness([purchased], {
    advance: async () => {
      attempts++;
      throw new Error("Single-use action already consumed; inspect evidence, never replay");
    },
  });
  const result = await run();
  expect(result.settled).toBe(false);
  expect(result.reason).toBe("Settlement recovery deadline expired");
  expect(attempts).toBe(1);
  expect(result.actions).toEqual([
    {
      id: "advance-purchased-drawing",
      outcome: "refused-or-uncertain",
      reason: "Single-use action already consumed; inspect evidence, never replay",
    },
  ]);
});

test("each unpaid credit is claimed once and paid credits close the leg", async () => {
  const ticket = { state: "confirmed", ticket_id: "7", ticket_status: "claimed" };
  const credit = (account: string, state: string, paid: string) => ({
    account_id: account,
    state,
    amount_atomic: "500000",
    paid_atomic: paid,
    reserved_atomic: "0",
  });
  const base = {
    legs: [leg("990000", "10000")],
    purchases: [ticket],
    drawings: [{ status: "credited" }],
    refunds: [{ state: "confirmed", amount_atomic: "990000" }],
  };
  const unpaid = inventory({
    ...base,
    credits: [credit("study-account", "credited", "0"), credit("karaoke-account", "credited", "0")],
  });
  const paid = inventory({
    ...base,
    credits: [
      credit("study-account", "sent", "500000"),
      credit("karaoke-account", "sent", "500000"),
    ],
  });
  const { run, calls } = harness([unpaid, unpaid, paid]);
  const result = await run();
  expect(result.settled).toBe(true);
  expect(calls).toEqual(["claim-study", "claim-karaoke"]);
});

test("a paused or changed brake stops recovery before any action", async () => {
  for (const control of [
    { paused: true, revision: "3" },
    { paused: false, revision: "4" },
  ]) {
    const purchased = inventory({
      purchases: [{ state: "confirmed", ticket_id: "7", ticket_status: "held" }],
    });
    const { run, calls } = harness([purchased], { readControl: async () => control });
    const result = await run();
    expect(result.settled).toBe(false);
    expect(result.reason).toBe("Brake is paused or changed; settlement cannot continue");
    expect(calls).toEqual([]);
  }
});

test("a settled leg still waits for the whole stack's shutdown inventory", async () => {
  const refunded = inventory({
    legs: [leg("1000000")],
    refunds: [{ state: "confirmed", amount_atomic: "1000000" }],
  });
  let shutdownReads = 0;
  const { run } = harness([refunded], {
    readShutdownInventory: async () =>
      ++shutdownReads < 3 ? new Proxy({}, { get: () => "1" }) : cleanShutdown,
  });
  const result = await run();
  expect(result.settled).toBe(true);
  expect(shutdownReads).toBe(3);
});

test("the recovery deadline is bounded on both sides", () => {
  const now = 1_000_000_000_000;
  expect(recoveryDeadline(now, now / 1000 - 3600)).toBe(now + 5 * 60000);
  expect(recoveryDeadline(now, now / 1000 + 240)).toBe(now + 240000 + 10 * 60000);
  expect(recoveryDeadline(now, now / 1000 + 86400)).toBe(now + 30 * 60000);
  expect(recoveryDeadline(now, undefined)).toBe(now + 5 * 60000);
});

test("a transient read failure is retried instead of ending recovery", async () => {
  const refunded = inventory({
    legs: [leg("1000000")],
    refunds: [{ state: "confirmed", amount_atomic: "1000000" }],
  });
  let reads = 0;
  const { run, calls } = harness([refunded], {
    readInventory: async () => {
      if (reads++ < 2) throw new Error("connection timeout");
      return refunded;
    },
  });
  const result = await run();
  expect(result.settled).toBe(true);
  expect(result.readFailures).toBe(2);
  expect(calls).toEqual([]);
});

test("a missing leg settles on the whole stack's inventory alone", async () => {
  let shutdownReads = 0;
  const { run, calls } = harness([], {
    readInventory: async () => null,
    readShutdownInventory: async () =>
      ++shutdownReads < 3 ? new Proxy({}, { get: () => "1" }) : cleanShutdown,
  });
  const result = await run();
  expect(result.settled).toBe(true);
  expect(calls).toEqual([]);
});
