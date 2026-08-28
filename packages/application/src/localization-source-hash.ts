export const LOCALIZATION_SOURCE_HASH_POLICY_V1 = "source-hash-v1" as const;

export type LocalizationSourceHashInputV1 = Readonly<{
  sourceUnitKind: "post" | "comment" | "community_text" | "lyric_line";
  sourceUnitId: string;
  fieldKey: string;
  sourceRevision: number;
  canonicalValue: string;
}>;

const canonicalSourceHashMaterialV1 = (input: LocalizationSourceHashInputV1): string =>
  JSON.stringify([
    "pirate.localization.source-hash",
    LOCALIZATION_SOURCE_HASH_POLICY_V1,
    input.sourceUnitKind,
    input.sourceUnitId,
    input.fieldKey,
    input.sourceRevision,
    input.canonicalValue,
  ]);

export const localizationSourceHashV1 = async (
  input: LocalizationSourceHashInputV1,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalSourceHashMaterialV1(input)),
  );
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
};
