import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  decodeMediaTransformCanonicalAudioSegmentInput,
  decodeMediaTransformVideoSongAlignmentInput,
  type MediaTransformCanonicalAudioSegmentInput,
  type MediaTransformCanonicalAudioSegmentOutcome,
  type MediaTransformDanceBinding,
  type MediaTransformDanceReferenceService,
  MediaTransformDanceResultInvalid,
  MediaTransformRequestInvalid,
  type MediaTransformVideoSongAlignmentInput,
  type MediaTransformVideoSongAlignmentOutcome,
  validateMediaTransformCanonicalAudioSegmentOutcome,
  validateMediaTransformVideoSongAlignmentOutcome,
} from "./transform.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);
const HASH_D = "44".repeat(32);

function binding(overrides: Partial<MediaTransformDanceBinding> = {}): MediaTransformDanceBinding {
  return {
    version: "media-transform-dance-binding-v1",
    operationId: "dance-reference:choreography-1:revision-1",
    requestId: "dance-reference-attempt-1",
    choreographyId: "choreography-1",
    choreographyRevision: 1,
    attemptNumber: 1,
    inputDigest: HASH_A,
    adapterRevision: "fake-dance-transform-v1",
    ...overrides,
  };
}

function segmentInput(
  overrides: Partial<MediaTransformCanonicalAudioSegmentInput> = {},
): MediaTransformCanonicalAudioSegmentInput {
  return decodeMediaTransformCanonicalAudioSegmentInput({
    version: "media-transform-canonical-audio-segment-input-v1",
    binding: binding(),
    canonicalAudio: {
      objectKey: "immutable/song-1/audio-r4.mp3",
      sha256: HASH_B,
      durationMs: 180_000,
      audioRevision: 4,
    },
    startMs: 10_000,
    endMs: 16_000,
    extractionPolicyVersion: "dance-segment-extraction-v1",
    outputProfile: {
      sampleRateHz: 44_100,
      channels: 1,
      codec: "pcm_s16le",
    },
    ...overrides,
  });
}

function segmentOutcome(
  input: MediaTransformCanonicalAudioSegmentInput,
  overrides: Partial<
    Extract<
      MediaTransformCanonicalAudioSegmentOutcome,
      { readonly status: "completed" }
    >["artifact"]
  > = {},
): MediaTransformCanonicalAudioSegmentOutcome {
  return {
    status: "completed",
    binding: input.binding,
    artifact: {
      objectKey: "private/dance/segments/segment-1.wav",
      sha256: HASH_C,
      sourceSha256: input.canonicalAudio.sha256,
      startMs: input.startMs,
      endMs: input.endMs,
      durationMs: input.endMs - input.startMs,
      extractionPolicyVersion: input.extractionPolicyVersion,
      transformRevision: "fake-canonical-segment-v1",
      mediaFacts: {
        durationMs: input.endMs - input.startMs,
        sampleRateHz: 44_100,
        channels: 1,
        sampleCount: Math.round(((input.endMs - input.startMs) * 44_100) / 1_000),
        codec: "pcm_s16le",
        tempoPreserved: true,
        timelineStretched: false,
      },
      resultDigest: HASH_D,
      ...overrides,
    },
  };
}

function alignmentInput(
  overrides: Partial<MediaTransformVideoSongAlignmentInput> = {},
): MediaTransformVideoSongAlignmentInput {
  return decodeMediaTransformVideoSongAlignmentInput({
    version: "media-transform-video-song-alignment-input-v1",
    binding: binding({
      operationId: "dance-alignment:choreography-1:revision-1",
      requestId: "dance-alignment-attempt-1",
      inputDigest: HASH_D,
    }),
    video: {
      objectKey: "immutable/video-1/original.mp4",
      sha256: HASH_C,
      durationMs: 90_000,
    },
    songAudio: {
      objectKey: "immutable/song-1/audio-r4.mp3",
      sha256: HASH_B,
      durationMs: 180_000,
      audioRevision: 4,
    },
    requestedStartMs: 10_000,
    requestedEndMs: 16_000,
    alignmentPolicyVersion: "dance-reference-alignment-v1",
    limits: {
      maximumAbsoluteOffsetMs: 30_000,
      maximumAbsoluteDriftMs: 50,
      maximumAbsoluteSlopeDeltaPpm: 100,
      minimumOverallConfidenceBps: 9_000,
      minimumCoverageBps: 9_500,
      minimumSoundtrackMatchBps: 9_000,
    },
    ...overrides,
  });
}

