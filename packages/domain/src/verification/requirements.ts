import { Schema } from "effect";
import { AssetDescriptor } from "./assets.ts";
import type { CanonicalClaimIdentifier } from "./claims.ts";
import { DocumentGenderMarker, Iso3166Alpha2, NonNegativeIntegerString } from "./scalars.ts";

const FixedVerificationRequirement = Schema.Union([
  Schema.Struct({ claim_id: Schema.Literal("human.live") }),
  Schema.Struct({ claim_id: Schema.Literal("human.personhood") }),
  Schema.Struct({ claim_id: Schema.Literal("human.unique") }),
  Schema.Struct({ claim_id: Schema.Literal("credential.subject_unique") }),
  Schema.Struct({ claim_id: Schema.Literal("document.valid") }),
  Schema.Struct({ claim_id: Schema.Literal("document.holder_bound") }),
]);

const AgeMinimumRequirement = Schema.Struct({
  claim_id: Schema.Literal("age.minimum"),
  minimum_age: NonNegativeIntegerString.check(
    Schema.makeFilter((value) =>
      BigInt(value) <= 150n ? undefined : "Expected an age no greater than 150",
    ),
  ),
});

const NationalityAllowedRequirement = Schema.Struct({
  claim_id: Schema.Literal("nationality.allowed"),
  allowed_countries: Schema.NonEmptyArray(Iso3166Alpha2).check(
    Schema.makeFilter((countries) =>
      new Set(countries).size === countries.length
        ? undefined
        : "Expected distinct nationality country codes",
    ),
    Schema.makeFilter((countries) => {
      const ordered = countries.every((country, index) => {
        const previous = countries[index - 1];
        return previous === undefined || previous < country;
      });
      return ordered ? undefined : "Expected nationality country codes in canonical order";
    }),
  ),
});

const GenderMarkerRequirement = Schema.Struct({
  claim_id: Schema.Literal("gender.marker"),
  allowed_markers: Schema.NonEmptyArray(DocumentGenderMarker).check(
    Schema.makeFilter((markers) =>
      new Set(markers).size === markers.length ? undefined : "Expected distinct gender markers",
    ),
    Schema.makeFilter((markers) => {
      const ordered = markers.every((marker, index) => {
        const previous = markers[index - 1];
        return previous === undefined || previous < marker;
      });
      return ordered ? undefined : "Expected gender markers in canonical order";
    }),
  ),
});

const AssetOwnershipRequirement = Schema.Struct({
  claim_id: Schema.Literal("asset.ownership"),
  descriptor: AssetDescriptor,
  minimum_quantity: NonNegativeIntegerString,
});

const DisclosedPredicateRequirement = Schema.Struct({
  claim_id: Schema.Literal("disclosed.predicate"),
  predicate: Schema.NonEmptyString,
  expected_value: Schema.Json,
});

/**
 * A requirement is the canonical, provider-neutral request bound to a proof
 * session. Claim identifiers alone are insufficient: the threshold or
 * accepted set is part of what the provider must prove.
 */
export const VerificationRequirement = Schema.Union([
  FixedVerificationRequirement,
  AgeMinimumRequirement,
  NationalityAllowedRequirement,
  GenderMarkerRequirement,
  AssetOwnershipRequirement,
  DisclosedPredicateRequirement,
]);
export type VerificationRequirement = Schema.Schema.Type<typeof VerificationRequirement>;

function requirementSortKey(requirement: VerificationRequirement): string {
  return `${requirement.claim_id}:${JSON.stringify(requirement)}`;
}

function sortNonEmpty<T extends string>(values: readonly [T, ...T[]]): readonly [T, ...T[]] {
  const sorted = [...values].sort();
  const first = sorted.shift();
  return first === undefined ? values : [first, ...sorted];
}

export function verificationRequirementClaimIds(
  requirements: readonly VerificationRequirement[],
): readonly CanonicalClaimIdentifier[] {
  return requirements.map((requirement) => requirement.claim_id);
}

export function canonicalizeVerificationRequirements(
  requirements: readonly VerificationRequirement[],
): readonly VerificationRequirement[] {
  return requirements
    .map((requirement): VerificationRequirement => {
      if (requirement.claim_id === "nationality.allowed") {
        return {
          ...requirement,
          allowed_countries: sortNonEmpty(requirement.allowed_countries),
        };
      }
      if (requirement.claim_id === "gender.marker") {
        return {
          ...requirement,
          allowed_markers: sortNonEmpty(requirement.allowed_markers),
        };
      }
      return requirement;
    })
    .sort((left, right) => requirementSortKey(left).localeCompare(requirementSortKey(right)));
}

export const VerificationRequirements = Schema.NonEmptyArray(VerificationRequirement).check(
  Schema.makeFilter((requirements) =>
    new Set(requirements.map((requirement) => requirement.claim_id)).size === requirements.length
      ? undefined
      : "Expected one requirement per claim identifier",
  ),
  Schema.makeFilter((requirements) => {
    const canonical = canonicalizeVerificationRequirements(requirements);
    return JSON.stringify(requirements) === JSON.stringify(canonical)
      ? undefined
      : "Expected requirements in canonical order";
  }),
);
export type VerificationRequirements = Schema.Schema.Type<typeof VerificationRequirements>;

export function sameVerificationRequirements(
  left: readonly VerificationRequirement[],
  right: readonly VerificationRequirement[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
