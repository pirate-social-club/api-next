import type { ControlPlaneDb, ControlPlaneError, StudyBatchTranscriber } from "@pirate/application";
import { makeControlledAccountSpokenService } from "@pirate/application/controlled-account-spoken";
import type { Layer } from "effect";
import type { AccountOwnerRewardHooks } from "./account-owner-reward-hooks.ts";
import { makeAccountControlledSpokenProtocol } from "./account-spoken-producer-protocol.ts";
import { makeControlledAccountStudyV2Store } from "./controlled-account-study-store.ts";
import type { CapturedStudyAudioBucket } from "./learner-audio-captured-io.ts";
import type { StudyV2Admission } from "./study-v2-repository.ts";
export const makeControlledAccountSpokenComposition = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  bucket: CapturedStudyAudioBucket,
  transcriber: StudyBatchTranscriber | null,
  rerecordEnabled: boolean,
  retainTask: (task: Promise<unknown>) => void,
  admission?: StudyV2Admission,
  ownerRewards?: AccountOwnerRewardHooks,
) => {
  const store = makeControlledAccountStudyV2Store(runtime, admission, ownerRewards);
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
