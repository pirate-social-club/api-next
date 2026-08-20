import { describe, expect, test } from "bun:test";
import {
  compileCommunityGatePolicy,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_CANONICAL_PREIMAGE,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
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
  test("pins the provider-neutral human gate to the curated evaluator and Very OAuth binding", () => {
    const compilation = compileCommunityGatePolicy(humanPolicy);
    expect(compilation).toMatchObject({
      kind: "supported",
      canonical_policy_hash: "4ac57c1db6ca01acf054a096a06963716716647b676fa7be41bb45d4e70d3a46",
      provider_binding: {
        provider_id: "very.oauth",
        provider_configuration: { kind: "dynamic", reference: "very-oauth", version: "1" },
        method: "palm_oauth",
        protocol_version: "oauth2-oidc-v1",
        scope: {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: "https://connect.very.org",
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
      '{"claims":[{"claim_id":"human.personhood"},{"claim_id":"credential.subject_unique"}],"method":"palm_oauth","provider_configuration":{"kind":"dynamic","reference":"very-oauth","version":"1"},"provider_id":"very.oauth","protocol_version":"oauth2-oidc-v1","request_mode":"dynamic","scope":{"issuer":"https://connect.very.org","kind":"named","rp_scope":"pirate-social","scope_semantics":"issuer_rp_scope"},"subject_binding_intent":"establish","version":1}',
    );
    expect(HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH).toBe(
      "4d2098fbf5884abfaa1571739897f260422ed70318f4a98368392a38f796151d",
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
            requirements: [{ requirement: "human-verification", provider: "very.oauth" }],
          },
        ],
      },
    ];
    for (const candidate of candidates) {
      expect(compileCommunityGatePolicy(candidate)).toEqual({ kind: "unsupported" });
    }
  });
});
