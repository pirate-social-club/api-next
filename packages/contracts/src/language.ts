import { Schema } from "effect";

export const LANGUAGE_MATCH_POLICY_V1 = "exact-script-region-fallback-v1" as const;

const canonicalLanguageTag = (value: string): string | null => {
  if (value.length === 0 || value.length > 64 || value !== value.trim()) return null;
  const subtags = value.split("-");
  if (
    !/^[a-z]{2,3}$/u.test(subtags[0] ?? "") ||
    subtags.slice(1).some((part) => part.length === 1)
  ) {
    return null;
  }

  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
};

/** Canonical BCP 47 language tag shared by every persisted and wire language role. */
export const LanguageTagV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    canonicalLanguageTag(value) === value
      ? undefined
      : "Expected a canonical BCP 47 language tag without extensions or private-use aliases",
  ),
);
export type LanguageTagV1 = Schema.Schema.Type<typeof LanguageTagV1>;

export const decodeLanguageTagV1 = Schema.decodeUnknownSync(LanguageTagV1);

/**
 * Resolves an already canonical request against enabled resources. Exact wins;
 * region may fall back, but an explicit script is never discarded or changed.
 */
export const resolveSupportedLanguageV1 = (
  requested: LanguageTagV1,
  supported: readonly LanguageTagV1[],
): LanguageTagV1 | null => {
  if (supported.includes(requested)) return requested;

  const requestedLocale = new Intl.Locale(requested);
  const compatible = supported.filter((candidate) => {
    const candidateLocale = new Intl.Locale(candidate);
    if (candidateLocale.language !== requestedLocale.language) return false;
    if (requestedLocale.script !== undefined) {
      return candidateLocale.script === requestedLocale.script;
    }
    return candidateLocale.script === undefined;
  });

  const withoutRegion = compatible.find(
    (candidate) => new Intl.Locale(candidate).region === undefined,
  );
  return withoutRegion ?? null;
};
