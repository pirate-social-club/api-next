import { isSlug, type SlugifyOptions, slugify, truncateSlug } from "cizgile";
import { allScripts, type Locale, locales, lookup, resolveTables } from "cizgile/transliterate";
import { iriToUri } from "cizgile/uri";

export const POST_SLUG_POLICY_VERSION = "post-slug-v1" as const;
export const POST_SLUG_MAX_LENGTH = 80;
export const POST_SLUG_OPAQUE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz" as const;
export const POST_SLUG_OPAQUE_TOKEN_LENGTH = 10;

export type PostSlugCandidate =
  | Readonly<{
      kind: "descriptive";
      branch: "ascii" | "unicode";
      slug: string;
    }>
  | Readonly<{
      kind: "opaque";
      prefix: "post" | "song";
    }>;

export type CreatePostSlugCandidateInput = Readonly<{
  source: string;
  locale?: string;
  postType: "text" | "song";
}>;

type PrincipalScript =
  | "Latin"
  | "Cyrillic"
  | "Greek"
  | "Arabic"
  | "Armenian"
  | "Georgian"
  | "Thaana"
  | "Unknown";

const ASCII_ALPHANUMERIC = /[A-Za-z0-9]/u;
const LETTER = /\p{Letter}/u;
const SCRIPT_MATCHERS = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Georgian", /\p{Script=Georgian}/u],
  ["Thaana", /\p{Script=Thaana}/u],
] as const satisfies ReadonlyArray<readonly [Exclude<PrincipalScript, "Unknown">, RegExp]>;

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

export const createOpaquePostSlugCandidate = (postType: "text" | "song"): PostSlugCandidate => ({
  kind: "opaque",
  prefix: postType === "song" ? "song" : "post",
});

const resolveLocale = (locale: string | undefined): Locale | undefined => {
  if (locale === undefined) return undefined;

  try {
    const canonical = Intl.getCanonicalLocales(locale)[0];
    if (canonical === undefined) return undefined;
    const language = canonical.split("-", 1)[0]?.toLowerCase();
    if (language === undefined || !Object.hasOwn(locales, language)) return undefined;
    return locales[language as keyof typeof locales];
  } catch {
    return undefined;
  }
};

const asciiOptions = (locale: Locale | undefined, maxLength?: number): SlugifyOptions => ({
  separator: "-",
  lowercase: true,
  unicode: false,
  transliterate: allScripts,
  ...(locale === undefined ? {} : { locale }),
  ...(maxLength === undefined ? {} : { maxLength }),
});

const unicodeOptions = {
  separator: "-",
  lowercase: true,
  unicode: true,
  scripts: "moderately-restrictive",
  bidi: "allow",
  maxLength: POST_SLUG_MAX_LENGTH,
} as const satisfies SlugifyOptions;

const principalScript = (grapheme: string): PrincipalScript | undefined => {
  for (const character of grapheme) {
    if (!LETTER.test(character)) continue;
    for (const [script, matcher] of SCRIPT_MATCHERS) {
      if (matcher.test(character)) return script;
    }
    return "Unknown";
  }
  return undefined;
};

const principalScriptRuns = (source: string): ReadonlyArray<string> => {
  const runs: string[] = [];
  let current = "";
  let currentScript: PrincipalScript | undefined;

  for (const { segment } of graphemeSegmenter.segment(source)) {
    const script = principalScript(segment);
    if (script === undefined) {
      if (current.length > 0) runs.push(current);
      current = "";
      currentScript = undefined;
      continue;
    }

    if (currentScript !== undefined && currentScript !== script) {
      runs.push(current);
      current = "";
    }
    current += segment;
    currentScript = script;
  }

  if (current.length > 0) runs.push(current);
  return runs;
};

const hasCompleteAsciiCoverage = (source: string, locale: Locale | undefined): boolean => {
  const options = asciiOptions(locale);
  for (const run of principalScriptRuns(source)) {
    if (!ASCII_ALPHANUMERIC.test(slugify(run, options))) return false;
  }

  const tables = resolveTables({
    tables: allScripts,
    ...(locale === undefined ? {} : { locale }),
  });
  for (const character of source) {
    if (!LETTER.test(character)) continue;
    if (ASCII_ALPHANUMERIC.test(slugify(character, options))) continue;
    if (lookup(tables, character) !== undefined) continue;
    return false;
  }
  return true;
};

export const createPostSlugCandidate = (input: CreatePostSlugCandidateInput): PostSlugCandidate => {
  try {
    const source = input.source.normalize("NFKC");
    const locale = resolveLocale(input.locale);

    if (hasCompleteAsciiCoverage(source, locale)) {
      const slug = slugify(source, asciiOptions(locale, POST_SLUG_MAX_LENGTH));
      if (slug.length > 0 && isSlug(slug, { maxLength: POST_SLUG_MAX_LENGTH })) {
        return { kind: "descriptive", branch: "ascii", slug };
      }
    }

    const slug = slugify(source, unicodeOptions);
    if (slug.length > 0 && isSlug(slug, unicodeOptions)) {
      return { kind: "descriptive", branch: "unicode", slug };
    }
  } catch {
    return createOpaquePostSlugCandidate(input.postType);
  }

  return createOpaquePostSlugCandidate(input.postType);
};

export const selectPostSlugSource = (input: {
  readonly title: string | null;
  readonly body: string | null;
}): string => {
  if (input.title?.trim()) return input.title;
  return input.body?.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
};

export const postSlugCollisionCandidate = (base: string, ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RangeError("post slug collision ordinal must be a positive safe integer");
  }
  if (ordinal === 1) return truncateSlug(base, POST_SLUG_MAX_LENGTH);
  const suffix = `-${ordinal}`;
  const truncatedBase = truncateSlug(base, POST_SLUG_MAX_LENGTH - suffix.length);
  if (truncatedBase.length === 0) {
    throw new RangeError("post slug collision suffix leaves no logical base");
  }
  return `${truncatedBase}${suffix}`;
};

export const postSlugOpaqueToken = (bytes: Uint8Array): string => {
  if (bytes.length < POST_SLUG_OPAQUE_TOKEN_LENGTH) {
    throw new RangeError("post slug opaque entropy must contain at least ten bytes");
  }
  let token = "";
  for (let index = 0; index < POST_SLUG_OPAQUE_TOKEN_LENGTH; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new RangeError("post slug opaque entropy is incomplete");
    const character = POST_SLUG_OPAQUE_ALPHABET[byte & 31];
    if (character === undefined) throw new RangeError("post slug opaque alphabet is incomplete");
    token += character;
  }
  return token;
};

export const isLogicalPostSlug = (slug: string): boolean => {
  try {
    return (
      slug.length > 0 &&
      slug.length <= POST_SLUG_MAX_LENGTH &&
      slug.normalize("NFKC") === slug &&
      !slug.includes("%") &&
      !slug.includes("/") &&
      !slug.includes("\\") &&
      slug !== "." &&
      slug !== ".." &&
      isSlug(slug, unicodeOptions)
    );
  } catch {
    return false;
  }
};

/** Serialize a validated logical key only at the canonical HTTP boundary. */
export const postSlugCanonicalPath = (slug: string): string | null => {
  if (!isLogicalPostSlug(slug)) return null;
  try {
    const wire = iriToUri(slug);
    return wire.length > 0 && !wire.includes("/") ? `/posts/${wire}` : null;
  } catch {
    return null;
  }
};
