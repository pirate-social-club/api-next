import {
  makeElevenLabsStudyBatchTranscriber,
  type StudyAudioBucket,
  type StudyBatchFetch,
} from "@pirate/platform-cf/study-spoken-audio";

type StudyBatchTranscriber = ReturnType<typeof makeElevenLabsStudyBatchTranscriber>;
export interface StudySpokenProductionBindings {
  readonly ELEVENLABS_API_KEY?: string;
  readonly LEARNER_AUDIO?: StudyAudioBucket;
}
export interface StudySpokenProductionDependencies {
  readonly study_batch_fetch?: StudyBatchFetch;
  readonly study_batch_transcriber?: StudyBatchTranscriber;
}
/** A real archive binding is required for foreground continuation. Missing current
 * transcription configuration closes NEW dispatch, not retained-checkpoint replay. */
export function makeProductionStudySpokenServices(
  bindings: StudySpokenProductionBindings,
  dependencies: StudySpokenProductionDependencies = {},
): Readonly<{ bucket: StudyAudioBucket; transcriber: StudyBatchTranscriber | null }> | undefined {
  const bucket = bindings.LEARNER_AUDIO;
  if (bucket === undefined) return undefined;
  if (dependencies.study_batch_transcriber !== undefined)
    return { bucket, transcriber: dependencies.study_batch_transcriber };
  const key = bindings.ELEVENLABS_API_KEY;
  if (key === undefined || key === "" || key.trim() !== key) return { bucket, transcriber: null };
  return {
    bucket,
    transcriber: makeElevenLabsStudyBatchTranscriber({
      apiKey: key,
      ...(dependencies.study_batch_fetch === undefined
        ? {}
        : { fetch: dependencies.study_batch_fetch }),
    }),
  };
}
