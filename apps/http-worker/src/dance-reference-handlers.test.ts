import { describe, expect, test } from "bun:test";
import type {
  CreateDanceReferenceResponse,
  DanceReferenceAuthoringAuthority,
  DanceReferenceStore,
} from "@pirate/application/use-cases/dance/reference-services";
import { makeDanceReferenceHandlers } from "./dance-reference-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const NOW = "2026-08-31T00:00:00.000Z";
const unsupported = async (): Promise<never> => {
  throw new Error("unexpected store call");
};

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

function fakeStore(create: DanceReferenceStore["create"]): DanceReferenceStore {
  return {
    lookupAction: async () => ({ kind: "miss" }),
    create,
    getProcessing: unsupported,
    append: unsupported,
    disable: unsupported,
    retire: unsupported,
    listReady: unsupported,
    getRevision: unsupported,
    setPresentation: unsupported,
    clearPresentation: unsupported,
  };
}

describe("Dance reference HTTP handlers", () => {
  test("returns after durable outbox authority with no processor in the composition", async () => {
    let durableOutboxCommits = 0;
    const handlers = makeDanceReferenceHandlers({
      store: fakeStore(async () => {
        durableOutboxCommits += 1;
        return response;
      }),
      authority: { resolve: async () => authority },
    });
    const app = createHttpWorker({
      handlers,
      authenticate: () => ({ kind: "user", subject: "account-1" }),
      authorize: () => undefined,
    });

    const result = await app.request(
      "http://api.test/communities/community-1/posts/song-1/dance/choreographies",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "create-1",
          creator_persona_id: "persona-1",
          audio_revision: 4,
          reference_video_post_id: "video-1",
          start_ms: 10_000,
          end_ms: 16_000,
          mirror_policy: "allowed",
        }),
      },
    );

    expect(result.status).toBe(202);
    expect(await result.json()).toEqual(response);
    expect(durableOutboxCommits).toBe(1);
    expect("processor" in handlers).toBe(false);
  });
});
