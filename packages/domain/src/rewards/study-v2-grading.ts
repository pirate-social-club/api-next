import { phoneticStreamSimilarity, tokenPhoneCount } from "../study/english-phonetics.ts";

export const STUDY_TRANSCRIPT_GRADER_POLICY_V1 = "script_aware_token_diff_v1" as const;
export const STUDY_TRANSCRIPT_GRADER_POLICY_V2 = "script_aware_token_phonetic_v2" as const;
export const STUDY_TRANSCRIPT_GRADER_POLICY_V3 = "script_aware_token_phonetic_v3" as const;
export const STUDY_TRANSCRIPT_GRADER_POLICY_V4 = "script_aware_token_phonetic_v4" as const;

export type StudyTranscriptGraderPolicyRevision =
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V1
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V2
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V3
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V4;
export type StudyTranscriptMatchKind = "exact" | "phonetic" | "none";

export const studyTranscriptReviewGrade = (
  matchKind: StudyTranscriptMatchKind,
  attemptNumber: number,
): "again" | "hard" | "good" =>
  matchKind === "none" ? "again" : matchKind === "exact" && attemptNumber === 1 ? "good" : "hard";

export type StudyTokenPositionV2 = Readonly<{ token: string; position: number }>;
export type StudyTokenSubstitutionV2 = Readonly<{
  expected: StudyTokenPositionV2;
  heard: string;
}>;

export type StudyTranscriptGradeV2 = Readonly<{
  correct: boolean;
  matchKind: StudyTranscriptMatchKind;
  heardTranscript: string;
  matched: readonly StudyTokenPositionV2[];
  missing: readonly StudyTokenPositionV2[];
  extra: readonly string[];
  substituted: readonly StudyTokenSubstitutionV2[];
  policyRevision: StudyTranscriptGraderPolicyRevision;
}>;

