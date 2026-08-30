import { createHash } from "node:crypto";
import {
  STUDY_LANGUAGE_PROFILE_PROMPT_V2,
  STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
  STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1,
  STUDY_TRANSLATION_CORPUS_CATEGORIES,
  STUDY_TRANSLATION_CORPUS_V1,
  STUDY_TRANSLATION_PROMPT_V2,
  STUDY_TRANSLATION_VALIDATOR_V2,
  type StudyLanguageProfileAnalysis,
  type StudyLanguageProfileRequest,
  type StudyTranslationCorpusCandidateDocumentV1,
  type StudyTranslationCorpusV1,
  type StudyTranslationGenerationProposal,
  type StudyTranslationGenerationRequest,
} from "@pirate/application";
import { acceptedLyricLines, canonicalJson, normalizeLyricLineIdentityV1 } from "@pirate/domain";

export const STUDY_CORPUS_CANDIDATE_PLANNER_V1 = "study_corpus_candidate_planner_v1" as const;
export const STUDY_CORPUS_PENDING_REVIEWER = "pending_bilingual_reviewer" as const;

type CorpusCategory = (typeof STUDY_TRANSLATION_CORPUS_CATEGORIES)[number];
type CorpusItem = StudyTranslationCorpusV1["items"][number];

export type PlannedStudyUnit = Readonly<{
  studyUnitId: string;
  lyricLineId: string;
  lineVersion: 1;
  sourceHash: string;
  sourceText: string;
  previousContext: string | null;
  nextContext: string | null;
  occurrenceCount: number;
}>;

export type PlannedCorpusSong = Readonly<{
  songId: string;
  postId: string;
  lyricsRevision: 1;
  lyricsSourceHash: string;
  contextLines: StudyLanguageProfileRequest["contextLines"];
  selectedUnits: readonly PlannedStudyUnit[];
  profileRequest: StudyLanguageProfileRequest;
}>;

export type GeneratedCorpusSong = Readonly<{
  plan: PlannedCorpusSong;
  analysis: StudyLanguageProfileAnalysis;
  request: StudyTranslationGenerationRequest;
  proposal: StudyTranslationGenerationProposal;
}>;

