import { describe, expect, it } from "bun:test";

import { evaluateLease, type LeaseRecord } from "./cron-lock";

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
});
