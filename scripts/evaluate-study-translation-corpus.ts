import { evaluateStudyTranslationCorpus } from "@pirate/application";

const inputPath = process.argv[2];
if (inputPath === undefined || inputPath.length === 0) {
  console.error("usage: bun run evaluate:study-translation-corpus <corpus.json>");
  process.exit(2);
}

const input = await Bun.file(inputPath)
  .json()
  .catch(() => undefined);
const evaluation = evaluateStudyTranslationCorpus(input);
console.log(JSON.stringify(evaluation, null, 2));
process.exit(evaluation.eligibleForHumanActivation ? 0 : 1);
