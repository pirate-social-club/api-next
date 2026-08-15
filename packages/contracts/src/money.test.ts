import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AtomicUsdc, Cents, DecimalStringSchema } from "./money.ts";

/**
 * Review-flag audit (2026-08-15, lane A done-criteria): is Schema.Natural too
 * strict for Cents/AtomicUsdc — did the old API ever serialize a negative
 * cents value on the wire?
 *
 * Finding: no. Every old-API money column carries a CHECK (>= 0) constraint
 * (booking_settlement_effects.amount_cents, bookings fee/payout/refund cents,
 * community_handle_claim_quotes.price_cents, purchase gross_cents > 0, ...),
 * reward balances clamp at zero before serialization
 * (reward-cashout-service Math.max(0, balance)), and refunds are separate
 * positive-amount effects, never negative charges. The only signed cents
 * values are the reward-campaign monitor's internal drift deltas
 * (funded/reserved/credited_delta_cents), which flow to the ops-alert sink
 * and never onto an API response. Natural (non-negative integer) is therefore
 * the correct wire brand, and this test pins it.
 */
describe("money brands", () => {
  const decodeCents = Schema.decodeUnknownSync(Cents) as (u: unknown) => number;
  const decodeAtomic = Schema.decodeUnknownSync(AtomicUsdc) as (u: unknown) => number;

  test("accept non-negative integers", () => {
    expect(decodeCents(0)).toBe(0);
    expect(decodeCents(2500)).toBe(2500);
    expect(decodeAtomic(25_000_000)).toBe(25_000_000);
  });

  test("reject negative amounts — no old wire field ever carried one", () => {
    expect(() => decodeCents(-1)).toThrow();
    expect(() => decodeAtomic(-100)).toThrow();
  });

  test("reject JSON floats — smallest units are integers", () => {
    expect(() => decodeCents(24.99)).toThrow();
    expect(() => decodeAtomic(1.5)).toThrow();
  });

  test("decimal strings stay strings", () => {
    const decode = Schema.decodeUnknownSync(DecimalStringSchema) as (u: unknown) => string;
    expect(decode("12.34")).toBe("12.34");
    expect(() => decode(12.34)).toThrow();
  });
});
