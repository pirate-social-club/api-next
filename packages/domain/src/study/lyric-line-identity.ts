export const LYRIC_LINE_IDENTITY_NORMALIZATION_V1 = "lyric_line_identity_normalization_v1" as const;

export const normalizeLyricLineIdentityV1 = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[‘’‛′`´]/gu, "'")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