const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("und")
    .replaceAll(/[‘’‛′`´]/gu, "'")
    .replaceAll(/[^\p{L}\p{N}'\s]/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");

export const gradeAcceptedTextV2 = (
  submitted: string,
  acceptedAnswers: readonly string[],
): boolean => {
  const candidate = normalizeText(submitted);
  return (
    candidate.length > 0 && acceptedAnswers.some((answer) => normalizeText(answer) === candidate)
  );
};

export const gradeExactChoiceV2 = (submittedChoiceKey: string, correctChoiceKey: string): boolean =>
  submittedChoiceKey === correctChoiceKey;

const ignoredEnglishRecallTokens = new Set(["a", "an", "the"]);

// Tokens whose substitution, omission or insertion changes what the line
// says rather than how it was fragmented or inflected. Phonetic tolerance
// must never absorb these under revision v3.
const meaningChangingEnglishTokens = new Set([
  "not",
  "no",
  "never",
  "none",
  "nothing",
  "nobody",
  "nowhere",
  "nor",
  "cannot",
  "cant",
  "without",
]);

const isMeaningChangingToken = (token: string): boolean =>
  /\p{N}/u.test(token) || meaningChangingEnglishTokens.has(token);

const expandEnglishContractions = (value: string): string =>
  value
    .replace(/\b(can)'t\b/giu, "$1 not")
    .replace(/\b(won)'t\b/giu, "will not")
    .replace(/\b(i)'m\b/giu, "$1 am")
    .replace(/\b([a-z]+)'re\b/giu, "$1 are")
    .replace(/\b([a-z]+)'ve\b/giu, "$1 have")
    .replace(/\b([a-z]+)'ll\b/giu, "$1 will")
    .replace(/\b([a-z]+)'d\b/giu, "$1 would")
    .replace(/\b([a-z]+)'s\b/giu, "$1 is");

// Revision v4 canonicalizes the negative contractions v1-v3 leave alone:
// providers expand them (isn't heard as is not) and the resulting diff then
// touches a negation token, which the meaning-changing guard refuses, so an
// equivalent reading was rejected. Curly apostrophes from lyric typography
// are normalized first because expansion runs before normalizeText. Bare
// forms precede the apostrophe rules, and the can't/won't special cases
// precede the general apostrophized rule, or can't expands to ca not and
// won't to wo not; cannot, cant, and wont converge with can't and won't on
// their expanded forms. The legacy bare ill, id, im, and ive rewrites are
// deliberately not ported: those are ordinary words and not homophones of
// their contractions.
const expandEnglishContractionsV4 = (value: string): string =>
  value
    .replaceAll(/[‘’‛′`´]/gu, "'")
    .replace(/\bcannot\b/giu, "can not")
    .replace(/\bcant\b/giu, "can not")
    .replace(/\bwont\b/giu, "will not")
    .replace(
      /\b(is|are|was|were|do|does|did|has|have|had|could|should|would|must)nt\b/giu,
      "$1 not",
    )
    .replace(/\b(can)'t\b/giu, "$1 not")
    .replace(/\b(won)'t\b/giu, "will not")
    .replace(/\b([a-z]+)n't\b/giu, "$1 not")
    .replace(/\b(i)'m\b/giu, "$1 am")
    .replace(/\b([a-z]+)'re\b/giu, "$1 are")
    .replace(/\b([a-z]+)'ve\b/giu, "$1 have")
    .replace(/\b([a-z]+)'ll\b/giu, "$1 will")
    .replace(/\b([a-z]+)'d\b/giu, "$1 would")
    .replace(/\b([a-z]+)'s\b/giu, "$1 is");

const normalizeEnglishRecallToken = (token: string): string => {
  const compact = token.replaceAll("'", "");
  if (compact.length > 4 && compact.endsWith("ies")) return `${compact.slice(0, -3)}y`;
  if (compact.length > 4 && /(ches|shes|xes|zes|ses)$/u.test(compact)) {
    return compact.slice(0, -2);
  }
  return compact.length > 3 && compact.endsWith("s") ? compact.slice(0, -1) : compact;
};

const rawTokens = (
  value: string,
  dominantLanguage: string | null,
  expand: (value: string) => string,
): string[] => {
  const english = dominantLanguage?.split("-", 1)[0] === "en";
  const normalized = normalizeText(english ? expand(value) : value);
  if (normalized.length === 0) return [];
  return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(normalized)]
    .filter(({ isWordLike }) => isWordLike === true)
    .map(({ segment }) => segment);
};

const tokens = (
  value: string,
  dominantLanguage: string | null,
  expand: (value: string) => string,
): string[] => {
  const english = dominantLanguage?.split("-", 1)[0] === "en";
  const segmented = rawTokens(value, dominantLanguage, expand);
  if (!english) return segmented;
  return segmented
    .map(normalizeEnglishRecallToken)
    .filter((token) => token.length > 0 && !ignoredEnglishRecallTokens.has(token));
};

export const gradeTranscriptV2 = (
  reference: string,
  heardTranscript: string,
  dominantLanguage: string | null,
  policyRevision: StudyTranscriptGraderPolicyRevision,
): StudyTranscriptGradeV2 => {
  const v3 = policyRevision === STUDY_TRANSCRIPT_GRADER_POLICY_V3;
  const v4 = policyRevision === STUDY_TRANSCRIPT_GRADER_POLICY_V4;
  const expand = v4 ? expandEnglishContractionsV4 : expandEnglishContractions;
  let expected = tokens(reference, dominantLanguage, expand);
  let actual = tokens(heardTranscript, dominantLanguage, expand);
  // Revision v3 refuses vacuous comparisons: when article and stopword
  // filtering empties both sides, compare the unfiltered segmentation so an
  // article-only line versus silence is incorrect while the same article on
  // both sides stays exact.
  if (v3 && expected.length === 0 && actual.length === 0) {
    const rawExpected = rawTokens(reference, dominantLanguage, expand);
    const rawActual = rawTokens(heardTranscript, dominantLanguage, expand);
    if (rawExpected.length === 0) {
      // No meaningful reference remains: refuse rather than score an empty
      // comparison as a match.
      return {
        correct: false,
        matchKind: "none",
        heardTranscript,
        matched: [],
        missing: [],
        extra: [],
        substituted: [],
        policyRevision,
      };
    }
    expected = rawExpected;
    actual = rawActual;
  }
  const distance = Array.from({ length: expected.length + 1 }, (_, left) =>
    Array.from({ length: actual.length + 1 }, (_, right) =>
      left === 0 ? right : right === 0 ? left : 0,
    ),
  );
  for (let left = 1; left <= expected.length; left += 1) {
    for (let right = 1; right <= actual.length; right += 1) {
      const row = distance[left];
      if (row === undefined) continue;
      row[right] =
        expected[left - 1] === actual[right - 1]
          ? (distance[left - 1]?.[right - 1] ?? 0)
          : 1 +
            Math.min(
              distance[left - 1]?.[right] ?? 0,
              row[right - 1] ?? 0,
              distance[left - 1]?.[right - 1] ?? 0,
            );
    }
  }
  const matched: StudyTokenPositionV2[] = [];
  const missing: StudyTokenPositionV2[] = [];
  const extra: string[] = [];
  const substituted: StudyTokenSubstitutionV2[] = [];
  let left = expected.length;
  let right = actual.length;
  while (left > 0 || right > 0) {
    if (
      left > 0 &&
      right > 0 &&
      expected[left - 1] === actual[right - 1] &&
      distance[left]?.[right] === distance[left - 1]?.[right - 1]
    ) {
      matched.push({ token: expected[left - 1] as string, position: left - 1 });
      left -= 1;
      right -= 1;
    } else if (
      left > 0 &&
      right > 0 &&
      distance[left]?.[right] === 1 + (distance[left - 1]?.[right - 1] ?? 0)
    ) {
      substituted.push({
        expected: { token: expected[left - 1] as string, position: left - 1 },
        heard: actual[right - 1] as string,
      });
      left -= 1;
      right -= 1;
    } else if (left > 0 && distance[left]?.[right] === 1 + (distance[left - 1]?.[right] ?? 0)) {
      missing.push({ token: expected[left - 1] as string, position: left - 1 });
      left -= 1;
    } else {
      extra.push(actual[right - 1] as string);
      right -= 1;
    }
  }
  matched.reverse();
  missing.reverse();
  extra.reverse();
  substituted.reverse();
  const exact = missing.length === 0 && extra.length === 0 && substituted.length === 0;
  const english = dominantLanguage?.split("-", 1)[0] === "en";
  // Revisions v3 and v4 refuse phonetic acceptance when a negation or
  // numeric token was substituted, inserted or dropped: those changes alter
  // what the line says, and the phonetic budget must never absorb them.
  const meaningChanged =
    (v3 || v4) &&
    (missing.some(({ token }) => isMeaningChangingToken(token)) ||
      extra.some(isMeaningChangingToken) ||
      substituted.some(
        ({ expected: mismatch, heard }) =>
          isMeaningChangingToken(mismatch.token) || isMeaningChangingToken(heard),
      ));
  const phonetic =
    !exact &&
    english &&
    (policyRevision === STUDY_TRANSCRIPT_GRADER_POLICY_V2 ||
      policyRevision === STUDY_TRANSCRIPT_GRADER_POLICY_V3 ||
      policyRevision === STUDY_TRANSCRIPT_GRADER_POLICY_V4)
      ? phoneticStreamSimilarity(expected, actual)
      : null;
  // Ported calibration: the floor accepts short inflection/fragmentation errors,
  // while the cap prevents long lines from absorbing semantic substitutions.
  const phoneticBudget =
    phonetic === null ? 0 : Math.max(2, Math.min(Math.floor(0.15 * phonetic.length), 4));
  // Revision v4 bounds whole-word drift: inflection and fragmentation stay
  // acceptable, but the unmatched added and missing tokens together may not
  // reach three phones, so a single inserted or deleted short word can no
  // longer ride the phonetic budget. The weight uses the same primitive as
  // the stream comparison.
  const unmatchedPhoneWeight = v4
    ? [...missing.map(({ token }) => token), ...extra].reduce(
        (sum, token) => sum + tokenPhoneCount(token),
        0,
      )
    : 0;
  const matchKind: StudyTranscriptMatchKind = exact
    ? "exact"
    : phonetic?.available === true &&
        phonetic.distance <= phoneticBudget &&
        !meaningChanged &&
        unmatchedPhoneWeight < 3
      ? "phonetic"
      : "none";
  // Revision v2 cleared the diff on phonetic acceptance; v3 keeps it so the
  // learner sees what changed even on an accepted near-match.
  const clearDiff = matchKind === "phonetic" && !v3;
  return {
    correct: matchKind !== "none",
    matchKind,
    heardTranscript,
    matched: clearDiff ? [] : matched,
    missing: clearDiff ? [] : missing,
    extra: clearDiff ? [] : extra,
    substituted: clearDiff ? [] : substituted,
    policyRevision,
  };
};

export const gradeEnglishTranscriptV2 = (reference: string, heardTranscript: string) =>
  gradeTranscriptV2(reference, heardTranscript, "en", STUDY_TRANSCRIPT_GRADER_POLICY_V2);

export const gradeEnglishTranscriptV3 = (reference: string, heardTranscript: string) =>
  gradeTranscriptV2(reference, heardTranscript, "en", STUDY_TRANSCRIPT_GRADER_POLICY_V3);

export const gradeEnglishTranscriptV4 = (reference: string, heardTranscript: string) =>
  gradeTranscriptV2(reference, heardTranscript, "en", STUDY_TRANSCRIPT_GRADER_POLICY_V4);
