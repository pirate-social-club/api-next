import { describe, expect, test } from "bun:test";
import { compileOptionalRouteDraft } from "./community-creation-repository.ts";
import { resolveNationalityAuthoring } from "./nationality-authoring.ts";

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

const complete = {
  enabled: true,
  policyRevision: 3,
  evidenceLifetimeSeconds: 3_600,
  environment: "staging",
  selfPass: { callbackOrigin: "https://api.pirate.test", mockPassport: false },
  zkPassport: { domain: "pirate.test", devMode: false },
} as const;

describe("nationality authoring resolution", () => {
  test("disabled resolves to no authoring and keeps the capability closed", () => {
    expect(resolveNationalityAuthoring({ ...complete, enabled: false })).toBeNull();
    expect(
      resolveNationalityAuthoring({
        ...complete,
        enabled: false,
        evidenceLifetimeSeconds: null,
        selfPass: null,
        zkPassport: null,
      }),
    ).toBeNull();
  });

  test("enabling requires the explicit lifetime, revision, environment, and both providers", () => {
    for (const override of [
      { policyRevision: null },
      { policyRevision: 0 },
      { evidenceLifetimeSeconds: null },
      { evidenceLifetimeSeconds: 0 },
      { environment: "" },
      { environment: " staging" },
      { selfPass: null },
      { zkPassport: null },
      { selfPass: { callbackOrigin: "", mockPassport: false } },
      { zkPassport: { domain: " pirate.test", devMode: false } },
    ]) {
      expect(() => resolveNationalityAuthoring({ ...complete, ...override })).toThrow(
        "Nationality authoring configuration is incomplete or invalid",
      );
    }
  });

  test("production refuses mock and development provider postures", () => {
    expect(() =>
      resolveNationalityAuthoring({
        ...complete,
        environment: "production",
        selfPass: { callbackOrigin: "https://api.pirate.test", mockPassport: true },
      }),
    ).toThrow("Nationality authoring configuration is incomplete or invalid");
    expect(() =>
      resolveNationalityAuthoring({
        ...complete,
        environment: "production",
        zkPassport: { domain: "pirate.test", devMode: true },
      }),
    ).toThrow("Nationality authoring configuration is incomplete or invalid");
  });

  test("the approved one-year lifetime is explicit and missing input remains closed", () => {
    const authoring = resolveNationalityAuthoring({
      ...complete,
      evidenceLifetimeSeconds: 31_536_000,
    });
    const compiled = compileOptionalRouteDraft(composedPolicy, authoring);
    expect(authoring?.evidence_lifetime).toEqual({
      kind: "max_age_seconds",
      seconds: 31_536_000,
    });
    expect(compiled?.status).toBe("verification_required");
    expect(compiled?.nationality).not.toBeNull();
    expect(() =>
      resolveNationalityAuthoring({ ...complete, evidenceLifetimeSeconds: null }),
    ).toThrow("Nationality authoring configuration is incomplete or invalid");
  });

  test("a complete group compiles the draft with both provider alternatives", () => {
    const authoring = resolveNationalityAuthoring(complete);
    expect(authoring).toMatchObject({
      policy_revision: 3,
      evidence_lifetime: { kind: "max_age_seconds", seconds: 3_600 },
    });
    expect(authoring?.provider_bindings.map((binding) => binding.provider_id)).toEqual([
      "self.pass",
      "zkpassport",
    ]);
    const compiled = compileOptionalRouteDraft(composedPolicy, authoring);
    expect(compiled).not.toBeNull();
    expect(compiled?.status).toBe("verification_required");
    expect(compiled?.nationality?.requirementHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled?.nationality?.providerBindings).toEqual(authoring?.provider_bindings);
  });
});
