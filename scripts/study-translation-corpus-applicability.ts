import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  STUDY_TRANSLATION_CORPUS_CATEGORIES,
  STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
  STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1,
  STUDY_TRANSLATION_ZH_HANS_B1_APPLICABILITY_V1,
  type StudyTranslationApplicabilityPolicyV2,
  type StudyTranslationCorpusCategory,
} from "@pirate/application";
import { canonicalJson } from "@pirate/domain";

export type StudySongLibraryMeasurementV1 =
  StudyTranslationApplicabilityPolicyV2["library_measurement"];

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const categoryPolicy = (
  category: StudyTranslationCorpusCategory,
): StudyTranslationApplicabilityPolicyV2["categories"][number] => {
  if (category === "already_target_language") {
    return {
      category,
      applicability: "not_applicable",
      minimum_sample_count: 0,
      reason: "current_library_contains_no_han_script_source_song",
    };
  }
  if (category === "gender_or_formality") {
    return {
      category,
      applicability: "opportunistic",
      minimum_sample_count: 20,
      reason: "mandarin_lyrics_rarely_expose_a_natural_gender_or_formality_contrast",
    };
  }
  const highQuota = new Set<StudyTranslationCorpusCategory>([
    "mixed_language",
    "idiom",
    "slang",
    "ambiguity",
    "instruction_like_lyric",
  ]);
  return {
    category,
    applicability: "required",
    minimum_sample_count: highQuota.has(category) ? 20 : 10,
    reason: highQuota.has(category)
      ? "prompt_risk_category_target_20"
      : "common_taxonomy_target_10",
  };
};

export const measureStudySongLibraryV1 = async (
  songsRoot: string,
): Promise<StudySongLibraryMeasurementV1> => {
  const entries = (await readdir(songsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (entries.length === 0) throw new TypeError("song library has no directories");

  const songs: Array<Readonly<{ song_name: string; lyrics_sha256: string | null }>> = [];
  let lyricsFileCount = 0;
  let targetScriptSongCount = 0;
  for (const entry of entries) {
    const lyrics = await readFile(join(songsRoot, entry.name, "lyrics.txt")).catch(
      (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      },
    );
    if (lyrics === null) {
      songs.push({ song_name: entry.name, lyrics_sha256: null });
      continue;
    }
    lyricsFileCount += 1;
    if (/\p{Script=Han}/u.test(lyrics.toString("utf8"))) targetScriptSongCount += 1;
    songs.push({ song_name: entry.name, lyrics_sha256: sha256(lyrics) });
  }
  if (lyricsFileCount === 0) throw new TypeError("song library has no lyrics files");
  return {
    measurement_revision: STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1,
    library_sha256: sha256(
      canonicalJson({
        measurement_revision: STUDY_TRANSLATION_LIBRARY_MEASUREMENT_V1,
        songs,
      }),
    ),
    song_directory_count: entries.length,
    lyrics_file_count: lyricsFileCount,
    target_script_predicate: "unicode_script_han_v1",
    target_script_song_count: targetScriptSongCount,
  };
};

export const makeZhHansB1ApplicabilityPolicyV1 = (
  measurement: StudySongLibraryMeasurementV1,
): StudyTranslationApplicabilityPolicyV2 => {
  if (measurement.target_script_song_count !== 0) {
    throw new TypeError("zh-Hans already-target applicability must be remeasured");
  }
  return {
    policy_revision: STUDY_TRANSLATION_ZH_HANS_B1_APPLICABILITY_V1,
    evaluator_revision: STUDY_TRANSLATION_CORPUS_EVALUATOR_V2,
    target_language: "zh-Hans",
    learner_band: "B1",
    minimum_corpus_sample_count: 200,
    minimum_corpus_song_count: 25,
    library_measurement: measurement,
    categories: STUDY_TRANSLATION_CORPUS_CATEGORIES.map(categoryPolicy),
  };
};

const songsRoot = process.argv[2];
if (import.meta.main) {
  if (songsRoot === undefined || songsRoot.length === 0) {
    console.error("usage: bun scripts/study-translation-corpus-applicability.ts <songs-root>");
    process.exitCode = 2;
  } else {
    const policy = makeZhHansB1ApplicabilityPolicyV1(
      await measureStudySongLibraryV1(resolve(songsRoot)),
    );
    console.log(JSON.stringify(policy, null, 2));
  }
}
