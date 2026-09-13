import { Schema } from "effect";
import { canonicalJson } from "../canonical-json.ts";
import { normalizeIdentityCountryAlpha2 } from "../gates/country-codes.ts";
import {
  NamedIssuerActionScope,
  NamedIssuerScope,
  ProviderConfigurationRef,
} from "../verification/claims.ts";
import { NationalityAllowedRequirement } from "../verification/requirements.ts";
import { Sha256Hex } from "../verification/scalars.ts";
import { sha256Hex } from "./sha256.ts";

const strict = { onExcessProperty: "error" } as const;
const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

/** Explicit no-age-limit is a policy choice, never the default for missing input. */
const EvidenceLifetime = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("no_age_limit") }),
  Schema.Struct({ kind: Schema.Literal("max_age_seconds"), seconds: PositiveInteger }),
]);

const ProviderBinding = Schema.Struct({
  provider_id: Schema.Literals(["self.pass", "zkpassport"]),
  provider_configuration: ProviderConfigurationRef,
  method: Schema.Literal("document"),
  protocol_version: Schema.NonEmptyString,
  scope: Schema.Union([NamedIssuerScope, NamedIssuerActionScope]),
  environment: Schema.NonEmptyString,
}).check(
  Schema.makeFilter((binding) =>
    binding.provider_configuration.kind === "dynamic" &&
    binding.scope.issuer === binding.provider_id &&
    binding.protocol_version ===
      (binding.provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2")
      ? undefined
      : "Expected the accepted document provider protocol and issuer binding",
  ),
);

const ProviderAlternatives = Schema.Tuple([ProviderBinding, ProviderBinding]).check(
  Schema.makeFilter((bindings) =>
    new Set(bindings.map((binding) => binding.provider_id)).size === 2
      ? undefined
      : "Expected both Self and ZKPassport alternatives",
  ),
);

const NationalityRequirement = NationalityAllowedRequirement.check(
  Schema.makeFilter((requirement) =>
    requirement.allowed_countries.every(
      (country) => normalizeIdentityCountryAlpha2(country) === country,
    ),
  ),
);

const PolicyFields = {
  policy_version_id: Schema.Literal("curated-nationality-v1"),
  policy_revision: PositiveInteger,
  requirement: NationalityRequirement,
  requirement_hash: Sha256Hex,
  required_assurance: Schema.Literal("document_zk"),
  evidence_lifetime: EvidenceLifetime,
  provider_bindings: ProviderAlternatives,
};

function requirementHash(requirement: Schema.Schema.Type<typeof NationalityRequirement>): string {
  return sha256Hex(canonicalJson({ requirement, version: "nationality-requirement-v1" }));
}

const PolicyShape = Schema.Struct(PolicyFields);

function policyHash(policy: Schema.Schema.Type<typeof PolicyShape>): string {
  return sha256Hex(
    canonicalJson({
      policy_version_id: policy.policy_version_id,
      policy_revision: policy.policy_revision,
      requirement: policy.requirement,
      requirement_hash: policy.requirement_hash,
      required_assurance: policy.required_assurance,
      evidence_lifetime: policy.evidence_lifetime,
      provider_bindings: policy.provider_bindings,
    }),
  );
}

/** A consuming policy pins lifetime and both alternatives separately from requirement identity. */
export const NationalityPolicy = Schema.Struct({ ...PolicyFields, policy_hash: Sha256Hex }).check(
  Schema.makeFilter((policy) =>
    policy.provider_bindings[0].provider_id === "self.pass" &&
    policy.provider_bindings[1].provider_id === "zkpassport" &&
    policy.requirement_hash === requirementHash(policy.requirement) &&
    policy.policy_hash === policyHash(policy)
      ? undefined
      : "Expected canonical nationality policy and requirement hashes",
  ),
);
export type NationalityPolicy = Schema.Schema.Type<typeof NationalityPolicy>;

const Authoring = Schema.Struct({
  policy_revision: PositiveInteger,
  allowed_countries: Schema.NonEmptyArray(Schema.NonEmptyString),
  evidence_lifetime: EvidenceLifetime,
  provider_bindings: ProviderAlternatives,
});

export type NationalityPolicyCompilation =
  | Readonly<{ kind: "compiled"; policy: NationalityPolicy }>
  | Readonly<{ kind: "unsupported"; reason: "invalid_policy" | "invalid_country" }>;

/** Server-side compilation; provider configurations must come from accepted provider planning. */
export function compileNationalityPolicy(input: unknown): NationalityPolicyCompilation {
  const decoded = Schema.decodeUnknownOption(Authoring, strict)(input);
  if (decoded._tag === "None") return { kind: "unsupported", reason: "invalid_policy" };
  const countries = new Set<string>();
  for (const value of decoded.value.allowed_countries) {
    const country = normalizeIdentityCountryAlpha2(value);
    if (country === null) return { kind: "unsupported", reason: "invalid_country" };
    countries.add(country);
  }
  const requirement = Schema.decodeUnknownOption(
    NationalityRequirement,
    strict,
  )({
    claim_id: "nationality.allowed",
    allowed_countries: [...countries].sort(),
  });
  if (requirement._tag === "None") return { kind: "unsupported", reason: "invalid_country" };
  const [first, second] = decoded.value.provider_bindings;
  const provider_bindings: NationalityPolicy["provider_bindings"] =
    first.provider_id === "self.pass" ? [first, second] : [second, first];
  const policy = {
    policy_version_id: "curated-nationality-v1" as const,
    policy_revision: decoded.value.policy_revision,
    requirement: requirement.value,
    requirement_hash: requirementHash(requirement.value),
    required_assurance: "document_zk" as const,
    evidence_lifetime: decoded.value.evidence_lifetime,
    provider_bindings,
  };
  return { kind: "compiled", policy: { ...policy, policy_hash: policyHash(policy) } };
}

export function nationalityCeremonyReservationHash(reservation: unknown): string {
  return sha256Hex(canonicalJson({ reservation, version: "nationality-ceremony-reservation-v1" }));
}
