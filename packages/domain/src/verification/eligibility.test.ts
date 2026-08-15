import { describe, expect, test } from "bun:test";
import {
  applyLazyCapabilityExpiry,
  buildDefaultVerificationCapabilities,
  deriveRewardIdentityId,
  deriveVerificationState,
  INTERACTIVE_VERIFICATION_TTL_MS,
  parseVerificationCapabilities,
  type RewardIdentityCandidate,
  resolveRewardIdentityProvider,
  selectActiveRewardIdentity,
  selectActiveSupportedRewardIdentity,
  type VerificationCapabilities,
} from "./eligibility";

const NOW = Date.parse("2026-08-16T00:00:00.000Z");

function verifiedCapability(provider: "self" | "very" | "zkpassport", verifiedAt: string) {
  return {
    state: "verified" as const,
    provider,
    proof_type: "unique_human",
    mechanism: "zk-nullifier",
    verified_at: verifiedAt,
  };
}

function candidate(overrides: Partial<RewardIdentityCandidate> = {}): RewardIdentityCandidate {
  return {
    identityNullifierId: "nullifier_1",
    provider: "self",
    mechanism: "zk-nullifier",
    nullifierHash: "human-1",
    sourceAttestationId: "att_1",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function capabilities(overrides: Partial<VerificationCapabilities> = {}): VerificationCapabilities {
  return {
    ...buildDefaultVerificationCapabilities(),
    ...overrides,
  };
}

describe("verification capability lifecycle", () => {
  test("preserves the old serialized capability shape and lazily expires interactive evidence", () => {
    const serialized = JSON.stringify({
      unique_human: verifiedCapability("zkpassport", "2026-05-01T00:00:00.000Z"),
      age_over_18: {
        ...verifiedCapability("self", "2026-05-01T00:00:00.000Z"),
        proof_type: "age_over_18",
        mechanism: "zk-age",
      },
      minimum_age: {
        ...verifiedCapability("self", "2026-08-01T00:00:00.000Z"),
        value: 21,
        proof_type: "minimum_age",
        mechanism: "zk-age",
      },
      nationality: {
        ...verifiedCapability("self", "2026-05-01T00:00:00.000Z"),
        value: "US",
        proof_type: "nationality",
        mechanism: "zk-nationality",
      },
      gender: {
        ...verifiedCapability("self", "2026-05-01T00:00:00.000Z"),
        value: "F",
        proof_type: "gender",
        mechanism: "zk-gender",
      },
      wallet_score: {
        ...verifiedCapability("self", "2026-08-01T00:00:00.000Z"),
        score_decimal: "0.91",
        score_threshold_decimal: "0.8",
        passing_score: true,
        last_scored_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-08-15T00:00:00.000Z",
        stamps: null,
        proof_type: "wallet_score",
      },
    });
    const parsed = parseVerificationCapabilities(serialized, NOW);
    expect(parsed.unique_human.state).toBe("expired");
    expect(parsed.age_over_18.state).toBe("expired");
    expect(parsed.minimum_age.state).toBe("verified");
    expect(parsed.nationality.state).toBe("expired");
    expect(parsed.gender.state).toBe("expired");
    expect(parsed.wallet_score.state).toBe("expired");
    expect(parsed.minimum_age.value).toBe(21);
    expect(deriveVerificationState(parsed)).toBe("reverification_required");
  });

  test("keeps the provider-specific lifecycle rules and exact TTL boundary", () => {
    const old = new Date(NOW - INTERACTIVE_VERIFICATION_TTL_MS - 1).toISOString();
    const atBoundary = new Date(NOW - INTERACTIVE_VERIFICATION_TTL_MS).toISOString();
    const input = capabilities({
      unique_human: verifiedCapability("very", old),
      age_over_18: verifiedCapability("very", old),
      minimum_age: { ...verifiedCapability("zkpassport", atBoundary), value: null },
      nationality: { ...verifiedCapability("self", atBoundary), value: null },
      wallet_score: {
        ...buildDefaultVerificationCapabilities().wallet_score,
        ...verifiedCapability("very", "2026-08-01T00:00:00.000Z"),
        expires_at: new Date(NOW).toISOString(),
      },
    });
    const expired = applyLazyCapabilityExpiry(input, NOW);
    expect(expired.unique_human.state).toBe("expired");
    expect(expired.age_over_18.state).toBe("verified");
    expect(expired.minimum_age.state).toBe("expired");
    expect(expired.nationality.state).toBe("expired");
    expect(expired.wallet_score.state).toBe("expired");
  });

  test("malformed serialized capabilities fail closed to defaults", () => {
    expect(parseVerificationCapabilities("not-json", NOW)).toEqual(
      buildDefaultVerificationCapabilities(),
    );
    expect(parseVerificationCapabilities(null, NOW)).toEqual(
      buildDefaultVerificationCapabilities(),
    );
  });
});

describe("unique-human eligibility", () => {
  test("normalizes only supported reward identity providers", () => {
    expect(resolveRewardIdentityProvider(" ZKPassport ")).toBe("zkpassport");
    expect(resolveRewardIdentityProvider("unknown")).toBeNull();
    expect(resolveRewardIdentityProvider(undefined)).toBeNull();
  });

  test("uses durable evidence for attested candidates and projection fallback for legacy rows", () => {
    const selected = selectActiveSupportedRewardIdentity({
      candidates: [
        candidate({
          provider: "very",
          identityNullifierId: "very-1",
          sourceAttestationId: "att-very",
        }),
        candidate({
          provider: "zkpassport",
          identityNullifierId: "zk-1",
          sourceAttestationId: "att-zk",
        }),
      ],
      durableEvidenceIds: new Set(["zk-1"]),
      projection: buildDefaultVerificationCapabilities(),
    });
    expect(selected?.provider).toBe("zkpassport");

    const legacy = selectActiveSupportedRewardIdentity({
      candidates: [candidate({ sourceAttestationId: null })],
      durableEvidenceIds: new Set(),
      projection: capabilities({
        unique_human: verifiedCapability("self", "2026-08-01T00:00:00.000Z"),
      }),
    });
    expect(legacy?.provider).toBe("self");
  });

  test("requires the requested provider's durable evidence before selecting a reward identity", () => {
    const input = {
      candidates: [candidate({ provider: "self" })],
      requiredProvider: "self" as const,
      evidence: [{ provider: "very", sourceIdentityNullifierId: "nullifier_1" }],
    };
    expect(selectActiveRewardIdentity(input)).toBeNull();
    expect(
      selectActiveRewardIdentity({
        ...input,
        evidence: [{ provider: "self", sourceIdentityNullifierId: "nullifier_1" }],
      })?.provider,
    ).toBe("self");
  });

  test("derives the same opaque reward identity for the same provider material", async () => {
    const first = await deriveRewardIdentityId("self", "zk-nullifier", "human-1");
    const second = await deriveRewardIdentityId("self", "zk-nullifier", "human-1");
    expect(first).toBe(second);
    expect(first).toMatch(/^rwi_[a-f0-9]{64}$/);
  });
});
