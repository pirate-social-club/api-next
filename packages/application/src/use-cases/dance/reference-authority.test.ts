import { describe, expect, test } from "bun:test";
import {
  type DanceReferenceProcessingPolicy,
  type DanceReferenceSealedPublicationSource,
  makeSealedDanceReferenceAuthoringAuthorityResolver,
  type SealedDanceReferencePublication,
} from "./reference-authority.ts";

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

const processingPolicy: DanceReferenceProcessingPolicy = {
  extraction: {
    policyVersion: "extract-v1",
    outputProfile: { sampleRateHz: 48_000, channels: 1, codec: "flac" },
  },
  alignment: {
    policyVersion: "alignment-v1",
    adapterId: "provider-neutral-alignment",
    adapterRevision: "adapter-v1",
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
};

const basePublication: SealedDanceReferencePublication = {
  version: "sealed-dance-reference-publication-v1",
  communityId: "community-1",
  target: { kind: "song", songPostId: "song-1" },
  canonicalAudio: {
    postId: "song-1",
    audioRevision: 4,
    objectKey: "private/song-audio",
    sha256: HASH_A,
    durationMs: 180_000,
    status: "published",
    visibility: "public",
  },
  referenceVideo: {
    postId: "video-1",
    authorAccountId: "dance-creator",
    track: "video",
    status: "published",
    visibility: "public",
    sealStatus: "sealed",
    songPostId: "song-1",
    audioRevision: 4,
    objectKey: "private/reference/video-1",
    sha256: HASH_B,
    durationMs: 60_000,
  },
  publicationOwnerPolicy: {
    observedAtTransition: "publication_committed",
    songPostId: "song-1",
    audioRevision: 4,
    ownerAccountId: "song-owner",
    revision: 7,
    hash: HASH_C,
    derivativeVideo: "allowed",
  },
};

const input = {
  actorAccountId: "dance-creator",
  communityId: "community-1",
  target: { kind: "song" as const, songPostId: "song-1" },
  audioRevision: 4,
  referenceVideoPostId: "video-1",
  startMs: 10_000,
  endMs: 16_000,
};

const source = (value: unknown, calls: unknown[] = []): DanceReferenceSealedPublicationSource => ({
  resolve: async (request) => {
    calls.push(request);
    return value;
  },
});

describe("sealed Dance reference authoring authority", () => {
  test("derives exact authority without exposing actor or provider fields to the source", async () => {
    const calls: unknown[] = [];
    const resolver = makeSealedDanceReferenceAuthoringAuthorityResolver({
      source: source(basePublication, calls),
      processingPolicy,
    });

    await expect(resolver.resolve(input)).resolves.toEqual({
      canonicalAudio: {
        objectKey: "private/song-audio",
        sha256: HASH_A,
        durationMs: 180_000,
        audioRevision: 4,
      },
      referenceVideo: {
        postId: "video-1",
        objectKey: "private/reference/video-1",
        sha256: HASH_B,
        durationMs: 60_000,
      },
      ...processingPolicy,
      ownerPolicy: { revision: 7, hash: HASH_C },
    });
    expect(calls).toEqual([
      {
        communityId: "community-1",
        target: { kind: "song", songPostId: "song-1" },
        audioRevision: 4,
        referenceVideoPostId: "video-1",
      },
    ]);
    expect("actorAccountId" in (calls[0] as Record<string, unknown>)).toBe(false);
  });

  test("enforces publication-commit derivative policy without consulting a live default", async () => {
    const ownerOnly = {
      ...basePublication,
      publicationOwnerPolicy: {
        ...basePublication.publicationOwnerPolicy,
        derivativeVideo: "owner_only" as const,
      },
    };
    const nonOwner = makeSealedDanceReferenceAuthoringAuthorityResolver({
      source: source(ownerOnly),
      processingPolicy,
    });
    await expect(nonOwner.resolve(input)).rejects.toMatchObject({
      reason: "publication-forbidden",
    });

    const ownerPublication = {
      ...ownerOnly,
      referenceVideo: { ...ownerOnly.referenceVideo, authorAccountId: "song-owner" },
    };
    const owner = makeSealedDanceReferenceAuthoringAuthorityResolver({
      source: source(ownerPublication),
      processingPolicy,
    });
    await expect(owner.resolve({ ...input, actorAccountId: "song-owner" })).resolves.toMatchObject({
      ownerPolicy: { revision: 7, hash: HASH_C },
    });

    const blocked = makeSealedDanceReferenceAuthoringAuthorityResolver({
      source: source({
        ...ownerPublication,
        publicationOwnerPolicy: {
          ...ownerPublication.publicationOwnerPolicy,
          derivativeVideo: "blocked",
        },
      }),
      processingPolicy,
    });
    await expect(blocked.resolve({ ...input, actorAccountId: "song-owner" })).rejects.toMatchObject(
      { reason: "publication-forbidden" },
    );
  });

  test("fails closed on mismatched target, video ownership, and half-open bounds", async () => {
    for (const [publication, request, reason] of [
      [{ ...basePublication, communityId: "community-2" }, input, "authority-mismatch"],
      [
        {
          ...basePublication,
          referenceVideo: { ...basePublication.referenceVideo, authorAccountId: "intruder" },
        },
        input,
        "authority-mismatch",
      ],
      [basePublication, { ...input, endMs: 15_999 }, "invalid-input"],
    ] as const) {
      const resolver = makeSealedDanceReferenceAuthoringAuthorityResolver({
        source: source(publication),
        processingPolicy,
      });
      await expect(resolver.resolve(request)).rejects.toMatchObject({ reason });
    }
  });

  test("rejects unsealed, URL-bearing, and provider-extended publication snapshots", async () => {
    for (const publication of [
      {
        ...basePublication,
        referenceVideo: { ...basePublication.referenceVideo, sealStatus: "pending" },
      },
      {
        ...basePublication,
        referenceVideo: {
          ...basePublication.referenceVideo,
          objectKey: "https://provider.invalid/video",
        },
      },
      { ...basePublication, providerOperationId: "must-not-cross-boundary" },
    ]) {
      const resolver = makeSealedDanceReferenceAuthoringAuthorityResolver({
        source: source(publication),
        processingPolicy,
      });
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        reason: "invalid-publication",
      });
    }
  });

  test("rejects incomplete processing configuration instead of supplying defaults", () => {
    expect(() =>
      makeSealedDanceReferenceAuthoringAuthorityResolver({
        source: source(basePublication),
        processingPolicy: {
          ...processingPolicy,
          alignment: { ...processingPolicy.alignment, adapterId: "" },
        },
      }),
    ).toThrow();
  });
});
