import { describe, expect, test } from "bun:test";
import { compileNationalityPolicy, type NationalityPolicy } from "../gates-v2/index.ts";
import {
  type HandleNationalityEligibilitySnapshotV1,
  type HandleNationalityQualificationPolicyRefV1,
  handleNationalityEligibilitySnapshotHash,
  handleNationalityEligibilitySnapshotPreimage,
  handleNationalityQualificationRefFromPolicy,
  handleNationalityQualificationRefHash,
  handleNationalityQualificationRefPreimage,
  recheckHandleNationalityQualification,
} from "./nationality-qualification.ts";
import { handleQuoteV3Hash } from "./sales-v2.ts";

const providerFixtures = ["self.pass", "zkpassport"].map((provider_id) => ({
  provider_id,
  provider_configuration: { kind: "dynamic", reference: `test:${provider_id}`, version: "1" },
  method: "document",
  protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: provider_id,
    rp_scope: "test",
  },
  environment: "test",
}));

function policy(allowedCountries: readonly string[]): NationalityPolicy {
  const compilation = compileNationalityPolicy({
    policy_revision: 1,
    allowed_countries: allowedCountries,
    evidence_lifetime: { kind: "max_age_seconds", seconds: 3_600 },
    provider_bindings: providerFixtures,
  });
  if (compilation.kind !== "compiled") throw new Error(compilation.reason);
  return compilation.policy;
}

const compiled = policy(["US"]);
const qualification = handleNationalityQualificationRefFromPolicy(
  "curated-nationality-v1",
  compiled,
);

function snapshot(
  overrides: Partial<HandleNationalityEligibilitySnapshotV1> = {},
): HandleNationalityEligibilitySnapshotV1 {
  return {
    decision: "passed",
    policy_revision: qualification.policy_revision,
    policy_hash: qualification.policy_hash,
    requirement_hash: qualification.requirement_hash,
    selected_provider_id: "self.pass",
    selected_provider_binding_hash: qualification.provider_binding_hashes[0],
    accepted_provider_ids: ["self.pass", "zkpassport"],
    lifetime: qualification.lifetime,
    evidence_use_ids: ["evidence-use-1"],
    evaluated_at: "2026-09-13T12:00:00.000Z",
    ...overrides,
  };
}

function recheckInput(
  overrides: Readonly<{
    current?: Partial<HandleNationalityQualificationPolicyRefV1>;
    offering_revision?: number;
    offering_hash?: string;
    evaluation?: Parameters<typeof recheckHandleNationalityQualification>[0]["evaluation"];
    winning_provider_binding_hash?: string | null;
  }> = {},
) {
  return {
    pin: {
      offering_revision: 3,
      offering_hash: "a".repeat(64),
      qualification,
      eligibility: snapshot(),
    },
    current: {
      offering_revision: overrides.offering_revision ?? 3,
      offering_hash: overrides.offering_hash ?? "a".repeat(64),
      qualification: { ...qualification, ...overrides.current },
    },
    evaluation:
      overrides.evaluation ??
      ({
        outcome: "pass",
        policy_hash: qualification.policy_hash,
        requirement_hash: qualification.requirement_hash,
        winning_witness: [
          {
            assertion_ids: ["assertion-1"],
            evidence_receipt_ids: ["receipt-1"],
            subject_key_id: "subject-1",
            binding_group_id: "binding-group-1",
          },
        ],
      } as const),
    winning_provider_binding_hash:
      overrides.winning_provider_binding_hash === undefined
        ? qualification.provider_binding_hashes[0]
        : overrides.winning_provider_binding_hash,
  };
}