function alignmentOutcome(
  input: MediaTransformVideoSongAlignmentInput,
  overrides: Partial<
    Extract<MediaTransformVideoSongAlignmentOutcome, { readonly status: "completed" }>["alignment"]
  > = {},
): MediaTransformVideoSongAlignmentOutcome {
  const detectedSongOffsetMs = 12_500;
  return {
    status: "completed",
    binding: input.binding,
    alignment: {
      videoSha256: input.video.sha256,
      songAudioSha256: input.songAudio.sha256,
      requestedStartMs: input.requestedStartMs,
      requestedEndMs: input.requestedEndMs,
      referenceVideoScoredStartMs: input.requestedStartMs + detectedSongOffsetMs,
      referenceVideoScoredEndMs: input.requestedEndMs + detectedSongOffsetMs,
      detectedSongOffsetMs,
      alignmentPolicyVersion: input.alignmentPolicyVersion,
      alignmentRevision: "fake-alignment-v1",
      driftMetrics: {
        maximumAbsoluteDriftMs: 12,
        p95AbsoluteDriftMs: 8,
        slopeDeltaPpm: 15,
      },
      confidenceMetrics: {
        overallBps: 9_800,
        coverageBps: 10_000,
        soundtrackMatchBps: 9_900,
      },
      continuousMapping: true,
      timeStretchDetected: false,
      evidenceRef: "private/dance/alignment/evidence-1.json",
      resultDigest: HASH_A,
      ...overrides,
    },
  };
}

function replaySafeFake(): MediaTransformDanceReferenceService {
  const segmentResults = new Map<
    string,
    Readonly<{ request: string; result: MediaTransformCanonicalAudioSegmentOutcome }>
  >();
  const alignmentResults = new Map<
    string,
    Readonly<{ request: string; result: MediaTransformVideoSongAlignmentOutcome }>
  >();

  return {
    extractCanonicalAudioSegment: (input) =>
      Effect.suspend(() => {
        const request = JSON.stringify(input);
        const prior = segmentResults.get(input.binding.operationId);
        if (prior !== undefined) {
          return prior.request === request
            ? Effect.succeed(prior.result)
            : Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_binding" }));
        }
        const result = validateMediaTransformCanonicalAudioSegmentOutcome(
          input,
          segmentOutcome(input),
        );
        segmentResults.set(input.binding.operationId, { request, result });
        return Effect.succeed(result);
      }),
    alignVideoSoundtrackToSong: (input) =>
      Effect.suspend(() => {
        const request = JSON.stringify(input);
        const prior = alignmentResults.get(input.binding.operationId);
        if (prior !== undefined) {
          return prior.request === request
            ? Effect.succeed(prior.result)
            : Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_binding" }));
        }
        const result = validateMediaTransformVideoSongAlignmentOutcome(
          input,
          alignmentOutcome(input),
        );
        alignmentResults.set(input.binding.operationId, { request, result });
        return Effect.succeed(result);
      }),
  };
}

