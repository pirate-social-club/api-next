import { open, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  evaluateStudyTranslationCorpusV2,
  makeStudyLanguageProfileAnalyzer,
  StudyTranslationApplicabilityPolicyV2,
  type StudyTranslationApplicabilityPolicyV2 as StudyTranslationApplicabilityPolicyV2Type,
  validateStudyTranslationProposal,
} from "@pirate/application";
import { canonicalJson } from "@pirate/domain";
import {
  makeOpenRouterStudyLanguageProfileTransport,
  makeOpenRouterStudyTranslationTransport,
} from "@pirate/platform-cf/study-openrouter-generation";
import { Effect, Schema } from "effect";
import { measureStudySongLibraryV1 } from "./study-translation-corpus-applicability.ts";
import {
  buildStudyTranslationCorpusCandidateDocumentV2,
  type GeneratedCorpusSong,
  makeOfflineTranslationRequest,
  planStudyCorpusSong,
} from "./study-translation-corpus-candidates.ts";

type Options = Readonly<{
  songsRoot: string;
  songs: readonly string[];
  targetLanguage: string;
  maximumUnits: number;
  execute: boolean;
  model: string | null;
  provider: string | null;
  outputPath: string | null;
  applicabilityPolicyPath: string | null;
  overwrite: boolean;
}>;

const usage = `usage:
  bun run generate:study-translation-candidates --songs-root <dir> --song <name> [--song <name> ...]
    --target-language <bcp47> [--max-units <1-256; default 256>]
    [--applicability-policy <file>]
    [--execute --model <model> --provider <provider> --output <file> [--overwrite]]

Without --execute the command performs a provider-free deterministic plan only.
Provider execution reads OPENROUTER_API_KEY and processes songs sequentially.`;

const valueAfter = (arguments_: readonly string[], index: number, flag: string): string => {
  const value = arguments_[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new TypeError(`missing value for ${flag}`);
  }
  return value;
};

export const parseStudyCorpusCandidateArguments = (arguments_: readonly string[]): Options => {
  let songsRoot: string | null = null;
  const songs: string[] = [];
  let targetLanguage: string | null = null;
  let maximumUnits = 256;
  let execute = false;
  let model: string | null = null;
  let provider: string | null = null;
  let outputPath: string | null = null;
  let applicabilityPolicyPath: string | null = null;
  let overwrite = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === "--execute") execute = true;
    else if (flag === "--overwrite") overwrite = true;
    else if (flag === "--songs-root") songsRoot = valueAfter(arguments_, index++, flag);
    else if (flag === "--song") songs.push(valueAfter(arguments_, index++, flag));
    else if (flag === "--target-language") {
      targetLanguage = valueAfter(arguments_, index++, flag);
    } else if (flag === "--max-units") {
      maximumUnits = Number(valueAfter(arguments_, index++, flag));
    } else if (flag === "--model") model = valueAfter(arguments_, index++, flag);
    else if (flag === "--provider") provider = valueAfter(arguments_, index++, flag);
    else if (flag === "--output") outputPath = valueAfter(arguments_, index++, flag);
    else if (flag === "--applicability-policy") {
      applicabilityPolicyPath = valueAfter(arguments_, index++, flag);
    } else throw new TypeError(`unknown argument: ${flag ?? ""}`);
  }
  if (
    songsRoot === null ||
    songs.length === 0 ||
    targetLanguage === null ||
    !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$/u.test(
      targetLanguage,
    ) ||
    !Number.isInteger(maximumUnits) ||
    maximumUnits < 1 ||
    maximumUnits > 256 ||
    songs.some((song) => song !== basename(song))
  ) {
    throw new TypeError("invalid candidate-generation arguments");
  }
  if (
    execute &&
    (model === null ||
      provider === null ||
      outputPath === null ||
      applicabilityPolicyPath === null ||
      model !== model.trim() ||
      provider !== provider.trim())
  ) {
    throw new TypeError("provider execution requires exact model, provider, and output values");
  }
  if (!execute && overwrite) throw new TypeError("overwrite is valid only with --execute");
  return {
    songsRoot: resolve(songsRoot),
    songs,
    targetLanguage,
    maximumUnits,
    execute,
    model,
    provider,
    outputPath: outputPath === null ? null : resolve(outputPath),
    applicabilityPolicyPath:
      applicabilityPolicyPath === null ? null : resolve(applicabilityPolicyPath),
    overwrite,
  };
};

const loadApplicabilityPolicy = async (
  path: string,
): Promise<StudyTranslationApplicabilityPolicyV2Type> => {
  const unknownPolicy: unknown = JSON.parse(await readFile(path, "utf8"));
  return Schema.decodeUnknownSync(StudyTranslationApplicabilityPolicyV2, {
    onExcessProperty: "error",
  })(unknownPolicy);
};

