// Provider-keyed identity evidence evaluation, ported pure from the old
// verification/provider-keyed-identity-evidence.ts. The SQL reader stays in
// the application layer; this module evaluates atoms over evidence values.

import { normalizeIdentityCountryCode } from "./country-codes";

export const PROVIDER_KEYED_EVIDENCE_CAPABILITIES = [
  "unique_human",
  "age_over_18",
  "minimum_age",
  "nationality",
  "gender",
] as const;

export type ProviderKeyedEvidenceCapability = (typeof PROVIDER_KEYED_EVIDENCE_CAPABILITIES)[number];

export type IdentityEvidence = {
  evidenceId: string;
  userId: string;
  capability: ProviderKeyedEvidenceCapability;
  provider: string;
  mechanism: string;
  value: unknown;
  verifiedAt: string;
  expiresAt: string | null;
  sourceVerificationSessionId: string | null;
  sourceIdentityNullifierId: string | null;
};

export type IdentityEvidenceAtom = {
  capability: ProviderKeyedEvidenceCapability;
  acceptedProviders: readonly string[];
  requiredCountries?: readonly string[];
  excludedCountries?: readonly string[];
  minimumAge?: number;
  requiredGender?: string;
  allowedGenders?: readonly string[];
};

export type IdentityEvidenceAtomEvaluation = {
  outcome: "passed" | "action_required" | "terminal_mismatch";
  witnesses: IdentityEvidence[];
  missingCapabilities: string[];
  mismatchReasons: string[];
};

function parseJsonValue(raw: unknown): unknown {
  if (raw == null || typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function valueRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function countryValue(evidence: IdentityEvidence): string | null {
  const value = valueRecord(evidence.value).nationality ?? evidence.value;
  return normalizeIdentityCountryCode(value);
}

function minimumAgeValue(evidence: IdentityEvidence): number | null {
  const value = valueRecord(evidence.value);
  if (evidence.capability === "age_over_18") return value.age_over_18 === true ? 18 : null;
  return typeof value.minimum_age === "number" && Number.isInteger(value.minimum_age)
    ? value.minimum_age
    : null;
}

function genderValue(evidence: IdentityEvidence): string | null {
  const value = valueRecord(evidence.value).gender ?? evidence.value;
  return typeof value === "string" ? value : null;
}

/** Return the canonical value used by policy evaluators and reward consumers. */
export function normalizeIdentityEvidenceValue(
  evidence: IdentityEvidence,
): string | number | boolean | null {
  switch (evidence.capability) {
    case "nationality":
      return countryValue(evidence);
    case "minimum_age":
      return minimumAgeValue(evidence);
    case "age_over_18": {
      const age = minimumAgeValue(evidence);
      return age != null && age >= 18;
    }
    case "gender":
      return genderValue(evidence);
    case "unique_human":
      return true;
  }
}

function normalizedCountries(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizeIdentityCountryCode(value))
    .filter((value): value is string => value !== null);
}

function matchesAtom(evidence: IdentityEvidence, atom: IdentityEvidenceAtom): boolean {
  if (!atom.acceptedProviders.includes(evidence.provider)) return false;
  switch (atom.capability) {
    case "unique_human":
      return true;
    case "nationality": {
      const country = countryValue(evidence);
      if (!country) return false;
      const required = normalizedCountries(atom.requiredCountries);
      const excluded = normalizedCountries(atom.excludedCountries);
      return (required.length === 0 || required.includes(country)) && !excluded.includes(country);
    }
    case "minimum_age":
      return (minimumAgeValue(evidence) ?? -1) >= (atom.minimumAge ?? Number.POSITIVE_INFINITY);
    case "age_over_18":
      return (minimumAgeValue(evidence) ?? -1) >= 18;
    case "gender":
      return (
        (atom.requiredGender == null || genderValue(evidence) === atom.requiredGender) &&
        (atom.allowedGenders == null || atom.allowedGenders.includes(genderValue(evidence) ?? ""))
      );
  }
}

/** Evaluate one atom using a single matching provider-keyed witness. */
export function evaluateIdentityEvidenceAtom(input: {
  evidence: readonly IdentityEvidence[];
  atom: IdentityEvidenceAtom;
}): IdentityEvidenceAtomEvaluation {
  const candidates = input.evidence.filter(
    (evidence) => evidence.capability === input.atom.capability,
  );
  const witnesses = candidates.filter((evidence) => matchesAtom(evidence, input.atom));
  if (witnesses.length > 0) {
    return { outcome: "passed", witnesses, missingCapabilities: [], mismatchReasons: [] };
  }
  const acceptedCandidates = candidates.filter((evidence) =>
    input.atom.acceptedProviders.includes(evidence.provider),
  );
  if (acceptedCandidates.length === 0 && candidates.length > 0) {
    return {
      outcome: "action_required",
      witnesses: [],
      missingCapabilities: [input.atom.capability],
      mismatchReasons: ["provider_not_accepted"],
    };
  }
  if (candidates.length === 0) {
    return {
      outcome: "action_required",
      witnesses: [],
      missingCapabilities: [input.atom.capability],
      mismatchReasons: [],
    };
  }
  return {
    outcome: "terminal_mismatch",
    witnesses: [],
    missingCapabilities: [],
    mismatchReasons: [
      input.atom.capability === "nationality" && (input.atom.requiredCountries?.length ?? 0) > 0
        ? "nationality_mismatch"
        : input.atom.capability === "nationality" && (input.atom.excludedCountries?.length ?? 0) > 0
          ? "nationality_excluded"
          : input.atom.capability === "minimum_age" || input.atom.capability === "age_over_18"
            ? "minimum_age_mismatch"
            : input.atom.capability === "gender"
              ? "gender_mismatch"
              : "provider_or_value_mismatch",
    ],
  };
}
