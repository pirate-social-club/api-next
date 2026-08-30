export const LYRIC_LINE_IDENTITY_NORMALIZATION_V1 = "lyric_line_identity_normalization_v1" as const;
export const STUDY_UNIT_ELIGIBILITY_POLICY_V1 = "study_unit_eligibility_v1" as const;
export const STUDY_SAY_IT_BACK_MAX_TOKEN_COUNT_V1 = 32 as const;
export const STUDY_SAY_IT_BACK_MAX_CHARACTER_COUNT_V1 = 512 as const;

export type StudyUnitSayItBackEligibilityV1 = Readonly<{
  characterCount: number;
  eligibility: "eligible" | "ineligible";
  policyRevision: typeof STUDY_UNIT_ELIGIBILITY_POLICY_V1;
  reason: "spoken_recall_too_long" | null;
  tokenCount: number;
}>;

// Frozen from the 92-song production-near corpus. Re-measure when the catalog
// grows materially; expanding this set changes materialized Study units and
// requires a new eligibility-policy revision rather than an edit to v1.
const STANDALONE_PARENTHESIZED_INSTRUMENTAL_DIRECTION =
  /^\(\s*instrumental(?:\s+solo|\s+breakdown(?:\s+with\s+vocal\s+chops)?)?\s*\)$/iu;

export const isStandaloneLyricMetadataLine = (value: string): boolean => {
  const trimmed = value.trim();
  const bracketInterior = trimmed.slice(1, -1);
  const isSingleBracketedAnnotation =
    trimmed.startsWith("[") &&
    trimmed.endsWith("]") &&
    !bracketInterior.includes("[") &&
    !bracketInterior.includes("]") &&
    !bracketInterior.includes("\r") &&
    !bracketInterior.includes("\n");
  return (
    isSingleBracketedAnnotation || STANDALONE_PARENTHESIZED_INSTRUMENTAL_DIRECTION.test(trimmed)
  );
};

