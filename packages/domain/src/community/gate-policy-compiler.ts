import { canonicalJson } from "../canonical-json.ts";
import { CURATED_HUMAN_MEMBERSHIP_POLICY } from "../gates-v2/human-membership-evaluator.ts";
import type { NationalityPolicy } from "../gates-v2/nationality-policy.ts";
import { compileNationalityPolicy } from "../gates-v2/nationality-policy.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";

export const COMMUNITY_GATE_COMPILER_VERSION = "community-gate-compiler-v1" as const;
export const VERY_WEB_PROVIDER_ID = "very.web" as const;
export const VERY_WEB_ISSUER = "https://verify.very.org" as const;
export const VERY_WEB_METHOD = "palm_web" as const;
export const VERY_WEB_PROTOCOL_VERSION = "very-web-v1" as const;
export const VERY_WEB_RP_SCOPE = "pirate-social" as const;
export const VERY_WEB_CONFIGURATION_REFERENCE = "very-web" as const;
export const VERY_WEB_CONFIGURATION_VERSION = "1" as const;

export const HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_CANONICAL_PREIMAGE =
  '{"claims":[{"claim_id":"human.personhood"},{"claim_id":"credential.subject_unique"}],"method":"palm_web","provider_configuration":{"kind":"dynamic","reference":"very-web","version":"1"},"provider_id":"very.web","protocol_version":"very-web-v1","request_mode":"dynamic","scope":{"issuer":"https://verify.very.org","kind":"named","rp_scope":"pirate-social","scope_semantics":"issuer_rp_scope"},"subject_binding_intent":"establish","version":1}' as const;

export const HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH = sha256Hex(
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_CANONICAL_PREIMAGE,
);

export type CommunityGateProviderBinding = Readonly<{
  readonly provider_id: typeof VERY_WEB_PROVIDER_ID;
  readonly provider_configuration: Readonly<{
    readonly kind: "dynamic";
    readonly reference: typeof VERY_WEB_CONFIGURATION_REFERENCE;
    readonly version: typeof VERY_WEB_CONFIGURATION_VERSION;
  }>;
  readonly method: typeof VERY_WEB_METHOD;
  readonly protocol_version: typeof VERY_WEB_PROTOCOL_VERSION;
  readonly scope: Readonly<{
    readonly kind: "named";
    readonly scope_semantics: "issuer_rp_scope";
    readonly issuer: typeof VERY_WEB_ISSUER;
    readonly rp_scope: typeof VERY_WEB_RP_SCOPE;
  }>;
}>;

export type SupportedCommunityGateCompilation = Readonly<{
  readonly kind: "supported";
  readonly canonical_policy: typeof CURATED_HUMAN_MEMBERSHIP_POLICY;
  readonly canonical_policy_hash: string;
  readonly verification_requirement_hash: string;
  readonly provider_binding: CommunityGateProviderBinding;
  readonly compiled_plan: Readonly<{
    readonly compiler_version: typeof COMMUNITY_GATE_COMPILER_VERSION;
    readonly evaluator: "curated-human-membership-v1";
    readonly provider_binding: CommunityGateProviderBinding;
  }>;
}>;

export type CommunityGateCompilation =
  | SupportedCommunityGateCompilation
  | Readonly<{
      readonly kind: "unsupported";
      /** Audit hashes for the rejected authoring shape; never an executable policy binding. */
      readonly canonical_policy_hash: string;
      readonly verification_requirement_hash: string;
    }>;

const EXACT_POLICY_KEYS = ["version", "accessPaths"];
const EXACT_PATH_KEYS = ["id", "operator", "requirements"];

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsupportedCompilation(
  value: unknown,
): Extract<CommunityGateCompilation, { kind: "unsupported" }> {
  let policyPreimage: string;
  try {
    policyPreimage = canonicalJson(value);
  } catch {
    policyPreimage = canonicalJson({
      kind: "unsupported_non_json_input",
      type: value === null ? "null" : typeof value,
      version: 1,
    });
  }
  return {
    kind: "unsupported",
    canonical_policy_hash: sha256Hex(policyPreimage),
    verification_requirement_hash: sha256Hex(
      canonicalJson({ kind: "unsupported", policy_hash: sha256Hex(policyPreimage), version: 1 }),
    ),
  };
}

function supportedHumanPolicy(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, EXACT_POLICY_KEYS)) return false;
  if (value.version !== 1 || !Array.isArray(value.accessPaths) || value.accessPaths.length !== 1) {
    return false;
  }
  const path = value.accessPaths[0];
  if (!isRecord(path) || !exactKeys(path, EXACT_PATH_KEYS)) return false;
  if (
    typeof path.id !== "string" ||
    path.id.length === 0 ||
    path.id.trim() !== path.id ||
    path.operator !== "and" ||
    !Array.isArray(path.requirements) ||
    path.requirements.length !== 1
  ) {
    return false;
  }
  const requirement = path.requirements[0];
  return (
    isRecord(requirement) &&
    exactKeys(requirement, ["requirement"]) &&
    requirement.requirement === "human-verification"
  );
}

function providerBinding(): CommunityGateProviderBinding {
  return {
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    method: VERY_WEB_METHOD,
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
  };
}

/** Resolves provider-neutral wizard policy into one pinned v1 evaluator/binding. */
export function compileCommunityGatePolicy(value: unknown): CommunityGateCompilation {
  if (!supportedHumanPolicy(value)) return unsupportedCompilation(value);
  const binding = providerBinding();
  return {
    kind: "supported",
    canonical_policy: CURATED_HUMAN_MEMBERSHIP_POLICY,
    canonical_policy_hash: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
    verification_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    provider_binding: binding,
    compiled_plan: {
      compiler_version: COMMUNITY_GATE_COMPILER_VERSION,
      evaluator: "curated-human-membership-v1",
      provider_binding: binding,
    },
  };
}

