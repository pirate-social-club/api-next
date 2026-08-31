import {
  evaluateStudyTranslationCorpus,
  evaluateStudyTranslationCorpusV2,
  STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V2,
  STUDY_TRANSLATION_CORPUS_V2,
} from "@pirate/application";

const inputPath = process.argv[2];
if (inputPath === undefined || inputPath.length === 0) {
  console.error("usage: bun run evaluate:study-translation-corpus <corpus.json>");
  process.exit(2);
}

const input = await Bun.file(inputPath)
  .json()
  .catch(() => undefined);
const inputRevision =
  typeof input === "object" && input !== null && "schema_revision" in input
    ? input.schema_revision
    : null;
const isV2 =
  inputRevision === STUDY_TRANSLATION_CORPUS_V2 ||
  inputRevision === STUDY_TRANSLATION_CORPUS_CANDIDATE_DOCUMENT_V2;
const evaluation = isV2
  ? evaluateStudyTranslationCorpusV2(input)
  : evaluateStudyTranslationCorpus(input);
console.log(JSON.stringify(evaluation, null, 2));
process.exit(
  "eligibleForActivation" in evaluation
    ? evaluation.eligibleForActivation
      ? 0
      : 1
    : evaluation.eligibleForHumanActivation
      ? 0
      : 1,
);
