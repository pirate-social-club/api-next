import { Schema } from "effect";

export const BoundedIdentifier = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
      ? undefined
      : "Expected a bounded identifier",
  ),
);
export const IdempotencyKey = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
      ? undefined
      : "Expected a bounded idempotency key",
  ),
);
export const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected a lowercase SHA-256 digest",
  ),
);
export const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);
export const HnsRoot = Schema.String.check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).byteLength <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical HNS root",
  ),
);