export const COMMUNITY_GATE_COMPILER_V2_VERSION = "community-gate-compiler-v2" as const;
export const NATIONALITY_GATE_EVALUATOR_ID = "curated-nationality-v1" as const;

export type ComposedCommunityGateCompilation =
  | Readonly<{
      readonly kind: "supported";
      readonly canonical_policy: Readonly<{
        readonly human: typeof CURATED_HUMAN_MEMBERSHIP_POLICY;
        readonly nationality: NationalityPolicy;
      }>;
      readonly canonical_policy_hash: string;
      readonly human_verification_requirement_hash: string;
      readonly human_provider_binding: CommunityGateProviderBinding;
      readonly compiled_plan: Readonly<{
        readonly compiler_version: typeof COMMUNITY_GATE_COMPILER_V2_VERSION;
        readonly evaluators: readonly [
          "curated-human-membership-v1",
          typeof NATIONALITY_GATE_EVALUATOR_ID,
        ];
        readonly human_provider_binding: CommunityGateProviderBinding;
        readonly nationality_policy_hash: string;
        readonly nationality_requirement_hash: string;
        readonly nationality_provider_bindings: NationalityPolicy["provider_bindings"];
      }>;
    }>
  | Readonly<{
      readonly kind: "unsupported";
      readonly reason: "invalid_policy" | "invalid_country" | "invalid_nationality_authoring";
      readonly canonical_policy_hash: string;
      readonly verification_requirement_hash: string;
    }>;

const EXACT_NATIONALITY_REQUIREMENT_KEYS = ["requirement", "allowedCountries"];

function composedRequirements(
  value: unknown,
):
  | { readonly kind: "human" }
  | { readonly kind: "nationality"; readonly countries: string[] }
  | null {
  if (!isRecord(value) || !exactKeys(value, EXACT_POLICY_KEYS)) return null;
  if (value.version !== 1 || !Array.isArray(value.accessPaths) || value.accessPaths.length !== 1) {
    return null;
  }
  const path = value.accessPaths[0];
  if (!isRecord(path) || !exactKeys(path, EXACT_PATH_KEYS)) return null;
  if (
    typeof path.id !== "string" ||
    path.id.length === 0 ||
    path.id.trim() !== path.id ||
    path.operator !== "and" ||
    !Array.isArray(path.requirements) ||
    path.requirements.length !== 2
  ) {
    return null;
  }
  let human = false;
  let nationality: string[] | null = null;
  for (const requirement of path.requirements) {
    if (isRecord(requirement) && exactKeys(requirement, ["requirement"])) {
      if (requirement.requirement === "human-verification") {
        if (human) return null;
        human = true;
        continue;
      }
    }
    if (
      isRecord(requirement) &&
      exactKeys(requirement, EXACT_NATIONALITY_REQUIREMENT_KEYS) &&
      requirement.requirement === "nationality-allowed" &&
      Array.isArray(requirement.allowedCountries) &&
      requirement.allowedCountries.length > 0 &&
      requirement.allowedCountries.every(
        (country) => typeof country === "string" && country.length > 0,
      )
    ) {
      if (nationality !== null) return null;
      nationality = requirement.allowedCountries as string[];
      continue;
    }
    return null;
  }
  if (!human) return null;
  if (nationality === null) return { kind: "human" };
  return { kind: "nationality", countries: nationality };
}

/**
 * Resolves the composed palm-and-nationality wizard policy into the frozen v1
 * human constants plus a freshly compiled nationality policy. Authoring order
 * of the two requirements is not policy identity. The v1 single-requirement
 * path stays on `compileCommunityGatePolicy`; this successor never weakens it.
 */
export function compileCommunityGatePolicyV2(
  value: unknown,
  nationalityAuthoring: unknown,
): ComposedCommunityGateCompilation {
  const requirements = composedRequirements(value);
  if (requirements === null || requirements.kind !== "nationality") {
    return { ...unsupportedCompilation(value), reason: "invalid_policy" };
  }
  if (!isRecord(nationalityAuthoring)) {
    return { ...unsupportedCompilation(value), reason: "invalid_nationality_authoring" };
  }
  const compilation = compileNationalityPolicy({
    ...nationalityAuthoring,
    allowed_countries: requirements.countries,
  });
  if (compilation.kind === "unsupported") {
    return {
      ...unsupportedCompilation(value),
      reason:
        compilation.reason === "invalid_country"
          ? "invalid_country"
          : "invalid_nationality_authoring",
    };
  }
  const nationality = compilation.policy;
  const binding = providerBinding();
  const canonicalPolicy = {
    human: CURATED_HUMAN_MEMBERSHIP_POLICY,
    nationality,
  };
  return {
    kind: "supported",
    canonical_policy: canonicalPolicy,
    canonical_policy_hash: sha256Hex(canonicalJson(canonicalPolicy)),
    human_verification_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    human_provider_binding: binding,
    compiled_plan: {
      compiler_version: COMMUNITY_GATE_COMPILER_V2_VERSION,
      evaluators: ["curated-human-membership-v1", NATIONALITY_GATE_EVALUATOR_ID],
      human_provider_binding: binding,
      nationality_policy_hash: nationality.policy_hash,
      nationality_requirement_hash: nationality.requirement_hash,
      nationality_provider_bindings: nationality.provider_bindings,
    },
  };
}
