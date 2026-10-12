import {
  type ControlPlaneDb,
  type ControlPlaneError,
  type StudyBatchTranscriber,
} from "@pirate/application";
import { makeControlledAccountSpokenService } from "@pirate/application/controlled-account-spoken";
import type { Layer } from "effect";
import { makeControlledAccountStudyV2Store } from "./controlled-account-study-store.ts";
import { makeAccountControlledSpokenProtocol } from "./account-spoken-producer-protocol.ts";
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
  return {
    store: store.ordinary,
    spoken: makeControlledAccountSpokenService(
      store.ordinary,
      protocol,
      transcriber,
      rerecordEnabled,
    ),
    protocol,
  };
};
