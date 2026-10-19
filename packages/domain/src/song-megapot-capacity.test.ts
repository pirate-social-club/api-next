import { describe, expect, test } from "bun:test";
import {
  type AuthoritativeSchedule,
  type CapacityProfile,
  type DrawingCapacityRow,
  initialMegapotWindow,
  type PoolPrincipalBudget,
  songMegapotCapacity,
} from "./song-megapot-capacity.ts";

// Deliberately tiny fictional policy. No production configuration is selected here.
const profile: CapacityProfile = {
  maxDrawings: 10,
  reservationMs: 100,
  safetyMarginMs: 20,
  maximumWitnessAgeMs: 1000,
  validUntil: 5000,
  attestationValidUntil: 5000,
  priceCeilingAtomic: 2n,
  minimumAtomic: 1n,
};
const row = (i: number): DrawingCapacityRow => ({
  id: String(i),
  drawingTime: 1000 + i * 100,
  entryCutoff: 1000 + i * 100,
  purchaseDeadline: 1000 + i * 100,
  priceAtomic: 1n,
  proof: "initialized_state",
  state: "uncommitted",
  reservedCostAtomic: 0n,
});
const schedule: AuthoritativeSchedule = {
  observedAt: 0,
  validUntil: 5000,
  ruleHash: "reviewed_rule",
  priceRuleHash: "reviewed_price",
  recurrenceProven: false,
  rows: Array.from({ length: 10 }, (_, i) => row(i + 1)),
};
const budget: PoolPrincipalBudget = {
  funded: 5n,
  spent: 0n,
  committedPurchases: 0n,
  refunded: 0n,
  otherObligations: 0n,
  liveInboundReservations: 2n,
};
const input = {
  now: 10,
  profile,
  schedule,
  plannedDrawingIds: schedule.rows.map((r) => r.id),
  fixedEndsAt: 2000,
  reservationDeadlineUpperBound: 1080,
  budget,
  outboundCostsReconciled: true,
};