export const normalizeLyricLineIdentityV1 = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[‘’‛′`´]/gu, "'")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

export const evaluateStudyUnitSayItBackEligibilityV1 = (
  normalizedText: string,
): StudyUnitSayItBackEligibilityV1 => {
  const tokenCount = normalizedText.length === 0 ? 0 : normalizedText.split(" ").length;
  const characterCount = [...normalizedText].length;
  const eligible =
    tokenCount <= STUDY_SAY_IT_BACK_MAX_TOKEN_COUNT_V1 &&
    characterCount <= STUDY_SAY_IT_BACK_MAX_CHARACTER_COUNT_V1;
  return {
    characterCount,
    eligibility: eligible ? "eligible" : "ineligible",
    policyRevision: STUDY_UNIT_ELIGIBILITY_POLICY_V1,
    reason: eligible ? null : "spoken_recall_too_long",
    tokenCount,
  };
};

export type PriorLyricOccurrence = Readonly<{
  canonicalText: string;
  lineId: string;
  lineVersion: number;
  normalizedText: string;
  ordinal: number;
  sourceHash: string;
  studyUnitId: string;
}>;

export type ReconciledLyricOccurrence = Readonly<{
  canonicalText: string;
  carried: boolean;
  lineId: string;
  lineVersion: number;
  normalizedText: string;
  ordinal: number;
  priorOrdinal: number | null;
  studyUnitId: string;
}>;

export type RetiredLyricOccurrence = Readonly<{
  ambiguous: boolean;
  lineId: string;
  ordinal: number;
}>;

export const acceptedLyricLines = (lyrics: string): readonly string[] =>
  lyrics
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isStandaloneLyricMetadataLine(line));

const lcsLengths = (left: readonly string[], right: readonly string[]): number[][] => {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    const row = lengths[leftIndex];
    if (row === undefined) throw new TypeError("invalid LCS row");
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      row[rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? 1 + (lengths[leftIndex + 1]?.[rightIndex + 1] ?? 0)
          : Math.max(lengths[leftIndex + 1]?.[rightIndex] ?? 0, row[rightIndex + 1] ?? 0);
    }
  }
  return lengths;
};

const lcsPrefixLengths = (left: readonly string[], right: readonly string[]): number[][] => {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const row = lengths[leftIndex + 1];
    if (row === undefined) throw new TypeError("invalid LCS row");
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      row[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? 1 + (lengths[leftIndex]?.[rightIndex] ?? 0)
          : Math.max(lengths[leftIndex]?.[rightIndex + 1] ?? 0, row[rightIndex] ?? 0);
    }
  }
  return lengths;
};

const lcsLengthExcludingPair = (
  left: readonly string[],
  right: readonly string[],
  excludedLeft: number,
  excludedRight: number,
): number => {
  let previous = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = Array.from({ length: right.length + 1 }, () => 0);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] =
        left[leftIndex] === right[rightIndex] &&
        !(leftIndex === excludedLeft && rightIndex === excludedRight)
          ? (previous[rightIndex] ?? 0) + 1
          : Math.max(previous[rightIndex + 1] ?? 0, current[rightIndex] ?? 0);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
};

/**
 * Returns only pairs present in every locally unambiguous maximum in-order
 * match. Duplicate or reordered candidates fail closed instead of inheriting
 * learner history speculatively.
 */
const conservativeMatches = (
  previous: readonly PriorLyricOccurrence[],
  nextNormalized: readonly string[],
): ReadonlyMap<number, number> => {
  const oldNormalized = previous.map((line) => line.normalizedText);
  const suffix = lcsLengths(oldNormalized, nextNormalized);
  const prefix = lcsPrefixLengths(oldNormalized, nextNormalized);
  const maximum = suffix[0]?.[0] ?? 0;
  const candidates: Array<readonly [number, number]> = [];
  for (let oldIndex = 0; oldIndex < oldNormalized.length; oldIndex += 1) {
    for (let nextIndex = 0; nextIndex < nextNormalized.length; nextIndex += 1) {
      if (oldNormalized[oldIndex] !== nextNormalized[nextIndex]) continue;
      const before = prefix[oldIndex]?.[nextIndex] ?? 0;
      const after = suffix[oldIndex + 1]?.[nextIndex + 1] ?? 0;
      if (before + 1 + after === maximum) candidates.push([oldIndex, nextIndex]);
    }
  }
  return new Map(
    candidates
      .filter(
        ([oldIndex, nextIndex]) =>
          lcsLengthExcludingPair(oldNormalized, nextNormalized, oldIndex, nextIndex) < maximum,
      )
      .map(([oldIndex, nextIndex]) => [nextIndex, oldIndex] as const),
  );
};

export const reconcileLyricLineIdentities = (input: {
  readonly lyrics: string;
  readonly nextLineId: () => string;
  readonly nextStudyUnitId: () => string;
  readonly previous: readonly PriorLyricOccurrence[];
  readonly studyUnitsByNormalizedText?: ReadonlyMap<string, string>;
}): Readonly<{
  lines: readonly ReconciledLyricOccurrence[];
  retired: readonly RetiredLyricOccurrence[];
}> => {
  const canonicalLines = acceptedLyricLines(input.lyrics);
  const normalizedLines = canonicalLines.map(normalizeLyricLineIdentityV1);
  const matches = conservativeMatches(input.previous, normalizedLines);
  const matchedOld = new Set(matches.values());
  const studyUnits = new Map(input.studyUnitsByNormalizedText ?? []);
  for (const line of input.previous) studyUnits.set(line.normalizedText, line.studyUnitId);

  const lines = canonicalLines.map((canonicalText, nextIndex): ReconciledLyricOccurrence => {
    const normalizedText = normalizeLyricLineIdentityV1(canonicalText);
    const oldIndex = matches.get(nextIndex);
    const prior = oldIndex === undefined ? undefined : input.previous[oldIndex];
    let studyUnitId = studyUnits.get(normalizedText);
    if (studyUnitId === undefined) {
      studyUnitId = input.nextStudyUnitId();
      studyUnits.set(normalizedText, studyUnitId);
    }
    return {
      canonicalText,
      carried: prior !== undefined,
      lineId: prior?.lineId ?? input.nextLineId(),
      lineVersion:
        prior === undefined
          ? 1
          : prior.canonicalText === canonicalText
            ? prior.lineVersion
            : prior.lineVersion + 1,
      normalizedText,
      ordinal: nextIndex + 1,
      priorOrdinal: prior?.ordinal ?? null,
      studyUnitId,
    };
  });

  const candidateCounts = new Map<string, number>();
  for (const normalized of normalizedLines) {
    candidateCounts.set(normalized, (candidateCounts.get(normalized) ?? 0) + 1);
  }
  return {
    lines,
    retired: input.previous.flatMap((line, oldIndex) =>
      matchedOld.has(oldIndex)
        ? []
        : [
            {
              ambiguous: (candidateCounts.get(line.normalizedText) ?? 0) > 0,
              lineId: line.lineId,
              ordinal: line.ordinal,
            },
          ],
    ),
  };
};
