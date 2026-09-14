import { describe, expect, test } from "bun:test";
import { CURATED_HUMAN_MEMBERSHIP_POLICY } from "../gates-v2/human-membership-evaluator.ts";
import {
  COMMUNITY_GATE_COMPILER_V2_VERSION,
  compileCommunityGatePolicy,
  compileCommunityGatePolicyV2,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_CANONICAL_PREIMAGE,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  NATIONALITY_GATE_EVALUATOR_ID,
} from "./gate-policy-compiler.ts";

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

describe("community gate policy compiler", () => {
  test("pins the provider-neutral human gate to the curated evaluator and Very web binding", () => {
    const compilation = compileCommunityGatePolicy(humanPolicy);
    expect(compilation).toMatchObject({
      kind: "supported",
      canonical_policy_hash: "4ac57c1db6ca01acf054a096a06963716716647b676fa7be41bb45d4e70d3a46",
      provider_binding: {
        provider_id: "very.web",
        provider_configuration: { kind: "dynamic", reference: "very-web", version: "1" },
        method: "palm_web",
        protocol_version: "very-web-v1",
        scope: {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: "https://verify.very.org",
          rp_scope: "pirate-social",
        },
      },
      compiled_plan: {
        compiler_version: "community-gate-compiler-v1",
        evaluator: "curated-human-membership-v1",
      },
    });
  });

  test("pins the exact requirement preimage and hash independently of authoring metadata", () => {
    expect(HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_CANONICAL_PREIMAGE).toBe(
      '{"claims":[{"claim_id":"human.personhood"},{"claim_id":"credential.subject_unique"}],"method":"palm_web","provider_configuration":{"kind":"dynamic","reference":"very-web","version":"1"},"provider_id":"very.web","protocol_version":"very-web-v1","request_mode":"dynamic","scope":{"issuer":"https://verify.very.org","kind":"named","rp_scope":"pirate-social","scope_semantics":"issuer_rp_scope"},"subject_binding_intent":"establish","version":1}',
    );
    expect(HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH).toBe(
      "74aa0d8aba0e55428ad543e5a6127cb00c647410d29180aff83183c68e148677",
    );
    const first = compileCommunityGatePolicy(humanPolicy);
    const renamedPath = compileCommunityGatePolicy({
      ...humanPolicy,
      accessPaths: [{ ...humanPolicy.accessPaths[0], id: "another-ui-label" }],
    });
    expect(first).toMatchObject({ kind: "supported" });
    expect(renamedPath).toMatchObject({ kind: "supported" });
    if (first.kind !== "supported" || renamedPath.kind !== "supported") {
      throw new Error("expected supported compilations");
    }
    expect(renamedPath.verification_requirement_hash).toBe(first.verification_requirement_hash);
    expect(renamedPath.canonical_policy_hash).toBe(first.canonical_policy_hash);
  });

  test("fails closed for every unsupported or ambiguous authoring shape", () => {
    const candidates = [
      undefined,
      () => undefined,
      Symbol("unsupported"),
      1n,
      null,
      {},
      { ...humanPolicy, surprise: true },
      { ...humanPolicy, version: 2 },
      { ...humanPolicy, accessPaths: [] },
      { ...humanPolicy, accessPaths: [humanPolicy.accessPaths[0], humanPolicy.accessPaths[0]] },
      {
        ...humanPolicy,
        accessPaths: [{ ...humanPolicy.accessPaths[0], requirements: [] }],
      },
      {
        ...humanPolicy,
        accessPaths: [
          { ...humanPolicy.accessPaths[0], requirements: [{ requirement: "age-minimum" }] },
        ],
      },
      {
        ...humanPolicy,
        accessPaths: [
          {
            ...humanPolicy.accessPaths[0],
            requirements: [{ requirement: "human-verification", provider: "very.web" }],
          },
        ],
      },
    ];
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    candidates.push(cyclic);
    for (const candidate of candidates) {
      expect(compileCommunityGatePolicy(candidate)).toMatchObject({
        kind: "unsupported",
        canonical_policy_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        verification_requirement_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }
  });
});

const nationalityAuthoring = {
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

const composedPolicy = (
  allowedCountries: string[],
  order: "human-first" | "nationality-first",
) => ({
  version: 1,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and",
      requirements:
        order === "human-first"
          ? [
              { requirement: "human-verification" },
              { requirement: "nationality-allowed", allowedCountries },
            ]
          : [
              { requirement: "nationality-allowed", allowedCountries },
              { requirement: "human-verification" },
            ],
    },
  ],
});

describe("community gate policy compiler v2 composed path", () => {
  test("compiles palm and nationality into frozen human constants plus both provider alternatives", () => {
    const compilation = compileCommunityGatePolicyV2(
      composedPolicy(["US"], "human-first"),
      nationalityAuthoring,
    );
    expect(compilation).toMatchObject({
      kind: "supported",
      human_verification_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
      compiled_plan: {
        compiler_version: COMMUNITY_GATE_COMPILER_V2_VERSION,
        evaluators: ["curated-human-membership-v1", NATIONALITY_GATE_EVALUATOR_ID],
        nationality_provider_bindings: [
          { provider_id: "self.pass" },
          { provider_id: "zkpassport" },
        ],
      },
    });
    if (compilation.kind !== "supported") throw new Error("expected a supported compilation");
    expect(compilation.canonical_policy.human).toEqual(CURATED_HUMAN_MEMBERSHIP_POLICY);
    expect(compilation.canonical_policy.nationality.requirement).toEqual({
      claim_id: "nationality.allowed",
      allowed_countries: ["US"],
    });
    expect(compilation.canonical_policy_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_CANONICAL_PREIMAGE).toBe(
      '{"claims":[{"claim_id":"human.personhood"},{"claim_id":"credential.subject_unique"}],"method":"palm_web","provider_configuration":{"kind":"dynamic","reference":"very-web","version":"1"},"provider_id":"very.web","protocol_version":"very-web-v1","request_mode":"dynamic","scope":{"issuer":"https://verify.very.org","kind":"named","rp_scope":"pirate-social","scope_semantics":"issuer_rp_scope"},"subject_binding_intent":"establish","version":1}',
    );
  });

  test("authoring order is not policy identity and countries normalize before hashing", () => {
    const humanFirst = compileCommunityGatePolicyV2(
      composedPolicy(["us", "US"], "human-first"),
      nationalityAuthoring,
    );
    const nationalityFirst = compileCommunityGatePolicyV2(
      composedPolicy(["US", "us"], "nationality-first"),
      nationalityAuthoring,
    );
    expect(humanFirst).toEqual(nationalityFirst);
    if (humanFirst.kind !== "supported") throw new Error("expected a supported compilation");
    expect(humanFirst.canonical_policy.nationality.requirement.allowed_countries).toEqual(["US"]);
  });

  test("fails closed for every unsupported or ambiguous composed shape", () => {
    const candidates: readonly unknown[] = [
      undefined,
      null,
      {},
      humanPolicy,
      composedPolicy([], "human-first"),
      composedPolicy(["US"], "human-first").accessPaths[0]?.requirements[0],
      { ...composedPolicy(["US"], "human-first"), version: 2 },
      {
        ...composedPolicy(["US"], "human-first"),
        accessPaths: [
          {
            ...composedPolicy(["US"], "human-first").accessPaths[0],
            requirements: [
              { requirement: "human-verification" },
              { requirement: "human-verification" },
            ],
          },
        ],
      },
      {
        ...composedPolicy(["US"], "human-first"),
        accessPaths: [
          {
            ...composedPolicy(["US"], "human-first").accessPaths[0],
            requirements: [
              { requirement: "nationality-allowed", allowedCountries: ["US"] },
              { requirement: "nationality-allowed", allowedCountries: ["CA"] },
            ],
          },
        ],
      },
      {
        ...composedPolicy(["US"], "human-first"),
        accessPaths: [
          {
            ...composedPolicy(["US"], "human-first").accessPaths[0],
            requirements: [
              { requirement: "human-verification" },
              { requirement: "nationality-allowed", allowedCountries: ["US"], exclusions: [] },
            ],
          },
        ],
      },
    ];
    for (const candidate of candidates) {
      expect(compileCommunityGatePolicyV2(candidate, nationalityAuthoring)).toMatchObject({
        kind: "unsupported",
        reason: "invalid_policy",
        canonical_policy_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }
  });

  test("separates invalid countries from invalid nationality authoring", () => {
    expect(
      compileCommunityGatePolicyV2(composedPolicy(["ZZ"], "human-first"), nationalityAuthoring),
    ).toMatchObject({ kind: "unsupported", reason: "invalid_country" });
    expect(
      compileCommunityGatePolicyV2(composedPolicy(["US"], "human-first"), {
        ...nationalityAuthoring,
        evidence_lifetime: undefined,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "invalid_nationality_authoring" });
    expect(
      compileCommunityGatePolicyV2(composedPolicy(["US"], "human-first"), {
        ...nationalityAuthoring,
        provider_bindings: nationalityAuthoring.provider_bindings.slice(0, 1),
      }),
    ).toMatchObject({ kind: "unsupported", reason: "invalid_nationality_authoring" });
    expect(compileCommunityGatePolicyV2(composedPolicy(["US"], "human-first"), null)).toMatchObject(
      {
        kind: "unsupported",
        reason: "invalid_nationality_authoring",
      },
    );
  });
});
