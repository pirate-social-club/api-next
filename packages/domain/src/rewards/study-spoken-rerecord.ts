import { isMeaningChangingStudyToken, type StudyTranscriptGradeV2 } from "./study-v2-grading.ts";

export const STUDY_SPOKEN_RERECORD_POLICY_V1 = "study_spoken_rerecord_v1" as const;
export const STUDY_SPOKEN_VOICE_OVERLAP_V1 = "study_spoken_voice_overlap_v1" as const;
export const STUDY_SPOKEN_STRONG_REMAINDER_V1 = "study_spoken_strong_remainder_v1" as const;
export const STUDY_SPOKEN_LANGUAGE_MISMATCH_V1 = "study_spoken_language_mismatch_v1" as const;

export type StudySpokenRerecordReason =
  | "language_mismatch"
  | "low_voice_overlap"
  | "single_insertion";

export type StudySpokenRerecordAssessment = Readonly<{
  policyRevision: typeof STUDY_SPOKEN_RERECORD_POLICY_V1;
  voiceOverlap: Readonly<{
    revision: typeof STUDY_SPOKEN_VOICE_OVERLAP_V1;
    matchedTokens: number;
    referenceTokens: number;
    belowOneThird: boolean;
  }>;
  strongRemainder: Readonly<{
    revision: typeof STUDY_SPOKEN_STRONG_REMAINDER_V1;
    matchedTokens: number;
    referenceTokens: number;
    strong: boolean;
  }>;
  languageMismatch: Readonly<{
    revision: typeof STUDY_SPOKEN_LANGUAGE_MISMATCH_V1;
    expectedLanguage: string | null;
    detectedLanguage: string | null;
    detectedConfidence: number | null;
    clear: boolean;
  }>;
  candidateReason: StudySpokenRerecordReason | null;
}>;

const languageBase = (language: string): string | null => {
  const base = language.trim().toLowerCase().split("-", 1)[0];
  return base !== undefined && /^[a-z]{2,3}$/u.test(base) ? base : null;
};

const isInflection = (expected: string, heard: string): boolean => {
  if (expected === heard) return false;
  const pairs = [
    [expected, heard],
    [heard, expected],
  ] as const;
  return pairs.some(([longer, shorter]) => {
    if (shorter.length < 3) return false;
    return (
      longer === `${shorter}s` ||
      longer === `${shorter}es` ||
      longer === `${shorter}ed` ||
      longer === `${shorter}ing` ||
      (shorter.endsWith("y") && longer === `${shorter.slice(0, -1)}ies`) ||
      (shorter.endsWith("y") && longer === `${shorter.slice(0, -1)}ied`)
    );
  });
};

const numberWords = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
]);
const bareNegatives = new Set([
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "dont",
  "doesnt",
  "didnt",
  "hasnt",
  "havent",
  "hadnt",
  "couldnt",
  "shouldnt",
  "wouldnt",
  "mustnt",
]);
const isProtectedRerecordToken = (token: string): boolean =>
  isMeaningChangingStudyToken(token) ||
  numberWords.has(token) ||
  bareNegatives.has(token) ||
  /^[a-z]+n't$/u.test(token);

export const assessStudySpokenRerecord = (
  input: Readonly<{
    grade: StudyTranscriptGradeV2;
    expectedLanguage: string | null;
    detectedLanguage: string | null;
    detectedLanguageConfidence: number | null;
  }>,
): StudySpokenRerecordAssessment => {
  const { grade } = input;
  const matchedTokens = grade.matched.length;
  const referenceTokens = matchedTokens + grade.missing.length + grade.substituted.length;
  const belowOneThird = referenceTokens > 0 && matchedTokens * 3 < referenceTokens;
  const strong = referenceTokens > 0 && matchedTokens * 5 >= referenceTokens * 4;
  const expectedBase =
    input.expectedLanguage === null ? null : languageBase(input.expectedLanguage);
  const detectedBase =
    input.detectedLanguage === null ? null : languageBase(input.detectedLanguage);
  const clearMismatch =
    expectedBase !== null &&
    detectedBase !== null &&
    input.detectedLanguageConfidence !== null &&
    input.detectedLanguageConfidence >= 0.8 &&
    expectedBase !== detectedBase;
  const protectedDiff =
    grade.extra.some(isProtectedRerecordToken) ||
    grade.missing.some(({ token }) => isProtectedRerecordToken(token)) ||
    grade.substituted.some(
      ({ expected, heard }) =>
        isProtectedRerecordToken(expected.token) || isProtectedRerecordToken(heard),
    );
  const singleInsertion =
    grade.extra.length === 1 &&
    grade.missing.length === 0 &&
    grade.substituted.length <= 1 &&
    !protectedDiff &&
    strong &&
    grade.substituted.every(({ expected, heard }) => isInflection(expected.token, heard));
  return {
    policyRevision: STUDY_SPOKEN_RERECORD_POLICY_V1,
    voiceOverlap: {
      revision: STUDY_SPOKEN_VOICE_OVERLAP_V1,
      matchedTokens,
      referenceTokens,
      belowOneThird,
    },
    strongRemainder: {
      revision: STUDY_SPOKEN_STRONG_REMAINDER_V1,
      matchedTokens,
      referenceTokens,
      strong,
    },
    languageMismatch: {
      revision: STUDY_SPOKEN_LANGUAGE_MISMATCH_V1,
      expectedLanguage: input.expectedLanguage,
      detectedLanguage: input.detectedLanguage,
      detectedConfidence: input.detectedLanguageConfidence,
      clear: clearMismatch,
    },
    candidateReason: grade.correct
      ? null
      : clearMismatch
        ? "language_mismatch"
        : belowOneThird
          ? "low_voice_overlap"
          : singleInsertion
            ? "single_insertion"
            : null,
  };
};
