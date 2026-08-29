export type StudyTokenSpanV2 = Readonly<{ text: string; start: number; end: number }>;

export type StudyTranscriptGradeV2 = Readonly<{
  correct: boolean;
  transcript: string;
  matched: readonly StudyTokenSpanV2[];
  missing: readonly StudyTokenSpanV2[];
  extra: readonly StudyTokenSpanV2[];
  policyRevision: "source_token_diff_en_v1";
}>;

const normalizeText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replaceAll(/[‘’]/gu, "'")
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

const tokens = (value: string): StudyTokenSpanV2[] => {
  const normalized = normalizeText(value);
  if (normalized.length === 0) return [];
  const output: StudyTokenSpanV2[] = [];
  const pattern = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
  for (const match of normalized.matchAll(pattern)) {
    const start = match.index;
    output.push({ text: match[0], start, end: start + match[0].length });
  }
  return output;
};

export const gradeEnglishTranscriptV2 = (
  reference: string,
  transcript: string,
): StudyTranscriptGradeV2 => {
  const expected = tokens(reference);
  const actual = tokens(transcript);
  const lengths = Array.from({ length: expected.length + 1 }, () =>
    Array<number>(actual.length + 1).fill(0),
  );
  for (let left = expected.length - 1; left >= 0; left -= 1) {
    const row = lengths[left];
    if (row === undefined) continue;
    for (let right = actual.length - 1; right >= 0; right -= 1) {
      row[right] =
        expected[left]?.text === actual[right]?.text
          ? 1 + (lengths[left + 1]?.[right + 1] ?? 0)
          : Math.max(lengths[left + 1]?.[right] ?? 0, lengths[left]?.[right + 1] ?? 0);
    }
  }

  const matched: StudyTokenSpanV2[] = [];
  const missing: StudyTokenSpanV2[] = [];
  const extra: StudyTokenSpanV2[] = [];
  let left = 0;
  let right = 0;
  while (left < expected.length && right < actual.length) {
    const expectedToken = expected[left];
    const actualToken = actual[right];
    if (expectedToken?.text === actualToken?.text) {
      if (actualToken) matched.push(actualToken);
      left += 1;
      right += 1;
    } else if ((lengths[left + 1]?.[right] ?? 0) >= (lengths[left]?.[right + 1] ?? 0)) {
      if (expectedToken) missing.push(expectedToken);
      left += 1;
    } else {
      if (actualToken) extra.push(actualToken);
      right += 1;
    }
  }
  missing.push(...expected.slice(left));
  extra.push(...actual.slice(right));
  return {
    correct: missing.length === 0 && extra.length === 0,
    transcript,
    matched,
    missing,
    extra,
    policyRevision: "source_token_diff_en_v1",
  };
};
