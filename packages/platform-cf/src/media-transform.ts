/** Provider-neutral disabled implementation of the application media-transform port. */
import type {
  MediaTransformProbeInput,
  MediaTransformService,
  MediaTransformVideoProbeInput,
} from "@pirate/application/media/transform";
import { Effect } from "effect";

export function makeDisabledMediaTransform(): MediaTransformService {
  return {
    probe: ((input: MediaTransformProbeInput | MediaTransformVideoProbeInput) =>
      Effect.succeed({
        status: "unavailable",
        reason: "disabled",
        attempt: input.attempt,
      })) as MediaTransformService["probe"],
    extractAudioSample: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
    extractVideoAudio: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
    extractVideoFrames: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", attempt: input.attempt }),
    extractCanonicalAudioSegment: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
    alignVideoSoundtrackToSong: (input) =>
      Effect.succeed({ status: "unavailable", reason: "disabled", binding: input.binding }),
    cancelJob: () => Effect.succeed({ status: "unavailable", reason: "disabled" }),
  };
}

export const disabledMediaTransform = makeDisabledMediaTransform();
