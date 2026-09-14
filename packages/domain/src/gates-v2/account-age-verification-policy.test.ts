import { expect, test } from "bun:test";
import {
  ACCOUNT_AGE_18_REQUIREMENT_HASH,
  ACCOUNT_AGE_18_REQUIREMENTS,
  ageVerificationReservationHash,
  compileAccountAgeVerificationPolicy,
} from "./account-age-verification-policy.ts";
import { documentProviderBindingHash } from "./document-provider-binding.ts";
import { nationalityCeremonyReservationHash } from "./nationality-policy.ts";

const bindings = ["self.pass", "zkpassport"].map((provider_id) => ({
  provider_id,
  provider_configuration: { kind: "dynamic", reference: `fixture:${provider_id}`, version: "1" },
  method: "document",
  protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: provider_id,
    rp_scope: "pirate-social",
  },
  environment: "test",
}));

test("age requests exactly 18, subject uniqueness and a valid document without a membership claim", () => {
  expect(ACCOUNT_AGE_18_REQUIREMENTS).toEqual([
    { claim_id: "age.minimum", minimum_age: "18" },
    { claim_id: "credential.subject_unique" },
    { claim_id: "document.valid" },
  ]);
  const policy = compileAccountAgeVerificationPolicy(bindings);
  expect(policy?.provider_bindings.map((binding) => binding.provider_id)).toEqual([
    "self.pass",
    "zkpassport",
  ]);
  expect(compileAccountAgeVerificationPolicy([...bindings].reverse())).toEqual(policy);
  expect(policy).not.toHaveProperty("evidence_lifetime");
  expect(policy).not.toHaveProperty("allowed_countries");
});

test("fails closed for incomplete providers, protocol drift, action scopes and extra disclosure policy", () => {
  for (const input of [
    null,
    [],
    [bindings[0]],
    [bindings[0], bindings[0]],
    [{ ...bindings[0], protocol_version: "future" }, bindings[1]],
    [{ ...bindings[0], scope: { ...bindings[0]?.scope, rp_scope: "other" } }, bindings[1]],
    [{ ...bindings[0], allowed_countries: ["US"] }, bindings[1]],
    [
      {
        ...bindings[0],
        scope: {
          ...bindings[0]?.scope,
          scope_semantics: "issuer_rp_action_scope",
          action_scope: "community",
        },
      },
      bindings[1],
    ],
  ])
    expect(compileAccountAgeVerificationPolicy(input)).toBeNull();
});

test("configuration changes change the policy and binding pins, not the age requirement", () => {
  const old = compileAccountAgeVerificationPolicy(bindings);
  const changed = compileAccountAgeVerificationPolicy([
    {
      ...bindings[0],
      provider_configuration: { kind: "dynamic", reference: "fixture:rotated", version: "2" },
    },
    bindings[1],
  ]);
  if (old === null || changed === null) throw new Error("fixture did not compile");
  expect(changed.requirement_hash).toBe(ACCOUNT_AGE_18_REQUIREMENT_HASH);
  expect(changed.policy_hash).not.toBe(old.policy_hash);
  expect(documentProviderBindingHash(changed.provider_bindings[0])).not.toBe(
    documentProviderBindingHash(old.provider_bindings[0]),
  );
  expect(ageVerificationReservationHash({ actor_id: "account" })).not.toBe(
    nationalityCeremonyReservationHash({ actor_id: "account" }),
  );
});

test("age requirement and reservation hash preimages are frozen independently of nationality", () => {
  expect(ACCOUNT_AGE_18_REQUIREMENT_HASH).toBe(
    "e4c232a5facfa1f769e4022f4fef82e7090cfd848ae4d4dd41ea8f2d002e3c60",
  );
  expect(ageVerificationReservationHash({ actor_id: "account" })).toBe(
    "ee6a9b6f6e919c22e41c75aa7d4e7e52ae5abee2ce22239acd7b4a0980efdb32",
  );
});