const loadPlans = async (options: Options) => {
  const plans = [];
  for (const song of options.songs) {
    const lyricsPath = join(options.songsRoot, song, "lyrics.txt");
    const lyrics = await readFile(lyricsPath, "utf8");
    plans.push(planStudyCorpusSong({ songName: song, lyrics, maximumUnits: options.maximumUnits }));
  }
  return plans;
};

const exactCredential = (value: string | undefined): string => {
  if (value === undefined || value.length === 0 || value !== value.trim() || value.length > 4_096) {
    throw new TypeError("OPENROUTER_API_KEY is unavailable");
  }
  return value;
};

export const writeStudyCorpusCandidate = async (input: {
  readonly outputPath: string;
  readonly overwrite: boolean;
  readonly candidateDocument: unknown;
}): Promise<void> => {
  const handle = await open(input.outputPath, input.overwrite ? "w" : "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(input.candidateDocument, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const runStudyCorpusCandidateCommand = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, unknown>>> => {
  const options = parseStudyCorpusCandidateArguments(arguments_);
  const plans = await loadPlans(options);
  const applicabilityPolicy =
    options.applicabilityPolicyPath === null
      ? null
      : await loadApplicabilityPolicy(options.applicabilityPolicyPath);
  if (
    applicabilityPolicy !== null &&
    applicabilityPolicy.target_language !== options.targetLanguage
  ) {
    throw new TypeError("applicability policy target does not match the requested target");
  }
  if (applicabilityPolicy !== null) {
    const currentMeasurement = await measureStudySongLibraryV1(options.songsRoot);
    if (
      canonicalJson(currentMeasurement) !== canonicalJson(applicabilityPolicy.library_measurement)
    ) {
      throw new TypeError("song library changed after applicability measurement");
    }
  }
  const planSummary = {
    mode: options.execute ? "execute" : "plan",
    target_language: options.targetLanguage,
    learner_band: "B1",
    song_count: plans.length,
    selected_unit_count: plans.reduce((sum, plan) => sum + plan.selectedUnits.length, 0),
    applicability_policy_revision: applicabilityPolicy?.policy_revision ?? null,
    library_sha256: applicabilityPolicy?.library_measurement.library_sha256 ?? null,
    songs: plans.map((plan, index) => ({
      name: options.songs[index],
      song_id: plan.songId,
      lyrics_source_hash: plan.lyricsSourceHash,
      occurrence_count: plan.contextLines.length,
      selected_unit_count: plan.selectedUnits.length,
    })),
  } as const;
  if (!options.execute) return planSummary;
  if (applicabilityPolicy === null) {
    throw new TypeError("provider execution requires an applicability policy");
  }

  const apiKey = exactCredential(environment.OPENROUTER_API_KEY);
  const providerOptions = {
    enabled: true,
    apiKey,
    model: options.model as string,
    providerPolicy: {
      requireParameters: true,
      dataCollection: "deny",
      zdr: true,
      allowFallbacks: false,
      order: [options.provider as string],
      only: [options.provider as string],
    },
    accountPluginsDisabled: true,
  } as const;
  const analyzer = makeStudyLanguageProfileAnalyzer(
    makeOpenRouterStudyLanguageProfileTransport(providerOptions),
  );
  const translationTransport = makeOpenRouterStudyTranslationTransport(providerOptions);
  const generatedSongs: GeneratedCorpusSong[] = [];
  for (const plan of plans) {
    const analysis = await Effect.runPromise(analyzer.analyze(plan.profileRequest));
    const request = makeOfflineTranslationRequest({
      plan,
      analysis,
      targetLanguage: options.targetLanguage,
    });
    const transported = await Effect.runPromise(translationTransport.generate(request));
    const proposal = await Effect.runPromise(
      validateStudyTranslationProposal(request, transported),
    );
    generatedSongs.push({ plan, analysis, request, proposal });
  }
  const candidateDocument = buildStudyTranslationCorpusCandidateDocumentV2({
    generatedSongs,
    targetLanguage: options.targetLanguage,
    applicabilityPolicy,
  });
  const evaluation = evaluateStudyTranslationCorpusV2(candidateDocument);
  if (evaluation.schemaRevision === null || evaluation.eligibleForActivation) {
    throw new TypeError("unreviewed corpus did not remain in evaluation");
  }
  await writeStudyCorpusCandidate({
    outputPath: options.outputPath as string,
    overwrite: options.overwrite,
    candidateDocument,
  });
  return {
    ...planSummary,
    output_path: options.outputPath,
    corpus_revision: candidateDocument.corpus.corpus_revision,
    quota_report: {
      sample_count: evaluation.sampleCount,
      song_count: evaluation.songCount,
      categories: evaluation.categoryQuotas,
      missing_required_categories: evaluation.missingRequiredCategories,
      opportunistic_shortfalls: evaluation.opportunisticShortfalls,
      not_applicable_categories: evaluation.notApplicableCategories,
    },
    evaluation,
  };
};

if (import.meta.main) {
  runStudyCorpusCandidateCommand(process.argv.slice(2))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "candidate generation failed");
      console.error(usage);
      process.exitCode = 1;
    });
}
