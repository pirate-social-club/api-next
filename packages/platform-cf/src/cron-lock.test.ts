import { describe, expect, it } from "bun:test";

import {
  evaluateFencedLease,
  evaluateLease,
  type FencedLeaseRecord,
  type LeaseRecord,
} from "./cron-lock";

describe("evaluateLease", () => {
  const held: LeaseRecord = { owner: "a", expiresAt: 1_000 };

  it("acquires when the lease is free", () => {
    const d = evaluateLease(null, 500, "a", 100);
    expect(d.acquired).toBe(true);
    expect(d.lease).toEqual({ owner: "a", expiresAt: 600 });
  });

  it("denies when held by another owner and unexpired", () => {
    const d = evaluateLease(held, 500, "b", 999);
    expect(d.acquired).toBe(false);
    expect(d.lease).toEqual(held);
  });

  it("acquires on behalf of another owner once expired", () => {
    const d = evaluateLease(held, 500, "b", 1_000);
    expect(d.acquired).toBe(true);
    expect(d.lease).toEqual({ owner: "b", expiresAt: 1_500 });
  });

  it("renews (same owner reacquires with a fresh expiry)", () => {
    const d = evaluateLease(held, 500, "a", 900);
    expect(d.acquired).toBe(true);
    expect(d.lease).toEqual({ owner: "a", expiresAt: 1_400 });
  });

  it("increments the fencing generation on acquisition and renewal", () => {
    const first = evaluateFencedLease(null, 500, "a", 100);
    expect(first).toEqual({
      acquired: true,
      lease: { owner: "a", expiresAt: 600, generation: 1 },
    });
    const current = first.lease as FencedLeaseRecord;
    const renewed = evaluateFencedLease(current, 500, "a", 200);
    expect(renewed.lease?.generation).toBe(2);
  });

  it("keeps the current token when another owner is denied", () => {
    const current: FencedLeaseRecord = { owner: "a", expiresAt: 1_000, generation: 9 };
    expect(evaluateFencedLease(current, 500, "b", 999)).toEqual({
      acquired: false,
      lease: current,
    });
  });
});
