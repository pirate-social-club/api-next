import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { MediaIdentificationOutcome } from "../media-identification-provider";
import {
  advanceSongSourceRecordingAuthority,
  type SongSourceCatalogFile,
  type SongSourceRecordingStore,
  type SongSourceRegistration,
} from "./source-recording-authority";

type RetainedIdentification = Extract<
  MediaIdentificationOutcome,
  { outcome: "retained_reference_match" }
>;

const HASH = "a".repeat(64);
const registration = (overrides: Partial<SongSourceRegistration> = {}): SongSourceRegistration => ({
  registrationId: "source-registration-1",
  assetId: "post-1",
  submissionId: "submission-1",
  operationId: "operation-1",
  audioRevision: 1,
  analysisRevision: 2,
  publicationRevision: 1,
  termsRevision: 1,
  canonicalAudioSha256: HASH,
  immutableAudioRef: "media/immutable/source-1.mp3",
  verificationSample: {
    objectKey: "samples/source-1.mp3",
    contentType: "audio/mpeg",
    byteLength: 1,
  },
  provider: "acrcloud",
  bucketId: "bucket-1",
  opaqueTitle: "pirate-source-registration-1",
  state: "pending_upload",
  providerFileId: null,
  providerMatchId: null,
  claimOwner: "worker-1",
  claimFence: 3n,
  ...overrides,
});

const file = (overrides: Partial<SongSourceCatalogFile> = {}): SongSourceCatalogFile => ({
  providerFileId: "file-1",
  providerMatchId: "acr-1",
  bucketId: "bucket-1",
  opaqueTitle: "pirate-source-registration-1",
  state: "processing",
  registrationId: "source-registration-1",
  assetId: "post-1",
  canonicalAudioSha256: HASH,
  ...overrides,
});

const identified = (overrides: Partial<RetainedIdentification> = {}): RetainedIdentification => ({
  context: {
    version: "media-identification-attempt-context-v1",
    operationId: "operation-1",
    audioRevision: 1,
    analysisRevision: 2,
    canonicalAudioSha256: HASH,
    requestId: "source-registration-1:verify:f3",
    adapterRevision: "acrcloud-adapter-v1",
  },
  outcome: "retained_reference_match",
  evidence: {
    version: "media-identification-match-evidence-v1",
    provider: "acrcloud",
    matchKind: "custom",
    providerMatchId: "acr-1",
    title: null,
    artists: [],
    score: 100,
  },
  ...overrides,
});

function harness(current: SongSourceRegistration) {
  const calls: string[] = [];
  const store: SongSourceRecordingStore = {
    get: async () => current,
    acceptProviderFile: async () => {
      calls.push("accept");
      return true;
    },
    markProviderOutcomeUnknown: async () => {
      calls.push("unknown");
      return true;
    },
    markReady: async () => {
      calls.push("ready");
      return true;
    },
    fail: async ({ failureCode }) => {
      calls.push(`fail:${failureCode}`);
      return true;
    },
  };
  return { calls, store };
}