describe("Dance MediaTransform input boundary", () => {
  test("accepts exact 6000 and 30000 millisecond half-open segments", () => {
    expect(segmentInput({ startMs: 0, endMs: 6_000 }).endMs).toBe(6_000);
    expect(segmentInput({ startMs: 5_000, endMs: 35_000 }).endMs).toBe(35_000);
  });

  test("rejects out-of-range bounds, URLs, authority fields, and non-finite facts", () => {
    expect(() => segmentInput({ endMs: 15_999 })).toThrow();
    expect(() => segmentInput({ endMs: 40_001 })).toThrow();
    expect(() =>
      decodeMediaTransformCanonicalAudioSegmentInput({
        ...segmentInput(),
        canonicalAudio: {
          ...segmentInput().canonicalAudio,
          objectKey: "https://example.invalid/source.mp3",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeMediaTransformCanonicalAudioSegmentInput({
        ...segmentInput(),
        canonicalAudio: {
          ...segmentInput().canonicalAudio,
          objectKey: "immutable/song-1/../other.mp3",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeMediaTransformCanonicalAudioSegmentInput({
        ...segmentInput(),
        rewardAmount: "1000000",
      }),
    ).toThrow();
    expect(() =>
      decodeMediaTransformVideoSongAlignmentInput({
        ...alignmentInput(),
        video: { ...alignmentInput().video, durationMs: Number.POSITIVE_INFINITY },
      }),
    ).toThrow();
  });
});

describe("Dance MediaTransform result boundary", () => {
  test("accepts only a hash-, policy-, and interval-bound canonical segment", () => {
    const input = segmentInput();
    expect(
      validateMediaTransformCanonicalAudioSegmentOutcome(input, segmentOutcome(input)),
    ).toEqual(segmentOutcome(input));
    expect(() =>
      validateMediaTransformCanonicalAudioSegmentOutcome(
        input,
        segmentOutcome(input, { sourceSha256: HASH_A }),
      ),
    ).toThrow(MediaTransformDanceResultInvalid);
    expect(() =>
      validateMediaTransformCanonicalAudioSegmentOutcome(
        input,
        segmentOutcome(input, {
          mediaFacts: {
            ...(
              segmentOutcome(input) as Extract<
                MediaTransformCanonicalAudioSegmentOutcome,
                { readonly status: "completed" }
              >
            ).artifact.mediaFacts,
            sampleRateHz: 48_000,
          },
        }),
      ),
    ).toThrow(MediaTransformDanceResultInvalid);
    expect(() =>
      validateMediaTransformCanonicalAudioSegmentOutcome(
        input,
        segmentOutcome(input, { extractionPolicyVersion: "adapter-default" }),
      ),
    ).toThrow(MediaTransformDanceResultInvalid);
    expect(() =>
      validateMediaTransformCanonicalAudioSegmentOutcome(input, {
        ...segmentOutcome(input),
        rewardDecision: "qualified",
      }),
    ).toThrow();
  });

  test("accepts only a continuous, unstretched mapping of the requested interval", () => {
    const input = alignmentInput();
    expect(validateMediaTransformVideoSongAlignmentOutcome(input, alignmentOutcome(input))).toEqual(
      alignmentOutcome(input),
    );
    expect(() =>
      validateMediaTransformVideoSongAlignmentOutcome(
        input,
        alignmentOutcome(input, { referenceVideoScoredEndMs: 28_501 }),
      ),
    ).toThrow(MediaTransformDanceResultInvalid);
    expect(() =>
      validateMediaTransformVideoSongAlignmentOutcome(input, {
        ...alignmentOutcome(input),
        alignment: {
          ...(
            alignmentOutcome(input) as Extract<
              MediaTransformVideoSongAlignmentOutcome,
              { readonly status: "completed" }
            >
          ).alignment,
          timeStretchDetected: true,
        },
      }),
    ).toThrow();
    expect(() =>
      validateMediaTransformVideoSongAlignmentOutcome(
        input,
        alignmentOutcome(input, {
          confidenceMetrics: {
            overallBps: 8_999,
            coverageBps: 10_000,
            soundtrackMatchBps: 9_900,
          },
        }),
      ),
    ).toThrow(MediaTransformDanceResultInvalid);
    expect(() =>
      validateMediaTransformVideoSongAlignmentOutcome(
        input,
        alignmentOutcome(input, {
          driftMetrics: {
            maximumAbsoluteDriftMs: Number.NaN,
            p95AbsoluteDriftMs: 8,
            slopeDeltaPpm: 15,
          },
        }),
      ),
    ).toThrow();
  });
});

describe("Dance MediaTransform fake replay", () => {
  test("returns byte-identical logical replay and rejects changed input under one operation", async () => {
    const fake = replaySafeFake();
    const segment = segmentInput();
    const firstSegment = await Effect.runPromise(fake.extractCanonicalAudioSegment(segment));
    const replayedSegment = await Effect.runPromise(fake.extractCanonicalAudioSegment(segment));
    expect(replayedSegment).toBe(firstSegment);

    await expect(
      Effect.runPromise(
        fake.extractCanonicalAudioSegment(
          segmentInput({
            binding: binding({ inputDigest: HASH_D }),
            startMs: 11_000,
            endMs: 17_000,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(MediaTransformRequestInvalid);

    const alignment = alignmentInput();
    const firstAlignment = await Effect.runPromise(fake.alignVideoSoundtrackToSong(alignment));
    const replayedAlignment = await Effect.runPromise(fake.alignVideoSoundtrackToSong(alignment));
    expect(replayedAlignment).toBe(firstAlignment);
  });
});
