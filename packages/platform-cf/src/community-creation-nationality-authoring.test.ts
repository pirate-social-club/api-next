import { describe, expect, test } from "bun:test";
import { compileOptionalRouteDraft } from "./community-creation-repository.ts";

const humanPolicy = {
  version: 1,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and",
      requirements: [{ requirement: "human-verification" }],
    },
  ],
};

const composedPolicy = {
  version: 1,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and",
      requirements: [
        { requirement: "human-verification" },
        { requirement: "nationality-allowed", allowedCountries: ["us", "US"] },
      ],
    },
  ],
};

const authoring = {
  policy_revision: 1,
  evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 },
  provider_bindings: ["self.pass", "zkpassport"].map((provider_id) => ({
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
  })),
};

describe("community creation nationality authoring", () => {
  test("human-only drafts keep the v1 path and ignore authoring input", () => {
    const withoutAuthoring = compileOptionalRouteDraft(humanPolicy);
    const withAuthoring = compileOptionalRouteDraft(humanPolicy, authoring);
    expect(withoutAuthoring).toMatchObject({
      status: "verification_required",
      canonicalPolicyHash: "4ac57c1db6ca01acf054a096a06963716716647b676fa7be41bb45d4e70d3a46",
    });
    expect(withoutAuthoring?.nationality).toBeUndefined();
    expect(withAuthoring).toEqual(withoutAuthoring);
  });

  test("a nationality draft without authoring fails closed", () => {
    expect(compileOptionalRouteDraft(composedPolicy, undefined)).toMatchObject({
      status: "gate_unsupported",
    });
    expect(
      compileOptionalRouteDraft(composedPolicy, {
        ...authoring,
        evidence_lifetime: undefined,
      }),
    ).toMatchObject({ status: "gate_unsupported" });
    expect(
      compileOptionalRouteDraft(composedPolicy, {
        ...authoring,
        provider_bindings: authoring.provider_bindings.slice(0, 1),
      }),
    ).toMatchObject({ status: "gate_unsupported" });
  });

  test("a nationality draft with authoring compiles with both providers and a persisted plan", () => {
    const compiled = compileOptionalRouteDraft(composedPolicy, authoring);
    expect(compiled).not.toBeNull();
    if (compiled === null) throw new Error("expected a compiled draft");
    expect(compiled.status).toBe("verification_required");
    expect(compiled.nationality?.requirementHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled.nationality?.providerBindings.map((binding) => binding.provider_id)).toEqual([
      "self.pass",
      "zkpassport",
    ]);
    expect(compiled.nationality?.policy.requirement.allowed_countries).toEqual(["US"]);
    const plan = JSON.parse(compiled.nationality?.compiledPlan ?? "null") as {
      readonly compiler_version?: unknown;
      readonly evaluators?: unknown;
    };
    expect(plan.compiler_version).toBe("community-gate-compiler-v2");
    expect(plan.evaluators).toEqual(["curated-human-membership-v1", "curated-nationality-v1"]);
  });

  test("an invalid country fails closed without inventing a policy", () => {
    const invalid = structuredClone(composedPolicy);
    if (invalid.accessPaths[0]?.requirements[1] !== undefined) {
      invalid.accessPaths[0].requirements[1] = {
        requirement: "nationality-allowed",
        allowedCountries: ["ZZ"],
      };
    }
    expect(compileOptionalRouteDraft(invalid, authoring)).toMatchObject({
      status: "gate_unsupported",
    });
  });
});
