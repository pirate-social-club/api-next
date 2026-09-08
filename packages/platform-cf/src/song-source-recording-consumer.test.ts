import type { SongSourceRegistration } from "@pirate/application/media/source-recording-authority";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { consumeSongSourceRecording } from "./song-source-recording-consumer";
import type { SongSourceRecordingRepository } from "./song-source-recording-repository";

const registration: SongSourceRegistration = {
  registrationId: "registration-1",
  assetId: "post-1",
  submissionId: "submission-1",
  operationId: "operation-1",
  audioRevision: 1,
  analysisRevision: 1,
  publicationRevision: 1,
  termsRevision: 1,
  canonicalAudioSha256: "a".repeat(64),
  immutableAudioRef: "media://immutable/source.mp3",
  verificationSample: { objectKey: "sample.mp3", contentType: "audio/mpeg", byteLength: 1 },
  provider: "acrcloud",
  bucketId: "8891",
  opaqueTitle: "pirate-registration-1",
  state: "pending_upload",
  providerFileId: null,
  providerMatchId: null,
  claimOwner: "worker-1",
  claimFence: 1n,
};

function repository(claimed: SongSourceRegistration | null): SongSourceRecordingRepository {
  return {
    listEligible: async () => [],
    claim: async () => claimed,
    get: async () => claimed,
    acceptProviderFile: async () => true,
    markProviderOutcomeUnknown: async () => true,
    markReady: async () => true,
    fail: async () => true,
  };
}

const dependencies = (claimed: SongSourceRegistration | null) => ({
  repository: repository(claimed),
  leaseSeconds: 300,
  workflow: {
    enabled: true,
    workerId: "worker-1",
    adapterRevision: "acrcloud-adapter-v1",
    catalog: {
      findExact: async () => ({ outcome: "retryable" as const, reason: "transport" }),
      upload: async () => ({ outcome: "retryable" as const, reason: "transport" }),
      get: async () => ({ outcome: "retryable" as const, reason: "transport" }),
    },
    audio: {
      readCanonical: async () => ({
        bytes: new Uint8Array([1]),
        filename: "source.mp3",
        contentType: "audio/mpeg",
      }),
      readVerificationSample: async () => ({
        bytes: new Uint8Array([1]),
        filename: "sample.mp3",
        contentType: "audio/mpeg",
      }),
    },
    identification: {
      identify: () => Effect.die(new Error("identification should not run")),
    },
  },
});

describe("song source recording queue consumer", () => {
  test("rejects messages outside the closed identifier shape", async () => {
    expect(
      await consumeSongSourceRecording(
        { kind: "song_source_recording", registration_id: "registration-1", asset_id: "post-1" },
        dependencies(registration),
      ),
    ).toBe("dlq");
  });

  test("acknowledges an already-claimed or no-longer-eligible replay", async () => {
    expect(
      await consumeSongSourceRecording(
        { kind: "song_source_recording", registration_id: "registration-1" },
        dependencies(null),
      ),
    ).toBe("ack");
  });

  test("advances a claimed registration and leaves retry timing durable", async () => {
    expect(
      await consumeSongSourceRecording(
        { kind: "song_source_recording", registration_id: "registration-1" },
        dependencies(registration),
      ),
    ).toBe("ack");
  });
});
