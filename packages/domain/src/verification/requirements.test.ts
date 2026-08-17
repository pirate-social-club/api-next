import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  canonicalizeVerificationRequirements,
  VerificationRequirements,
  verificationRequirementClaimIds,
} from "./requirements.ts";

describe("verification requirements", () => {
  test("binds thresholds and allowlists into one canonical provider-neutral request", () => {
    const requirements = canonicalizeVerificationRequirements([
      {
        claim_id: "nationality.allowed",
        allowed_countries: ["US", "GE"],
      },
      { claim_id: "age.minimum", minimum_age: "18" },
      { claim_id: "document.valid" },
    ]);

    expect(requirements).toEqual([
      { claim_id: "age.minimum", minimum_age: "18" },
      { claim_id: "document.valid" },
      {
        claim_id: "nationality.allowed",
        allowed_countries: ["GE", "US"],
      },
    ]);
    expect(
      JSON.stringify(Schema.decodeUnknownSync(VerificationRequirements)(requirements as unknown)),
    ).toBe(JSON.stringify(requirements));
    expect(verificationRequirementClaimIds(requirements)).toEqual([
      "age.minimum",
      "document.valid",
      "nationality.allowed",
    ]);
  });

  test("rejects duplicate claim requirements", () => {
    expect(() =>
      Schema.decodeUnknownSync(VerificationRequirements)([
        { claim_id: "age.minimum", minimum_age: "18" },
        { claim_id: "age.minimum", minimum_age: "21" },
      ]),
    ).toThrow();
  });

  test("rejects noncanonical country and requirement order", () => {
    expect(() =>
      Schema.decodeUnknownSync(VerificationRequirements)([
        { claim_id: "nationality.allowed", allowed_countries: ["US", "GE"] },
      ]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VerificationRequirements)([
        { claim_id: "document.valid" },
        { claim_id: "age.minimum", minimum_age: "18" },
      ]),
    ).toThrow();
  });

  test("rejects invalid ages, country codes, and empty predicate sets", () => {
    expect(() =>
      Schema.decodeUnknownSync(VerificationRequirements)([
        { claim_id: "age.minimum", minimum_age: "151" },
      ]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VerificationRequirements)([
        { claim_id: "nationality.allowed", allowed_countries: ["GEO"] },
      ]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VerificationRequirements)([
        { claim_id: "nationality.allowed", allowed_countries: [] },
      ]),
    ).toThrow();
  });
});
