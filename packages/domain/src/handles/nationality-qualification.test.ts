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