describe("shared song capacity", () => {
  test("delayed original drawing counts by its cutoff without extending fixed end or adding IDs", () => {
    const delayed = {
      ...row(10),
      drawingTime: 2500,
      entryCutoff: input.fixedEndsAt,
      purchaseDeadline: input.fixedEndsAt,
    };
    const fixed = {
      ...input,
      plannedDrawingIds: ["10"],
      budget: { ...budget, funded: 0n, liveInboundReservations: 0n },
    };
    expect(
      songMegapotCapacity({
        ...fixed,
        schedule: {
          ...schedule,
          rows: [
            delayed,
            { ...row(11), drawingTime: 2600, entryCutoff: 1900, purchaseDeadline: 1900 },
          ],
        },
      }),
    ).toEqual({ ok: true, availableAtomic: 1n, usableDrawingIds: ["10"] });
    expect(
      songMegapotCapacity({
        ...fixed,
        schedule: { ...schedule, rows: [{ ...delayed, entryCutoff: input.fixedEndsAt + 1 }] },
      }),
    ).toEqual({ ok: true, availableAtomic: 0n, usableDrawingIds: [] });
    expect(fixed.fixedEndsAt).toBe(2000);
    expect(fixed.plannedDrawingIds).toEqual(["10"]);
  });
  test("one authoritative row and the last row count at end/cutoff equality", () => {
    const one = { ...schedule, rows: [row(1)] };
    const w = initialMegapotWindow({ now: 10, profile, schedule: one });
    expect(w).toEqual({
      ok: true,
      plannedDrawingIds: ["1"],
      fixedEndsAt: 1100,
      latestAllocationAt: 980,
      reservationDeadlineUpperBound: 1080,
    });
    expect(
      songMegapotCapacity({
        ...input,
        schedule: one,
        plannedDrawingIds: ["1"],
        fixedEndsAt: 1100,
        budget: { ...budget, funded: 0n, liveInboundReservations: 0n },
      }),
    ).toMatchObject({ ok: true, availableAtomic: 1n });
  });
  test("10 future costs minus 5 free minus 2 inbound = 3, purchase committed once", () => {
    expect(songMegapotCapacity(input)).toMatchObject({ ok: true, availableAtomic: 3n });
    const committed = {
      ...schedule,
      rows: schedule.rows.map((r, i) =>
        i === 0 ? { ...r, state: "committed" as const, reservedCostAtomic: 1n } : r,
      ),
    };
    expect(
      songMegapotCapacity({
        ...input,
        schedule: committed,
        budget: { ...budget, committedPurchases: 1n },
      }),
    ).toMatchObject({ ok: true, availableAtomic: 3n });
    const settled = {
      ...schedule,
      rows: schedule.rows.map((r, i) => (i === 0 ? { ...r, state: "settled" as const } : r)),
    };
    expect(
      songMegapotCapacity({ ...input, schedule: settled, budget: { ...budget, spent: 1n } }),
    ).toMatchObject({ ok: true, availableAtomic: 3n });
  });
  test("quote allocation equality expires, no capacity release by elapsed time", () => {
    expect(
      initialMegapotWindow({ now: 980, profile, schedule: { ...schedule, rows: [row(1)] } }),
    ).toEqual({ ok: false, reason: "quote_expired" });
    expect(songMegapotCapacity({ ...input, now: 980 })).toEqual({
      ok: false,
      reason: "quote_expired",
    });
  });
  test("missing policies or future proof and stale observations fail closed", () => {
    expect(songMegapotCapacity({ ...input, profile: null })).toMatchObject({
      reason: "policy_unavailable",
    });
    expect(songMegapotCapacity({ ...input, schedule: null })).toMatchObject({
      reason: "schedule_unproven",
    });
    expect(songMegapotCapacity({ ...input, now: 1001 })).toMatchObject({
      reason: "observation_stale",
    });
    expect(
      songMegapotCapacity({
        ...input,
        schedule: { ...schedule, rows: [{ ...row(1), proof: "attested_recurrence" }] },
      }),
    ).toMatchObject({ reason: "schedule_unproven" });
  });
  test("unknown purchase cost or nonconservation refuses rather than inflating capacity", () => {
    expect(songMegapotCapacity({ ...input, outboundCostsReconciled: false })).toMatchObject({
      reason: "recovery_required",
    });
    expect(songMegapotCapacity({ ...input, budget: { ...budget, spent: 6n } })).toMatchObject({
      reason: "recovery_required",
    });
    expect(
      songMegapotCapacity({ ...input, budget: { ...budget, committedPurchases: 1n } }),
    ).toMatchObject({ reason: "recovery_required" });
  });
  test("unplanned rollover rows cannot extend the original end or capacity", () => {
    expect(
      songMegapotCapacity({
        ...input,
        schedule: { ...schedule, rows: [...schedule.rows, row(11)] },
      }),
    ).toMatchObject({ ok: true, availableAtomic: 3n });
    expect(
      songMegapotCapacity({
        ...input,
        schedule: {
          ...schedule,
          rows: schedule.rows.map((r) => ({
            ...r,
            entryCutoff: r.entryCutoff + 5000,
            drawingTime: r.drawingTime + 5000,
          })),
        },
      }),
    ).toMatchObject({ ok: true, availableAtomic: 0n });
    expect(
      songMegapotCapacity({
        ...input,
        schedule: { ...schedule, rows: schedule.rows.map((r) => ({ ...r, priceAtomic: 3n })) },
      }),
    ).toMatchObject({ reason: "price_changed" });
  });
  test("authoritative current prices rather than ceiling set capacity", () => {
    const result = songMegapotCapacity({
      ...input,
      budget: { ...budget, funded: 0n, liveInboundReservations: 0n },
    });
    expect(result).toMatchObject({ ok: true, availableAtomic: 10n });
  });
});
