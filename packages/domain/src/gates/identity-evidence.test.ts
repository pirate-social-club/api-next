import { describe, expect, test } from "bun:test";
import { normalizeIdentityCountryCode } from "./country-codes";
import {
  evaluateIdentityEvidenceAtom,
  type IdentityEvidence,
  normalizeIdentityEvidenceValue,
} from "./identity-evidence";

function evidence(overrides: Partial<IdentityEvidence> = {}): IdentityEvidence {
  return {
    evidenceId: "att_1",
    userId: "user_1",
    capability: "nationality",
    provider: "self",
    mechanism: "zk-nullifier",
    value: { nationality: "USA" },
    verifiedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    sourceVerificationSessionId: "session_1",
    sourceIdentityNullifierId: "nullifier_1",
    ...overrides,
  };
}

describe("provider-keyed identity evidence evaluator", () => {
  test("uses any-match across providers without combining values", () => {
    const result = evaluateIdentityEvidenceAtom({
      evidence: [
        evidence({ provider: "self", value: { nationality: "CAN" } }),
        evidence({ evidenceId: "att_2", provider: "zkpassport", value: { nationality: "USA" } }),
      ],
      atom: {
        capability: "nationality",
        acceptedProviders: ["self", "zkpassport"],
        requiredCountries: ["US"],
      },
    });

    expect(result.outcome).toBe("passed");
    expect(result.witnesses.map((witness) => witness.evidenceId)).toEqual(["att_2"]);
  });

  test("normalizes alpha-2 and alpha-3 country codes", () => {
    const result = evaluateIdentityEvidenceAtom({
      evidence: [evidence({ value: { nationality: "US" } })],
      atom: { capability: "nationality", acceptedProviders: ["self"], requiredCountries: ["USA"] },
    });
    expect(result.outcome).toBe("passed");
  });

  test("keeps two same-provider documents as independent any-match witnesses", () => {
    const result = evaluateIdentityEvidenceAtom({
      evidence: [
        evidence({ value: { nationality: "CAN" }, sourceIdentityNullifierId: "nullifier_a" }),
        evidence({
          evidenceId: "att_2",
          value: { nationality: "USA" },
          sourceIdentityNullifierId: "nullifier_b",
        }),
      ],
      atom: { capability: "nationality", acceptedProviders: ["self"], requiredCountries: ["US"] },
    });
    expect(result.outcome).toBe("passed");
    expect(result.witnesses.map((witness) => witness.sourceIdentityNullifierId)).toEqual([
      "nullifier_b",
    ]);
  });

  test("matches minimum age and gender inside the shared evaluator", () => {
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [
          evidence({
            capability: "minimum_age",
            value: { minimum_age: 21 },
            sourceIdentityNullifierId: null,
          }),
        ],
        atom: { capability: "minimum_age", acceptedProviders: ["self"], minimumAge: 18 },
      }).outcome,
    ).toBe("passed");
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [
          evidence({
            capability: "gender",
            value: { gender: "F" },
            sourceIdentityNullifierId: null,
          }),
        ],
        atom: { capability: "gender", acceptedProviders: ["self"], requiredGender: "M" },
      }).mismatchReasons,
    ).toEqual(["gender_mismatch"]);
  });

  test("no evidence at all is action_required with the capability missing", () => {
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [],
        atom: { capability: "unique_human", acceptedProviders: ["self"] },
      }),
    ).toMatchObject({ outcome: "action_required", missingCapabilities: ["unique_human"] });
  });

  test("a verified-but-wrong value is a terminal mismatch, never silently passed", () => {
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [evidence({ value: { nationality: "CAN" } })],
        atom: {
          capability: "nationality",
          acceptedProviders: ["self"],
          requiredCountries: ["USA"],
        },
      }),
    ).toMatchObject({ outcome: "terminal_mismatch", mismatchReasons: ["nationality_mismatch"] });
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [evidence({ value: { nationality: "IRN" } })],
        atom: { capability: "nationality", acceptedProviders: ["self"], excludedCountries: ["IR"] },
      }),
    ).toMatchObject({ outcome: "terminal_mismatch", mismatchReasons: ["nationality_excluded"] });
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [
          evidence({
            capability: "minimum_age",
            value: { minimum_age: 16 },
            sourceIdentityNullifierId: null,
          }),
        ],
        atom: { capability: "minimum_age", acceptedProviders: ["self"], minimumAge: 18 },
      }),
    ).toMatchObject({ outcome: "terminal_mismatch", mismatchReasons: ["minimum_age_mismatch"] });
  });

  test("evidence from a non-accepted provider is action_required to re-verify elsewhere", () => {
    expect(
      evaluateIdentityEvidenceAtom({
        evidence: [evidence({ provider: "very", value: { nationality: "USA" } })],
        atom: { capability: "nationality", acceptedProviders: ["self"] },
      }),
    ).toMatchObject({
      outcome: "action_required",
      missingCapabilities: ["nationality"],
      mismatchReasons: ["provider_not_accepted"],
    });
  });
});

describe("normalizeIdentityEvidenceValue", () => {
  test("canonicalizes each capability", () => {
    expect(normalizeIdentityEvidenceValue(evidence({ value: { nationality: "US" } }))).toBe("USA");
    expect(
      normalizeIdentityEvidenceValue(
        evidence({ capability: "minimum_age", value: { minimum_age: 21 } }),
      ),
    ).toBe(21);
    expect(
      normalizeIdentityEvidenceValue(
        evidence({ capability: "age_over_18", value: { age_over_18: true } }),
      ),
    ).toBe(true);
    expect(
      normalizeIdentityEvidenceValue(evidence({ capability: "gender", value: { gender: "F" } })),
    ).toBe("F");
    expect(normalizeIdentityEvidenceValue(evidence({ capability: "unique_human" }))).toBe(true);
  });
});

describe("normalizeIdentityCountryCode", () => {
  test("aliases Kosovo inputs to the canonical XKK value", () => {
    for (const input of ["KS", "RKS", "XKX", "XKK"]) {
      expect(normalizeIdentityCountryCode(input)).toBe("XKK");
    }
  });

  test("rejects unknown or malformed codes", () => {
    expect(normalizeIdentityCountryCode("XX")).toBeNull();
    expect(normalizeIdentityCountryCode("ZZZ")).toBeNull();
    expect(normalizeIdentityCountryCode(42)).toBeNull();
    expect(normalizeIdentityCountryCode("usa ")).toBe("USA");
  });
});
