import type { ControlPlaneDb, ControlPlaneError, StudyBatchTranscriber } from "@pirate/application";
import type { ControlledAccountSpokenProtocol } from "@pirate/application/controlled-account-spoken";
import { makeControlledAccountSpokenService } from "@pirate/application/controlled-account-spoken";
import type { Layer } from "effect";
import { makeAccountControlledSpokenProtocol } from "./account-spoken-producer-protocol.ts";
import { makeControlledAccountStudyV2Store } from "./controlled-account-study-store.ts";
import { withHnsAuthoritySpan } from "./hns-authority-diagnostics.ts";
import type { CapturedStudyAudioBucket } from "./learner-audio-captured-io.ts";
import type { StudyV2Admission } from "./study-v2-repository.ts";
export const makeControlledAccountSpokenComposition = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  bucket: CapturedStudyAudioBucket,
  transcriber: StudyBatchTranscriber | null,
  rerecordEnabled: boolean,
  retainTask: (task: Promise<unknown>) => void,
  admission?: StudyV2Admission,
) => {
  const store = makeControlledAccountStudyV2Store(runtime, admission);
  const protocol = makeAccountControlledSpokenProtocol(
    runtime,
    store.reserve,
    store.finalize,
    bucket,
    retainTask,
  );
  const observedProtocol: ControlledAccountSpokenProtocol = {
    ...protocol,
    archive: (input) => withHnsAuthoritySpan("study_archive", protocol.archive(input)),
  };
  const observedTranscriber: StudyBatchTranscriber | null =
    transcriber === null
      ? null
      : {
          ...transcriber,
          transcribe: (input) =>
            withHnsAuthoritySpan("study_transcription", transcriber.transcribe(input)),
        };
  return {
    store: store.ordinary,
    spoken: makeControlledAccountSpokenService(
      store.ordinary,
      observedProtocol,
      observedTranscriber,
      rerecordEnabled,
    ),
    protocol: observedProtocol,
  };
};
