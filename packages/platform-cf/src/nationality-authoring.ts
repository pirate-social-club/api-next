import {
  type NationalityAuthoringProviderBinding,
  nationalityAuthoringProviderBindings,
} from "./verification/provider-registry.ts";

export type { NationalityAuthoringProviderBinding };

/**
 * The server-owned compilation input for a nationality-gated draft. It pins
 * the explicit lifetime and both provider alternatives; the draft supplies
 * only the allowlist. No value here is a default, so a disabled or absent
 * configuration leaves the capability fail-closed.
 */
export type NationalityAuthoring = Readonly<{
  readonly policy_revision: number;
  readonly evidence_lifetime: Readonly<{
    readonly kind: "max_age_seconds";
    readonly seconds: number;
  }>;
  readonly provider_bindings: readonly [
    NationalityAuthoringProviderBinding,
    NationalityAuthoringProviderBinding,
  ];
}>;

export type NationalityAuthoringInput = Readonly<{
  readonly enabled: boolean;
  readonly policyRevision: number | null;
  readonly evidenceLifetimeSeconds: number | null;
  readonly environment: string;
  readonly selfPass: Readonly<{ callbackOrigin: string; mockPassport: boolean }> | null;
  readonly zkPassport: Readonly<{ domain: string; devMode: boolean }> | null;
}>;

function canonical(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}

/**
 * Resolves the nationality authoring input from explicit server
 * configuration. A disabled capability resolves to null, which keeps
 * nationality-gated creation fail-closed. Enabling it requires every value,
 * including an explicit evidence lifetime; a partial or unsafe group is a
 * startup error rather than an invented default.
 *
 * The provider bindings are derived from the same options the runtime
 * Self Pass and ZKPassport adapters use, so a proof session's recorded
 * provider configuration matches the compiled policy binding.
 */
export function resolveNationalityAuthoring(
  input: NationalityAuthoringInput,
): NationalityAuthoring | null {
  if (!input.enabled) return null;
  if (
    input.policyRevision === null ||
    !Number.isSafeInteger(input.policyRevision) ||
    input.policyRevision < 1 ||
    input.evidenceLifetimeSeconds === null ||
    !Number.isSafeInteger(input.evidenceLifetimeSeconds) ||
    input.evidenceLifetimeSeconds < 1 ||
    !canonical(input.environment) ||
    input.selfPass === null ||
    input.zkPassport === null ||
    !canonical(input.selfPass.callbackOrigin) ||
    !canonical(input.zkPassport.domain)
  ) {
    throw new Error("Nationality authoring configuration is incomplete or invalid");
  }
  if (
    input.environment === "production" &&
    (input.selfPass.mockPassport || input.zkPassport.devMode)
  ) {
    throw new Error("Nationality authoring configuration is incomplete or invalid");
  }
  return {
    policy_revision: input.policyRevision,
    evidence_lifetime: { kind: "max_age_seconds", seconds: input.evidenceLifetimeSeconds },
    provider_bindings: nationalityAuthoringProviderBindings({
      environment: input.environment,
      self_pass: {
        callback_origin: input.selfPass.callbackOrigin,
        mock_passport: input.selfPass.mockPassport,
      },
      zkpassport: {
        domain: input.zkPassport.domain,
        dev_mode: input.zkPassport.devMode,
      },
    }),
  };
}