describe("song source recording authority", () => {
  test("is inert while provider retention is disabled", async () => {
    const { calls, store } = harness(registration());
    const result = await advanceSongSourceRecordingAuthority(
      {
        enabled: false,
        workerId: "worker-1",
        adapterRevision: "acrcloud-adapter-v1",
        store,
        catalog: {
          findExact: async () => ({ outcome: "none" }),
          upload: async () => {
            calls.push("upload");
            return { outcome: "retryable", reason: "unexpected" };
          },
          get: async () => ({ outcome: "none" }),
        },
        audio: {
          readCanonical: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
          readVerificationSample: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
        },
        identification: { identify: () => Effect.succeed(identified()) },
      },
      "source-registration-1",
    );
    expect(result).toEqual({ outcome: "inert" });
    expect(calls).toEqual([]);
  });

  test("reconciles an existing exact file before upload", async () => {
    const { calls, store } = harness(registration());
    const result = await advanceSongSourceRecordingAuthority(
      {
        enabled: true,
        workerId: "worker-1",
        adapterRevision: "acrcloud-adapter-v1",
        store,
        catalog: {
          findExact: async () => ({ outcome: "exact", file: file() }),
          upload: async () => {
            calls.push("upload");
            return { outcome: "retryable", reason: "unexpected" };
          },
          get: async () => ({ outcome: "none" }),
        },
        audio: {
          readCanonical: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
          readVerificationSample: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
        },
        identification: { identify: () => Effect.succeed(identified()) },
      },
      "source-registration-1",
    );
    expect(result).toEqual({ outcome: "progress" });
    expect(calls).toEqual(["accept"]);
  });

  test("quarantines an uncertain upload and never retries it", async () => {
    const current = registration({ state: "provider_outcome_unknown" });
    const { calls, store } = harness(current);
    const result = await advanceSongSourceRecordingAuthority(
      {
        enabled: true,
        workerId: "worker-1",
        adapterRevision: "acrcloud-adapter-v1",
        store,
        catalog: {
          findExact: async () => ({ outcome: "none" }),
          upload: async () => {
            calls.push("upload");
            return { outcome: "retryable", reason: "unexpected" };
          },
          get: async () => ({ outcome: "none" }),
        },
        audio: {
          readCanonical: async () => {
            calls.push("read");
            return { bytes: new Uint8Array([1]), filename: "a.mp3", contentType: "audio/mpeg" };
          },
          readVerificationSample: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
        },
        identification: { identify: () => Effect.succeed(identified()) },
      },
      current.registrationId,
    );
    expect(result).toEqual({ outcome: "waiting" });
    expect(calls).toEqual([]);
  });

  test("does not upload when preflight reconciliation is unavailable", async () => {
    const current = registration();
    const { calls, store } = harness(current);
    const result = await advanceSongSourceRecordingAuthority(
      {
        enabled: true,
        workerId: "worker-1",
        adapterRevision: "acrcloud-adapter-v1",
        store,
        catalog: {
          findExact: async () => ({ outcome: "retryable", reason: "transport" }),
          upload: async () => {
            calls.push("upload");
            return { outcome: "retryable", reason: "unexpected" };
          },
          get: async () => ({ outcome: "none" }),
        },
        audio: {
          readCanonical: async () => {
            calls.push("read");
            return {
              bytes: new Uint8Array([1]),
              filename: "a.mp3",
              contentType: "audio/mpeg",
            };
          },
          readVerificationSample: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
        },
        identification: { identify: () => Effect.succeed(identified()) },
      },
      current.registrationId,
    );
    expect(result).toEqual({ outcome: "waiting" });
    expect(calls).toEqual([]);
  });

  test("marks ready only after the identification project returns the exact custom id", async () => {
    const current = registration({
      state: "provider_processing",
      providerFileId: "file-1",
      providerMatchId: "acr-1",
    });
    const { calls, store } = harness(current);
    const result = await advanceSongSourceRecordingAuthority(
      {
        enabled: true,
        workerId: "worker-1",
        adapterRevision: "acrcloud-adapter-v1",
        store,
        catalog: {
          findExact: async () => ({ outcome: "none" }),
          upload: async () => ({ outcome: "retryable", reason: "unexpected" }),
          get: async () => ({ outcome: "exact", file: file({ state: "ready" }) }),
        },
        audio: {
          readCanonical: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
          readVerificationSample: async () => ({
            bytes: new Uint8Array([2]),
            filename: "sample.mp3",
            contentType: "audio/mpeg",
          }),
        },
        identification: { identify: () => Effect.succeed(identified()) },
      },
      current.registrationId,
    );
    expect(result).toEqual({ outcome: "ready" });
    expect(calls).toEqual(["ready"]);
  });

  test("fails closed when the identification project returns a different custom id", async () => {
    const current = registration({ state: "provider_processing", providerFileId: "file-1" });
    const { calls, store } = harness(current);
    const result = await advanceSongSourceRecordingAuthority(
      {
        enabled: true,
        workerId: "worker-1",
        adapterRevision: "acrcloud-adapter-v1",
        store,
        catalog: {
          findExact: async () => ({ outcome: "none" }),
          upload: async () => ({ outcome: "retryable", reason: "unexpected" }),
          get: async () => ({ outcome: "exact", file: file({ state: "ready" }) }),
        },
        audio: {
          readCanonical: async () => ({
            bytes: new Uint8Array([1]),
            filename: "a.mp3",
            contentType: "audio/mpeg",
          }),
          readVerificationSample: async () => ({
            bytes: new Uint8Array([2]),
            filename: "sample.mp3",
            contentType: "audio/mpeg",
          }),
        },
        identification: {
          identify: () =>
            Effect.succeed(
              identified({ evidence: { ...identified().evidence, providerMatchId: "acr-other" } }),
            ),
        },
      },
      current.registrationId,
    );
    expect(result).toEqual({ outcome: "failed" });
    expect(calls).toEqual(["fail:verification_mismatch"]);
  });
});
