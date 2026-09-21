import { canonicalTextModerationInput } from "@pirate/domain";
import { Effect } from "effect";
import type { MediaProcessingProviders } from "../../application/src/media/processing-contracts";

import type {
  MediaTransformProbeInput,
  MediaTransformProbeOutcome,
  MediaTransformVideoProbeInput,
  MediaTransformVideoProbeOutcome,
} from "../../application/src/media/transform";

function probe(input: MediaTransformProbeInput): Effect.Effect<MediaTransformProbeOutcome>;
function probe(
  input: MediaTransformVideoProbeInput,
): Effect.Effect<MediaTransformVideoProbeOutcome>;
function probe(
  input: MediaTransformProbeInput | MediaTransformVideoProbeInput,
): Effect.Effect<MediaTransformProbeOutcome | MediaTransformVideoProbeOutcome> {
  if (input.version === "media-transform-video-probe-input-v1")
    return Effect.die(new Error("unexpected video"));
  return Effect.succeed({
    status: "completed",
    attempt: { ...input.attempt, providerJobId: "fixture-probe" },
    context: {
      ...input.binding,
      version: "media-transform-attempt-context-v1",
      adapterRevision: "fixture-v1",
    },
    probe: {
      version: "media-transform-probe-v1",
      durationMs: 180000,
      container: "mp3",
      mimeType: "audio/mpeg",
      tracks: [
        {
          kind: "audio",
          codec: "mp3",
          channels: 2,
          sampleRateHz: 44100,
          bitrateBps: 192000,
          bitrateMode: "constant",
        },
      ],
    },
  });
}

/** Local provider responses; persistence and interpreter remain real. */
export const songInterpreterProviders: MediaProcessingProviders = {
  transform: {
    probe,
    extractAudioSample: (input) =>
      Effect.succeed({
        status: "completed",
        attempt: { ...input.attempt, providerJobId: "fixture-sample" },
        context: {
          ...input.binding,
          version: "media-transform-attempt-context-v1",
          adapterRevision: "fixture-v1",
        },
        artifact: {
          version: "media-transform-sample-artifact-v1",
          objectKey: `sample/${input.variant}`,
          contentType: "audio/mpeg",
          byteLength: 4,
          offsetMs: 42000,
          durationMs: 12000,
          variant: input.variant,
          retainedObjectVerification: "required",
        },
      }),
    extractCanonicalAudioSegment: () => Effect.die(new Error("unexpected segment")),
    alignVideoSoundtrackToSong: () => Effect.die(new Error("unexpected video")),
    extractVideoAudio: () => Effect.die(new Error("unexpected video")),
    extractVideoFrames: () => Effect.die(new Error("unexpected video")),
    cancelJob: () => Effect.die(new Error("unexpected cancellation")),
  },
  artifactReader: {
    readAudioSample: async () => new Uint8Array([1, 2, 3, 4]),
    readCoverArtifact: async () => {
      throw new Error("unexpected cover");
    },
  },
  identification: {
    identify: (input) =>
      Effect.succeed({
        outcome: "no_match",
        context: {
          version: "media-identification-attempt-context-v1",
          operationId: input.operationId,
          audioRevision: input.audioRevision,
          analysisRevision: input.analysisRevision,
          canonicalAudioSha256: input.canonicalAudioSha256,
          requestId: input.requestId,
          adapterRevision: "fixture-v1",
        },
      }),
  },
  metadata: {
    extract: async () => ({
      evidenceRef: "fixture-metadata",
      adapterRevision: "fixture-v1",
      trackTitle: "Fixture song",
      cover: { status: "absent", reasonCode: "not_embedded" },
    }),
  },
  textModeration: {
    evaluate: (input) => {
      const canonical = canonicalTextModerationInput(input);
      if (canonical.kind !== "accepted") throw new Error("invalid moderation fixture");
      return Effect.succeed({
        provider_id: "openai",
        requested_model: "omni-moderation-2024-09-26",
        returned_model: "omni-moderation-2024-09-26",
        input_sha256: canonical.sha256,
        matched_categories: [],
        inputs: [],
      });
    },
  },
  imageModeration: { evaluateImage: () => Effect.die(new Error("unexpected cover")) },
  classifier: {
    classify: (input) =>
      Effect.succeed({
        version: "media-explicitness-classifier-result-v1",
        status: "classified",
        explicitness: "not_explicit",
        primary_language_bcp47: "en",
        secondary_language_bcp47: null,
        confidence: { explicitness: 0.98, primary_language: 0.97, secondary_language: null },
        evidence: [
          { kind: "explicitness", confidence: 0.98 },
          { kind: "primary_language", confidence: 0.97 },
        ],
        lyrics_identity: {
          operation_id: input.accepted_lyrics.operation_id,
          audio_revision: input.accepted_lyrics.audio_revision,
          lyrics_revision: input.accepted_lyrics.lyrics_revision,
          canonical_audio_sha256: input.accepted_lyrics.canonical_audio_sha256,
        },
        attempt_id: input.attempt.attempt_id,
        policy_revision: "fixture-v1",
        prompt_revision: "fixture-v1",
        classifier_revision: "fixture-v1",
        adapter_revision: "fixture-v1",
      }),
  },
  alignment: {
    align: async () => {
      throw new Error("alignment is a separate Workflow");
    },
  },
};
