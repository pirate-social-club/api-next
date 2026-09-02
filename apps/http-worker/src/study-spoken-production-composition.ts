import {
  makeElevenLabsStudyBatchTranscriber,
  makeR2StudyAudioArchive,
  type StudyAudioBucket,
  type StudyBatchFetch,
} from "@pirate/platform-cf/study-spoken-audio";

type StudyAudioArchive = ReturnType<typeof makeR2StudyAudioArchive>;
type StudyBatchTranscriber = ReturnType<typeof makeElevenLabsStudyBatchTranscriber>;

export interface StudySpokenProductionBindings {
  readonly ELEVENLABS_API_KEY?: string;
  readonly LEARNER_AUDIO?: StudyAudioBucket;
}

export interface StudySpokenProductionDependencies {
  readonly study_audio_archive?: StudyAudioArchive;
  readonly study_batch_fetch?: StudyBatchFetch;
  readonly study_batch_transcriber?: StudyBatchTranscriber;
}

export function makeProductionStudySpokenServices(
  bindings: StudySpokenProductionBindings,
  dependencies: StudySpokenProductionDependencies = {},
):
  | Readonly<{
      readonly archive: StudyAudioArchive;
      readonly transcriber: StudyBatchTranscriber;
    }>
  | undefined {
  const injectedTranscriber = dependencies.study_batch_transcriber;
  if (injectedTranscriber !== undefined) {
    return {
      transcriber: injectedTranscriber,
      archive: dependencies.study_audio_archive ?? makeR2StudyAudioArchive(bindings.LEARNER_AUDIO),
    };
  }

  const apiKey = bindings.ELEVENLABS_API_KEY;
  if (apiKey === undefined || apiKey === "" || apiKey.trim() !== apiKey) return undefined;
  return {
    transcriber: makeElevenLabsStudyBatchTranscriber({
      apiKey,
      ...(dependencies.study_batch_fetch === undefined
        ? {}
        : { fetch: dependencies.study_batch_fetch }),
    }),
    archive: dependencies.study_audio_archive ?? makeR2StudyAudioArchive(bindings.LEARNER_AUDIO),
  };
}