describe("handle nationality qualification authoring and snapshots", () => {
  test("derives the versioned qualification ref from the curated policy", () => {
    expect(qualification).toMatchObject({
      kind: "curated_nationality_v1",
      policy_id: "curated-nationality-v1",
      policy_revision: 1,
      policy_hash: compiled.policy_hash,
      requirement_hash: compiled.requirement_hash,
      lifetime: { kind: "max_age_seconds", seconds: 3_600 },
    });
    expect(qualification.provider_binding_hashes).toHaveLength(2);
    expect(qualification.provider_binding_hashes[0]).not.toBe(
      qualification.provider_binding_hashes[1],
    );
  });

  test("refuses an indefinite lifetime because none was adopted", () => {
    const indefinite = policy(["US"]);
    expect(() =>
      handleNationalityQualificationRefFromPolicy("curated-nationality-v1", {
        ...indefinite,
        evidence_lifetime: { kind: "no_age_limit" },
      }),
    ).toThrow("Nationality qualification requires an explicit bounded lifetime");
  });

  test("freezes the canonical ref and snapshot preimages", () => {
    const refPreimage = handleNationalityQualificationRefPreimage(qualification);
    expect(refPreimage[0]).toBe("pirate-handle-nationality-qualification-ref-v1");
    expect(refPreimage[4]).toBe(compiled.requirement_hash);
    expect(JSON.stringify(refPreimage)).not.toContain("US");
    const refHash = handleNationalityQualificationRefHash(qualification);
    expect(refHash.sha256).toBe("f192a0eb5c7a86ac31755a58e24c335514c4484bbb59dd085dbe4e887a01f10a");

    const snapshotPreimage = handleNationalityEligibilitySnapshotPreimage(snapshot());
    expect(snapshotPreimage[0]).toBe("pirate-handle-nationality-eligibility-snapshot-v1");
    expect(JSON.stringify(snapshotPreimage)).not.toContain("US");
    const snapshotHash = handleNationalityEligibilitySnapshotHash(snapshot());
    expect(snapshotHash.sha256).toBe(
      "7d9d4b2f6ad39fa851fb7f54b9ef9133a85431c0d7edd827c4dc7dcafbe4dc42",
    );
  });

  test("invalidates a stale pinned quote instead of substituting the newest policy", () => {
    const revisedCompilation = compileNationalityPolicy({
      policy_revision: 2,
      allowed_countries: ["US"],
      evidence_lifetime: { kind: "max_age_seconds", seconds: 3_600 },
      provider_bindings: providerFixtures,
    });
    if (revisedCompilation.kind !== "compiled") throw new Error(revisedCompilation.reason);
    const revised = handleNationalityQualificationRefFromPolicy(
      "curated-nationality-v1",
      revisedCompilation.policy,
    );
    expect(revised.policy_hash).not.toBe(qualification.policy_hash);
    const input = recheckInput({
      current: {
        policy_revision: revised.policy_revision,
        policy_hash: revised.policy_hash,
        requirement_hash: revised.requirement_hash,
      },
      evaluation: {
        outcome: "pass",
        policy_hash: revised.policy_hash,
        requirement_hash: revised.requirement_hash,
        winning_witness: [
          {
            assertion_ids: ["assertion-2"],
            evidence_receipt_ids: ["receipt-2"],
            subject_key_id: "subject-2",
            binding_group_id: "binding-group-2",
          },
        ],
      },
      winning_provider_binding_hash: revised.provider_binding_hashes[0],
    });
    expect(recheckHandleNationalityQualification(input)).toEqual({
      kind: "rejected",
      reason: "qualification_changed",
    });
    expect(input.pin.eligibility.policy_hash).toBe(qualification.policy_hash);
  });

  test("freezes the nationality quote hash and keeps the eligibility arms disjoint", () => {
    const quoteInput = {
      quote_id: "quote_01",
      offering_id: "offering_free_02",
      offering_revision: 1,
      offering_hash: "a".repeat(64),
      sale_namespace_activation_id: "sale_namespace_activation_01",
      sale_namespace_activation_generation: 3,
      fulfillment_kind: "hosted_persona_v1" as const,
      owner_persona_id: "persona_public_01",
      family: "hns" as const,
      namespace_root: "charizard",
      handle_label: "longname",
      pricing: {
        kind: "free_v1" as const,
        pricing_id: "platform_free_handles_v1",
        pricing_revision: 1,
        pricing_hash: "b".repeat(64),
        atomic_amount: "0" as const,
      },
      quoted_at: "2026-09-13T12:00:00.000Z",
      expires_at: "2026-09-13T12:02:00.000Z",
    };
    const nationalityQuote = handleQuoteV3Hash({
      ...quoteInput,
      eligibility: {
        kind: "curated_nationality_v1",
        snapshot: snapshot({ evidence_use_ids: ["evidence_use_01"] }),
      },
    });
    expect(nationalityQuote.sha256).toBe(
      "a5ae039e90b5ed098220d773a375e62cd9304a602cb03f2093ff3f9fc34aecdd",
    );
    expect(nationalityQuote.bytes).toBe(801);
    expect(nationalityQuote.preimage).toStartWith('["pirate-handle-quote-v3",');
    expect(nationalityQuote.preimage).toContain('"curated_nationality_v1"');
    expect(nationalityQuote.preimage).toContain(qualification.provider_binding_hashes[0]);
    expect(nationalityQuote.preimage).not.toContain("US");
    const allowlistQuote = handleQuoteV3Hash({
      ...quoteInput,
      eligibility: {
        kind: "curated_policy_v1",
        snapshot: {
          decision: "passed",
          policy_revision: 7,
          policy_hash: "c".repeat(64),
          evidence_use_ids: ["evidence_use_01"],
          evaluated_at: "2026-09-13T12:00:00.000Z",
        },
      },
    });
    expect(allowlistQuote.sha256).toBe(
      "e7c6241af757b3416c6a8e5d512c02af9e4213533210e6f06f6df20409c14e86",
    );
    expect(allowlistQuote.sha256).not.toBe(nationalityQuote.sha256);
  });

  test("qualifies a fresh pass from the pinned selected provider", () => {
    expect(recheckHandleNationalityQualification(recheckInput())).toEqual({
      kind: "qualified",
    });
  });

  test("rejects stale offering, qualification, requirement, and provider pins", () => {
    expect(recheckHandleNationalityQualification(recheckInput({ offering_revision: 4 }))).toEqual({
      kind: "rejected",
      reason: "offering_changed",
    });
    expect(
      recheckHandleNationalityQualification(recheckInput({ offering_hash: "b".repeat(64) })),
    ).toEqual({ kind: "rejected", reason: "offering_changed" });
    expect(
      recheckHandleNationalityQualification(recheckInput({ current: { policy_revision: 2 } })),
    ).toEqual({ kind: "rejected", reason: "qualification_changed" });
    expect(
      recheckHandleNationalityQualification(
        recheckInput({
          evaluation: {
            outcome: "needs_evidence",
            reason: "requirement_changed",
            policy_hash: qualification.policy_hash,
            requirement_hash: qualification.requirement_hash,
          },
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "requirement_changed" });
    expect(
      recheckHandleNationalityQualification(
        recheckInput({ winning_provider_binding_hash: qualification.provider_binding_hashes[1] }),
      ),
    ).toEqual({ kind: "rejected", reason: "provider_binding_changed" });
  });

  test("rejects expired, revoked, missing, invalid, and indeterminate evidence", () => {
    for (const [reason, expected] of [
      ["expired", "evidence_expired"],
      ["revoked", "evidence_revoked"],
      ["missing", "evidence_missing"],
      ["provider_binding_changed", "provider_binding_changed"],
    ] as const) {
      expect(
        recheckHandleNationalityQualification(
          recheckInput({
            evaluation: {
              outcome: "needs_evidence",
              reason,
              policy_hash: qualification.policy_hash,
              requirement_hash: qualification.requirement_hash,
            },
          }),
        ),
      ).toEqual({ kind: "rejected", reason: expected });
    }
    expect(
      recheckHandleNationalityQualification(
        recheckInput({
          evaluation: { outcome: "fail", reason: "invalid_evidence" },
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "evidence_invalid" });
    expect(
      recheckHandleNationalityQualification(
        recheckInput({
          evaluation: {
            outcome: "indeterminate",
            reason: "evidence_store_unavailable",
            policy_hash: qualification.policy_hash,
            requirement_hash: qualification.requirement_hash,
          },
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "indeterminate" });
  });
});