export type CorpusQuotaReport = Readonly<{
  sampleCount: number;
  songCount: number;
  categoryCounts: Readonly<Record<CorpusCategory, number>>;
  missingCategories: readonly CorpusCategory[];
}>;

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}_${digest(value).slice(0, 32)}`;

export const planStudyCorpusSong = (input: {
  readonly songName: string;
  readonly lyrics: string;
  readonly maximumUnits: number;
}): PlannedCorpusSong => {
  if (
    input.songName.length === 0 ||
    input.songName !== input.songName.trim() ||
    !Number.isInteger(input.maximumUnits) ||
    input.maximumUnits < 1 ||
    input.maximumUnits > 256
  ) {
    throw new TypeError("invalid corpus song planning input");
  }
  const canonicalLines = acceptedLyricLines(input.lyrics);
  if (canonicalLines.length === 0 || canonicalLines.length > 10_000) {
    throw new TypeError("song has no bounded accepted lyrics");
  }

  const lyricsSourceHash = digest({
    policy: STUDY_CORPUS_CANDIDATE_PLANNER_V1,
    lyrics: input.lyrics,
  });
  const songId = stableId("offline_song", { songName: input.songName, lyricsSourceHash });
  const postId = stableId("offline_post", { songId });
  const occurrences = canonicalLines.map((sourceText, index) => {
    const normalizedText = normalizeLyricLineIdentityV1(sourceText);
    return {
      ordinal: index + 1,
      lyricLineId: stableId("offline_line", { songId, ordinal: index + 1 }),
      lineVersion: 1 as const,
      studyUnitId: stableId("offline_unit", { songId, normalizedText }),
      sourceHash: digest({
        policy: STUDY_CORPUS_CANDIDATE_PLANNER_V1,
        songId,
        normalizedText,
      }),
      sourceText,
    };
  });
  const counts = new Map<string, number>();
  for (const occurrence of occurrences) {
    counts.set(occurrence.studyUnitId, (counts.get(occurrence.studyUnitId) ?? 0) + 1);
  }
  const firstByUnit = new Map<string, (typeof occurrences)[number]>();
  for (const occurrence of occurrences) {
    if (!firstByUnit.has(occurrence.studyUnitId))
      firstByUnit.set(occurrence.studyUnitId, occurrence);
  }
  const selectedUnits = [...firstByUnit.values()].slice(0, input.maximumUnits).map((unit) => ({
    studyUnitId: unit.studyUnitId,
    lyricLineId: unit.lyricLineId,
    lineVersion: unit.lineVersion,
    sourceHash: unit.sourceHash,
    sourceText: unit.sourceText,
    previousContext: occurrences[unit.ordinal - 2]?.sourceText ?? null,
    nextContext: occurrences[unit.ordinal]?.sourceText ?? null,
    occurrenceCount: counts.get(unit.studyUnitId) ?? 1,
  }));
  const contextLines = occurrences.map(
    ({ ordinal, lyricLineId, lineVersion, studyUnitId, sourceText }) => ({
      ordinal,
      lyricLineId,
      lineVersion,
      studyUnitId,
      sourceText,
    }),
  );
  const profileRequest: StudyLanguageProfileRequest = {
    communityId: "offline_corpus",
    postId,
    lyricsRevision: 1,
    sourceHash: lyricsSourceHash,
    primaryLanguageHint: "en",
    secondaryLanguageHint: null,
    contextLines,
    units: selectedUnits.map(({ studyUnitId, sourceText }) => ({ studyUnitId, sourceText })),
  };
  return {
    songId,
    postId,
    lyricsRevision: 1,
    lyricsSourceHash,
    contextLines,
    selectedUnits,
    profileRequest,
  };
};

export const makeOfflineTranslationRequest = (input: {
  readonly plan: PlannedCorpusSong;
  readonly analysis: StudyLanguageProfileAnalysis;
  readonly targetLanguage: string;
}): StudyTranslationGenerationRequest => {
  const facts = new Map(input.analysis.units.map((fact) => [fact.studyUnitId, fact]));
  if (
    input.analysis.promptRevision !== STUDY_LANGUAGE_PROFILE_PROMPT_V2 ||
    input.analysis.validatorRevision !== STUDY_LANGUAGE_PROFILE_VALIDATOR_V2 ||
    input.targetLanguage.length === 0 ||
    input.targetLanguage !== input.targetLanguage.trim()
  ) {
    throw new TypeError("invalid offline translation request input");
  }
  const units = input.plan.selectedUnits.map((unit) => {
    const fact = facts.get(unit.studyUnitId);
    if (fact === undefined) throw new TypeError("language profile omitted a Study unit");
    return {
      ...unit,
      language: {
        detectedLanguages: fact.detectedLanguages,
        dominantLanguage: fact.dominantLanguage,
        mixed: fact.mixed,
        vocableOnly: fact.vocableOnly,
        properNameOnly: fact.properNameOnly,
      },
    };
  });
  const generationRunId = stableId("offline_generation", {
    lyricsSourceHash: input.plan.lyricsSourceHash,
    targetLanguage: input.targetLanguage,
    learnerBand: "B1",
    promptRevision: STUDY_TRANSLATION_PROMPT_V2,
  });
  return {
    generationRunId,
    communityId: "offline_corpus",
    postId: input.plan.postId,
    lyricsRevision: input.plan.lyricsRevision,
    lyricsSourceHash: input.plan.lyricsSourceHash,
    languageProfileRevision: 1,
    learningLanguage: "en",
    targetLanguage: input.targetLanguage,
    learnerBand: "B1",
    promptRevision: STUDY_TRANSLATION_PROMPT_V2,
    qualityPolicyRevision: "offline_evaluation_v1",
    rightsPolicyRevision: "accepted_lyrics_offline_evaluation_v1",
    contextLines: input.plan.contextLines,
    units,
  };
};

const lexicalTokens = (value: string): readonly string[] =>
  [...value.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(([token]) => token);

const categoriesFor = (
  unit: PlannedStudyUnit,
  fact: StudyTranslationGenerationRequest["units"][number]["language"],
  targetLanguage: string,
): readonly CorpusCategory[] => {
  const selected = new Set<CorpusCategory>();
  const tokens = lexicalTokens(unit.sourceText);
  if (tokens.length <= 3) selected.add("short_line");
  if (unit.occurrenceCount > 1) selected.add("repeated_chorus");
  if (/\b\p{L}+(?:n't|'(?:m|re|s|ve|d|ll))\b/iu.test(unit.sourceText)) {
    selected.add("contraction");
  }
  if (/[^\p{L}\p{N}\s]/u.test(unit.sourceText)) selected.add("punctuation");
  if (fact.mixed) selected.add("mixed_language");
  if (fact.vocableOnly) selected.add("vocable_only");
  if (fact.properNameOnly) selected.add("proper_name");
  if (
    !fact.mixed &&
    fact.detectedLanguages.length === 1 &&
    fact.detectedLanguages[0] === targetLanguage
  ) {
    selected.add("already_target_language");
  }
  if (selected.size === 0) selected.add("ordinary");
  return STUDY_TRANSLATION_CORPUS_CATEGORIES.filter((category) => selected.has(category));
};

export const buildUnreviewedStudyTranslationCorpus = (input: {
  readonly generatedSongs: readonly GeneratedCorpusSong[];
  readonly targetLanguage: string;
}): StudyTranslationCorpusV1 => {
  if (input.generatedSongs.length === 0) throw new TypeError("corpus has no generated songs");
  const items: CorpusItem[] = [];
  for (const generated of input.generatedSongs) {
    const planned = new Map(generated.plan.selectedUnits.map((unit) => [unit.studyUnitId, unit]));
    const requested = new Map(generated.request.units.map((unit) => [unit.studyUnitId, unit]));
    for (const proposed of generated.proposal.units) {
      const plan = planned.get(proposed.study_unit_id);
      const request = requested.get(proposed.study_unit_id);
      if (plan === undefined || request === undefined) {
        throw new TypeError("validated proposal contains an unknown Study unit");
      }
      items.push({
        song_id: generated.plan.songId,
        post_id: generated.plan.postId,
        lyrics_revision: generated.plan.lyricsRevision,
        study_unit_id: proposed.study_unit_id,
        source_hash: proposed.source_hash,
        generation_run_id: generated.proposal.generation_run_id,
        candidate_hash: digest(proposed),
        categories: [...categoriesFor(plan, request.language, input.targetLanguage)],
        expected_disposition: proposed.status,
        candidate_disposition: proposed.status,
        human_reviewed: false,
        schema_correct: true,
        source_binding_correct: true,
        answer_key_secrecy_correct: true,
        stale_write_correct: true,
        semantic_correct: null,
        no_second_correct_choice: null,
        naturalness: null,
        register_preserved: null,
        explanation_accurate: null,
        learner_band_fit: null,
        distractors_plausible_and_wrong: null,
        critical_defects: [],
      });
    }
  }
  return {
    schema_revision: STUDY_TRANSLATION_CORPUS_V1,
    corpus_revision: stableId("offline_corpus", {
      targetLanguage: input.targetLanguage,
      learnerBand: "B1",
      items: items.map(({ candidate_hash }) => candidate_hash),
    }),
    target_language: input.targetLanguage,
    learner_band: "B1",
    prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
    validator_revision: STUDY_TRANSLATION_VALIDATOR_V2,
    reviewer_role: STUDY_CORPUS_PENDING_REVIEWER,
    reviewed_at: "pending",
    items,
  };
};

export const buildStudyTranslationCorpusCandidateDocument = (input: {
  readonly generatedSongs: readonly GeneratedCorpusSong[];
  readonly targetLanguage: string;
}): StudyTranslationCorpusCandidateDocumentV1 => ({
  schema_revision: STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V1,
  planner_revision: STUDY_CORPUS_CANDIDATE_PLANNER_V1,
  corpus: buildUnreviewedStudyTranslationCorpus(input),
  generated_songs: input.generatedSongs.map(({ plan, proposal }) => ({
    song_id: plan.songId,
    post_id: plan.postId,
    proposal,
  })),
});

export const studyTranslationCorpusQuotaReport = (
  corpus: StudyTranslationCorpusV1,
): CorpusQuotaReport => {
  const categoryCounts = Object.fromEntries(
    STUDY_TRANSLATION_CORPUS_CATEGORIES.map((category) => [category, 0]),
  ) as Record<CorpusCategory, number>;
  for (const item of corpus.items) {
    for (const category of item.categories) categoryCounts[category] += 1;
  }
  return {
    sampleCount: corpus.items.length,
    songCount: new Set(corpus.items.map(({ song_id }) => song_id)).size,
    categoryCounts,
    missingCategories: STUDY_TRANSLATION_CORPUS_CATEGORIES.filter(
      (category) => categoryCounts[category] === 0,
    ),
  };
};
