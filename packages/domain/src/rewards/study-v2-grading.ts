export type StudyTokenPositionV2 = Readonly<{ token: string; position: number }>;
export type StudyTokenSubstitutionV2 = Readonly<{
  expected: StudyTokenPositionV2;
  heard: string;
}>;

export type StudyTranscriptGradeV2 = Readonly<{
  correct: boolean;
  heardTranscript: string;
  matched: readonly StudyTokenPositionV2[];
  missing: readonly StudyTokenPositionV2[];
  extra: readonly string[];
  substituted: readonly StudyTokenSubstitutionV2[];
  policyRevision: "script_aware_token_diff_v1";
}>;

const normalizeText = (value: string): string =>
  value
    .normalize("NFKC")
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

const contractions: Readonly<Record<string, readonly string[]>> = {
  "can't": ["can", "not"],
  "don't": ["do", "not"],
  "i'm": ["i", "am"],
  "it's": ["it", "is"],
  "we're": ["we", "are"],
  "won't": ["will", "not"],
  "you're": ["you", "are"],
};

const tokens = (value: string, dominantLanguage: string | null): string[] => {
  const normalized = normalizeText(value);
  if (normalized.length === 0) return [];
  const segmented = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(normalized)]
    .filter(({ isWordLike }) => isWordLike === true)
    .map(({ segment }) => segment);
  if (dominantLanguage?.split("-", 1)[0] !== "en") return segmented;
  return segmented.flatMap((token) => contractions[token] ?? [token]);
};

export const gradeTranscriptV2 = (
  reference: string,
  heardTranscript: string,
  dominantLanguage: string | null,
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
  return {
    correct: missing.length === 0 && extra.length === 0,
    heardTranscript,
    matched,
    missing,
    extra,
    substituted,
    policyRevision: "script_aware_token_diff_v1",
  };
};

export const gradeEnglishTranscriptV2 = (reference: string, heardTranscript: string) =>
  gradeTranscriptV2(reference, heardTranscript, "en");
