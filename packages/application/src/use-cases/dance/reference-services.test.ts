import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type CreateDanceReferenceResponse,
  type DanceReferenceAuthoringAuthority,
  type DanceReferenceStore,
  makeDanceReferenceService,
} from "./reference-services.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const NOW = "2026-08-31T00:00:00.000Z";

const authority: DanceReferenceAuthoringAuthority = {
  canonicalAudio: {
    objectKey: "private/song-audio",
    sha256: HASH_A,
    durationMs: 180_000,
    audioRevision: 4,
  },
  referenceVideo: {
    postId: "video-1",
    objectKey: "private/reference-video",
    sha256: HASH_B,
    durationMs: 60_000,
  },
  extraction: {
    policyVersion: "extract-v1",
    outputProfile: { sampleRateHz: 48_000, channels: 1, codec: "flac" },
  },
  alignment: {
    policyVersion: "alignment-v1",
    adapterId: "fake-alignment",
    adapterRevision: "fake-v1",
    limits: {
      maximumAbsoluteOffsetMs: 15_000,
      maximumAbsoluteDriftMs: 50,
      maximumAbsoluteSlopeDeltaPpm: 1_000,
      minimumOverallConfidenceBps: 8_000,
      minimumCoverageBps: 9_000,
      minimumSoundtrackMatchBps: 8_000,
    },
  },
  pose: {
    modelVersion: "pose-v1",
    runtimeVersion: "runtime-v1",
    featureSchemaVersion: "features-v1",
    scorerContractVersion: "scorer-v1",
    fingerprintPolicyVersion: "fingerprint-v1",
    integrityPolicyVersion: "integrity-v1",
  },
  qualityLimits: {
    minimumUsableCoverageBps: 9_000,
    maximumMissingGapSlots: 3,
    minimumBodyCoverageBps: 9_000,
    minimumVisibilityCoverageBps: 8_500,
    minimumMotionEnergyBps: 2_000,
    minimumSpatialExtentBps: 2_000,
  },
  ownerPolicy: { revision: 7, hash: HASH_A },
};

const response: CreateDanceReferenceResponse = {
  choreography: {
    object: "dance_choreography",
    choreography_id: "choreography-1",
    song_post_id: "song-1",
    creator_persona_id: "persona-1",
    status: "processing",
    active_revision: null,
    created_at: NOW,
    disabled_at: null,
    retired_at: null,
  },
  processing: {
    object: "dance_reference_processing",
    choreography_id: "choreography-1",
    revision: 1,
    song_post_id: "song-1",
    audio_revision: 4,
    reference_video_post_id: "video-1",
    start_ms: 10_000,
    end_ms: 16_000,
    mirror_policy: "allowed",
    status: "processing",
    segment: null,
    reference_video_scored_start_ms: null,
    reference_video_scored_end_ms: null,
    processing_failure_code: null,
    revision_terms_hash: HASH_A,
    created_at: NOW,
    terminal_at: null,
  },
  replayed: false,
};

const unsupported = async (): Promise<never> => {
  throw new Error("unexpected store call");
};

function store(overrides: Partial<DanceReferenceStore>): DanceReferenceStore {
  return {
    lookupAction: unsupported,
    create: unsupported,
    getProcessing: unsupported,
    append: unsupported,
    disable: unsupported,
    retire: unsupported,
    listReady: unsupported,
    getRevision: unsupported,
    setPresentation: unsupported,
    clearPresentation: unsupported,
    ...overrides,
  };
}

const body = {
  idempotency_key: "create-1",
  creator_persona_id: "persona-1",
  audio_revision: 4,
  reference_video_post_id: "video-1",
  start_ms: 10_000,
  end_ms: 16_000,
  mirror_policy: "allowed" as const,
};

describe("Dance reference application services", () => {
  test("commits initial processing through the persistence port without a processor", async () => {
    let authorityCalls = 0;
    let persisted = false;
    const service = makeDanceReferenceService({
      store: store({
        lookupAction: async () => ({ kind: "miss" }),
        create: async (input) => {
          persisted = true;
          expect(input.audioRevision).toBe(4);
          expect(input.referenceVideoPostId).toBe("video-1");
          expect(input.authority).toEqual(authority);
          return response;
        },
      }),
      authority: {
        resolve: async () => {
          authorityCalls += 1;
          return authority;
        },
      },
    });

    const result = await Effect.runPromise(
      service.create({
        actorAccountId: "account-1",
        communityId: "community-1",
        songPostId: "song-1",
        body,
      }),
    );

    expect(result).toEqual(response);
    expect(authorityCalls).toBe(1);
    expect(persisted).toBe(true);
    expect("processor" in service).toBe(false);
  });

  test("replays durable creation while production authoring authority is absent", async () => {
    let createCalls = 0;
    const service = makeDanceReferenceService({
      store: store({
        lookupAction: async () => ({ kind: "replay", response }),
        create: async () => {
          createCalls += 1;
          return response;
        },
      }),
      authority: null,
    });

    const result = await Effect.runPromise(
      service.create({
        actorAccountId: "account-1",
        communityId: "community-1",
        songPostId: "song-1",
        body,
      }),
    );

    expect(result.replayed).toBe(true);
    expect(result.choreography).toEqual(response.choreography);
    expect(createCalls).toBe(0);
  });
});
