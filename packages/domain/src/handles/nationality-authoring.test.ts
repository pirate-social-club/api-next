import { expect, test } from "bun:test";
import { compileNationalityPolicy } from "../gates-v2/nationality-policy.ts";
import {
  handleNationalityAuthoringReference,
  handleNationalityPolicyAuthoringRequestHash,
} from "./nationality-authoring.ts";

const authoring = {
  policy_revision: 1,
  evidence_lifetime: { kind: "max_age_seconds", seconds: 31_536_000 },
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

test("freezes the server authoring reference independently of provider order", () => {
  const ref = handleNationalityAuthoringReference(authoring);
  expect(ref).toBe("f4df1fbea5cce31823add1fed39006d37e866d769a51feef60d67ea2f77ef6ae");
  expect(
    handleNationalityAuthoringReference({
      ...authoring,
      provider_bindings: [...authoring.provider_bindings].reverse(),
    }),
  ).toBe(ref);
  for (const change of [
    { policy_revision: 2 },
    { evidence_lifetime: { kind: "max_age_seconds", seconds: 1 } },
    {
      provider_bindings: authoring.provider_bindings.map((binding) => ({
        ...binding,
        environment: "other",
      })),
    },
  ]) {
    expect(handleNationalityAuthoringReference({ ...authoring, ...change })).not.toBe(ref);
  }
});

test("refuses disabled, incomplete, unlimited and caller-expanded authoring inputs", () => {
  for (const input of [
    null,
    {},
    { ...authoring, evidence_lifetime: undefined },
    { ...authoring, evidence_lifetime: { kind: "no_age_limit" } },
    { ...authoring, provider_bindings: authoring.provider_bindings.slice(0, 1) },
    { ...authoring, allowed_countries: ["US"] },
  ]) {
    expect(() => handleNationalityAuthoringReference(input)).toThrow();
  }
});

test("freezes the command hash with account, group, normalized requirement and server context", () => {
  const result = compileNationalityPolicy({ ...authoring, allowed_countries: ["USA", "US"] });
  if (result.kind !== "compiled") throw new Error("Fixture did not compile");
  const input = {
    actor_account_id: "seller",
    community_id: "group",
    idempotency_key: "command-1",
    authoring_reference: handleNationalityAuthoringReference(authoring),
    requirement: result.policy.requirement,
  };
  expect(handleNationalityPolicyAuthoringRequestHash(input)).toBe(
    "574fd26158f4a490055d3d7e21ce94e1c43a479ef356a7326537ad2077e62a1d",
  );
  for (const change of [
    { actor_account_id: "other" },
    { community_id: "other" },
    { idempotency_key: "other" },
    { authoring_reference: "a".repeat(64) },
    { requirement: { claim_id: "nationality.allowed", allowed_countries: ["CA"] } },
  ]) {
    expect(handleNationalityPolicyAuthoringRequestHash({ ...input, ...change })).not.toBe(
      handleNationalityPolicyAuthoringRequestHash(input),
    );
  }
});
