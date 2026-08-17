import { Schema } from "effect";

/** Lower-case, unprefixed SHA-256 digest. */
export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export type Sha256Hex = Schema.Schema.Type<typeof Sha256Hex>;

/** Canonical non-negative base-10 integer with no sign or leading zeroes. */
export const NonNegativeIntegerString = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u),
);
export type NonNegativeIntegerString = Schema.Schema.Type<typeof NonNegativeIntegerString>;

/**
 * Wire-format instant used by the verification kernel. The fixed UTC and
 * millisecond representation keeps equality and hashing deterministic.
 */
export const CanonicalIsoInstant = Schema.String.check(
  Schema.isPattern(
    /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u,
  ),
  Schema.makeFilter((value) => {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) && instant.toISOString() === value
      ? undefined
      : "Expected a real canonical UTC instant";
  }),
);
export type CanonicalIsoInstant = Schema.Schema.Type<typeof CanonicalIsoInstant>;

export const Iso3166Alpha2 = Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u));
export type Iso3166Alpha2 = Schema.Schema.Type<typeof Iso3166Alpha2>;

export const DocumentGenderMarker = Schema.Literals(["female", "male", "unspecified"]);
export type DocumentGenderMarker = Schema.Schema.Type<typeof DocumentGenderMarker>;
