import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CanonicalIsoInstant, NonNegativeIntegerString } from "./scalars.ts";

describe("verification wire scalars", () => {
  test("accepts only the canonical UTC millisecond instant representation", () => {
    expect(Schema.decodeUnknownSync(CanonicalIsoInstant)("2026-08-17T00:00:00.000Z")).toBe(
      "2026-08-17T00:00:00.000Z",
    );
    expect(Schema.decodeUnknownSync(CanonicalIsoInstant)("2028-02-29T00:00:00.000Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    for (const invalid of [
      "2026-08-17T00:00:00Z",
      "2026-08-17T00:00:00.000+00:00",
      "2026-08-17 00:00:00.000Z",
      "2026-13-17T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-02-29T00:00:00.000Z",
      "2026-08-17T24:00:00.000Z",
    ]) {
      expect(() => Schema.decodeUnknownSync(CanonicalIsoInstant)(invalid)).toThrow();
    }
  });

  test("accepts only canonical non-negative integer strings", () => {
    for (const valid of ["0", "1", "1000000"]) {
      expect(Schema.decodeUnknownSync(NonNegativeIntegerString)(valid)).toBe(valid);
    }
    for (const invalid of ["", "-1", "+1", "01", "1.0", "1e3", " 1"]) {
      expect(() => Schema.decodeUnknownSync(NonNegativeIntegerString)(invalid)).toThrow();
    }
  });
});
