import { phoneticStreamSimilarity } from "../study/english-phonetics.ts";

export const STUDY_TRANSCRIPT_GRADER_POLICY_V1 = "script_aware_token_diff_v1" as const;
export const STUDY_TRANSCRIPT_GRADER_POLICY_V2 = "script_aware_token_phonetic_v2" as const;

export type StudyTranscriptGraderPolicyRevision =
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V1
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V2;
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

const normalizeEnglishRecallToken = (token: string): string => {
  const compact = token.replaceAll("'", "");
  if (compact.length > 4 && compact.endsWith("ies")) return `${compact.slice(0, -3)}y`;
  if (compact.length > 4 && /(ches|shes|xes|zes|ses)$/u.test(compact)) {
    return compact.slice(0, -2);
  }
  return compact.length > 3 && compact.endsWith("s") ? compact.slice(0, -1) : compact;
};

const tokens = (value: string, dominantLanguage: string | null): string[] => {
  const english = dominantLanguage?.split("-", 1)[0] === "en";
  const normalized = normalizeText(english ? expandEnglishContractions(value) : value);
  if (normalized.length === 0) return [];
  const segmented = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(normalized)]
    .filter(({ isWordLike }) => isWordLike === true)
    .map(({ segment }) => segment);
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
  const expected = tokens(reference, dominantLanguage);
  const actual = tokens(heardTranscript, dominantLanguage);
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
  const phonetic =
    !exact && english && policyRevision === STUDY_TRANSCRIPT_GRADER_POLICY_V2
      ? phoneticStreamSimilarity(expected, actual)
      : null;
  // Ported calibration: the floor accepts short inflection/fragmentation errors,
  // while the cap prevents long lines from absorbing semantic substitutions.
  const phoneticBudget =
    phonetic === null ? 0 : Math.max(2, Math.min(Math.floor(0.15 * phonetic.length), 4));
  const matchKind: StudyTranscriptMatchKind = exact
    ? "exact"
    : phonetic?.available === true && phonetic.distance <= phoneticBudget
      ? "phonetic"
      : "none";
  return {
    correct: matchKind !== "none",
    matchKind,
    heardTranscript,
    matched: matchKind === "phonetic" ? [] : matched,
    missing: matchKind === "phonetic" ? [] : missing,
    extra: matchKind === "phonetic" ? [] : extra,
    substituted: matchKind === "phonetic" ? [] : substituted,
    policyRevision,
  };
};

export const gradeEnglishTranscriptV2 = (reference: string, heardTranscript: string) =>
  gradeTranscriptV2(reference, heardTranscript, "en", STUDY_TRANSCRIPT_GRADER_POLICY_V2);
