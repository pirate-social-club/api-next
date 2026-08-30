import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateStudyTranslationCorpus,
  STUDY_LANGUAGE_PROFILE_PROMPT_V2,
  STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
  STUDY_TRANSLATION_PROMPT_V2,
  type StudyLanguageProfileAnalysis,
  type StudyTranslationGenerationProposal,
  validateStudyTranslationProposal,
} from "@pirate/application";
import { Effect } from "effect";
import {
  parseStudyCorpusCandidateArguments,
  runStudyCorpusCandidateCommand,
  writeStudyCorpusCandidate,
} from "./generate-study-translation-corpus-candidates.ts";
import {
  buildStudyTranslationCorpusCandidateDocument,
  makeOfflineTranslationRequest,
  planStudyCorpusSong,
  studyTranslationCorpusQuotaReport,
} from "./study-translation-corpus-candidates.ts";

const lyrics = `[Verse 1]
Hello, I'm here!
Hello, I'm here!
(Yeah)
(Instrumental Solo)
[falsetto] Sing to me [vocal ad-lib]`;

const plan = () => planStudyCorpusSong({ songName: "Fixture Song", lyrics, maximumUnits: 10 });

const analysisFor = (candidate = plan()): StudyLanguageProfileAnalysis => ({
  providerId: "fake-provider",
  providerModel: "fake-model",
  promptRevision: STUDY_LANGUAGE_PROFILE_PROMPT_V2,
  validatorRevision: STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
  units: candidate.selectedUnits.map((unit) => ({
    studyUnitId: unit.studyUnitId,
    detectedLanguages: ["en"],
    dominantLanguage: "en",
    mixed: false,
    vocableOnly: unit.sourceText === "(Yeah)",
    properNameOnly: false,
    confidence: 0.99,
  })),
});

const proposalFor = (
  request: ReturnType<typeof makeOfflineTranslationRequest>,
): StudyTranslationGenerationProposal => ({
  generation_run_id: request.generationRunId,
  provider_id: "fake-provider",
  provider_model: "fake-model",
  prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
  units: request.units.map((unit, index) => {
    const echo = {
      study_unit_id: unit.studyUnitId,
      lyric_line_id: unit.lyricLineId,
      line_version: unit.lineVersion,
      source_hash: unit.sourceHash,
      source_text: unit.sourceText,
      target_language: request.targetLanguage,
      learner_band: request.learnerBand,
      detected_languages: [...unit.language.detectedLanguages],
      dominant_language: unit.language.dominantLanguage,
      mixed: unit.language.mixed,
      vocable_only: unit.language.vocableOnly,
      proper_name_only: unit.language.properNameOnly,
    } as const;
    if (unit.language.vocableOnly) {
      return { status: "not_applicable" as const, ...echo, reason: "vocable_only" as const };
    }
    return {
      status: "ready" as const,
      ...echo,
      question: "Elige la traducción correcta.",
      translation: index === 0 ? "Hola, estoy aquí." : "Canta para mí.",
      distractors:
        index === 0
          ? (["Hola, estuve allí.", "Adiós, estoy aquí.", "Hola, estaré lejos."] as const)
          : (["Escucha atentamente.", "Canta para ellos.", "Guarda silencio."] as const),
      explanation: "La opción conserva el sentido y el tiempo verbal.",
      whole_line_translated: true,
      preserved_source_fragments: [],
    };
  }),
});

describe("offline Study translation corpus candidates", () => {
  test("plans deterministic unique units while preserving sung annotations", () => {
    const first = plan();
    const second = plan();
    expect(first).toEqual(second);
    expect(first.contextLines.map(({ sourceText }) => sourceText)).toEqual([
      "Hello, I'm here!",
      "Hello, I'm here!",
      "(Yeah)",
      "[falsetto] Sing to me [vocal ad-lib]",
    ]);
    expect(first.selectedUnits).toHaveLength(3);
    expect(first.selectedUnits[0]?.occurrenceCount).toBe(2);
    expect(first.selectedUnits[0]?.studyUnitId).toBe(first.contextLines[1]?.studyUnitId);
  });

  test("builds a structurally validated corpus that remains pending human review", async () => {
    const candidate = plan();
    const analysis = analysisFor(candidate);
    const request = makeOfflineTranslationRequest({
      plan: candidate,
      analysis,
      targetLanguage: "es",
    });
    const proposal = proposalFor(request);
    await expect(
      Effect.runPromise(validateStudyTranslationProposal(request, proposal)),
    ).resolves.toEqual(proposal);
    const candidateDocument = buildStudyTranslationCorpusCandidateDocument({
      generatedSongs: [{ plan: candidate, analysis, request, proposal }],
      targetLanguage: "es",
    });
    const corpus = candidateDocument.corpus;
    expect(candidateDocument.generated_songs[0]?.proposal.units[0]).toMatchObject({
      translation: "Hola, estoy aquí.",
      distractors: ["Hola, estuve allí.", "Adiós, estoy aquí.", "Hola, estaré lejos."],
    });
    expect(corpus.items.every(({ human_reviewed }) => !human_reviewed)).toBe(true);
    expect(corpus.items[0]?.categories).toEqual([
      "short_line",
      "repeated_chorus",
      "contraction",
      "punctuation",
    ]);
    expect(corpus.items[1]?.categories).toEqual(["short_line", "punctuation", "vocable_only"]);
    const evaluation = evaluateStudyTranslationCorpus(candidateDocument);
    expect(evaluation.releaseState).toBe("evaluation");
    expect(evaluation.failures).toContain("human_review_incomplete");
    const report = studyTranslationCorpusQuotaReport(corpus);
    expect(report.sampleCount).toBe(3);
    expect(report.categoryCounts.repeated_chorus).toBe(1);
    expect(report.missingCategories).toContain("mixed_language");
  });

  test("parses only explicit bounded execution arguments", () => {
    expect(
      parseStudyCorpusCandidateArguments([
        "--songs-root",
        "/songs",
        "--song",
        "Fixture Song",
        "--target-language",
        "es",
      ]),
    ).toMatchObject({ execute: false, maximumUnits: 10, targetLanguage: "es" });
    expect(() =>
      parseStudyCorpusCandidateArguments([
        "--songs-root",
        "/songs",
        "--song",
        "../escape",
        "--target-language",
        "es",
      ]),
    ).toThrow("invalid candidate-generation arguments");
    expect(() =>
      parseStudyCorpusCandidateArguments([
        "--songs-root",
        "/songs",
        "--song",
        "Fixture Song",
        "--target-language",
        "es",
        "--execute",
      ]),
    ).toThrow("provider execution requires");
  });

  test("performs a provider-free dry run and refuses implicit replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "study-corpus-candidates-"));
    try {
      const songDirectory = join(root, "Fixture Song");
      await mkdir(songDirectory);
      await writeFile(join(songDirectory, "lyrics.txt"), lyrics, "utf8");
      const summary = await runStudyCorpusCandidateCommand([
        "--songs-root",
        root,
        "--song",
        "Fixture Song",
        "--target-language",
        "es",
        "--max-units",
        "2",
      ]);
      expect(summary).toMatchObject({ mode: "plan", song_count: 1, selected_unit_count: 2 });

      const outputPath = join(root, "candidate.json");
      await writeStudyCorpusCandidate({
        outputPath,
        overwrite: false,
        candidateDocument: { first: true },
      });
      await expect(
        writeStudyCorpusCandidate({
          outputPath,
          overwrite: false,
          candidateDocument: { second: true },
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({ first: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
