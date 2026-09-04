import { describe, expect, test } from "bun:test";
import type { IpfsGatewayVerifier } from "@pirate/application/data/ipfs-live-verification";
import type { IpfsPinningService } from "@pirate/application/data/ipfs-pinning";
import type {
  DataRegistrationOperation,
  DataRegistrationPinVerification,
} from "@pirate/application/data/registration-persistence";
import { Effect } from "effect";
import {
  type DataRegistrationArtifactAuthority,
  makeDataRegistrationArtifactPipeline,
} from "./registration-artifact-pipeline";

const operation: DataRegistrationOperation = {
  registrationOperationId: "data-registration:1315:post-1:1",
  communityId: "community-1",
  actorUserId: "actor-1",
  submissionId: "submission-1",
  mediaOperationId: "media-operation-1",
  postId: "post-1",
  assetId: "post-1",
  chainId: 1315n,
  registrationRevision: 1n,
  publicationCreationRevision: 1n,
  publicationAudioRevision: 1n,
  publicationAnalysisRevision: 1n,
  publicationDecisionRevision: 1n,
  canonicalAudioSha256: "a".repeat(64),
  mediaKind: "song",
  rightsBasis: "original",
  state: "pending",
  workflowRevision: 1n,
  workflowInstanceId: "data-registration-workflow:data-registration:1315:post-1:1:r1",
  currentAttemptId: null,
  registeredIpId: null,
  confirmedTransactionHash: null,
  confirmedBlockNumber: null,
  confirmedBlockHash: null,
  confirmedLogIndex: null,
  confirmedAt: null,
  failureCode: null,
  failureEvidenceRef: null,
};

const authority: DataRegistrationArtifactAuthority = {
  postId: "post-1",
  title: "Explicit staging song",
  projectedAt: "2026-08-27T00:00:00.000Z",
  contentRating: "general",
  audioAssetRef: "media://immutable/song.mp3",
  audioMediaType: "audio/mpeg",
  audioByteLength: 3n,
  canonicalAudioSha256: "a".repeat(64),
  coverArtifactRef: null,
  lyrics: "Project-owned explicit fixture lyrics.",
  lyricsExplicitness: "explicit",
  primaryLanguageBcp47: "en",
  mediaKind: "song",
  rightsBasis: "original",
  licensePreset: "non-commercial",
  commercialRemixShareBps: 1_000,
  royaltyAllocations: [
    {
      recipientId: "actor-1",
      address: "0x1111111111111111111111111111111111111111",
      shareBps: 10_000,
    },
  ],
  acrDecision: "allow",
  acrPolicyRevision: "acr-v1",
  creatorAddress: "0x1111111111111111111111111111111111111111",
};

const audioPin: DataRegistrationPinVerification = {
  pinVerificationId: "audio-primary",
  registrationOperationId: operation.registrationOperationId,
  artifactId: `${operation.registrationOperationId}:artifact:canonical_audio`,
  artifactKind: "canonical_audio",
  role: "primary",
  providerId: "filebase",
  attemptNumber: 1,
  outcome: "verified",
  cid: "bafycanonicalaudio",
  canonicalSha256: "a".repeat(64),
  byteLength: 3n,
  evidenceRef: "evidence://audio",
  verifiedAt: "2026-08-27T00:00:00.000Z",
};

const collect = async (open: (signal: AbortSignal) => AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of open(new AbortController().signal)) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const fakePinning = {} as IpfsPinningService;
const fakeGateway = {} as IpfsGatewayVerifier;
const fakeBucket = {} as R2Bucket;

const videoOperation: DataRegistrationOperation = {
  ...operation,
  publicationAudioRevision: 1n,
  canonicalAudioSha256: "c".repeat(64),
  mediaKind: "video",
};

const videoAuthority: DataRegistrationArtifactAuthority = {
  postId: operation.postId,
  projectedAt: "2026-09-04T00:00:00.000Z",
  contentRating: "general",
  mediaKind: "video",
  rightsBasis: "original",
  licensePreset: null,
  caption: "An original video",
  videoAssetRef: "media://immutable/media-operation-1/video/1",
  videoMediaType: "video/mp4",
  videoByteLength: 4n,
  canonicalVideoSha256: "c".repeat(64),
  posterArtifactRef: "media://derived/media-operation-1/poster",
  posterSha256: "d".repeat(64),
  originalSoundId: "original-sound-1",
  royaltyAllocations: [
    {
      recipientId: "persona-1",
      address: "0x1111111111111111111111111111111111111111",
      shareBps: 10_000,
    },
  ],
  acrDecision: "no_match",
  acrPolicyRevision: "acr-v1",
  creatorAddress: "0x1111111111111111111111111111111111111111",
};

const videoBucket = {
  head: async (key: string) =>
    key.endsWith("/poster")
      ? ({ size: 3, httpMetadata: { contentType: "image/jpeg" } } as R2Object)
      : null,
} as unknown as R2Bucket;

const verifiedPin = (
  kind: "canonical_video" | "poster",
  hash: string,
  bytes: bigint,
): DataRegistrationPinVerification => ({
  ...audioPin,
  pinVerificationId: `${kind}-primary`,
  artifactId: `${operation.registrationOperationId}:artifact:${kind}`,
  artifactKind: kind,
  cid: `bafy${kind}`,
  canonicalSha256: hash,
  byteLength: bytes,
});

describe("DATA registration artifact pipeline", () => {
  test("builds original-video metadata only after the sealed video and poster pins", async () => {
    let pins: readonly DataRegistrationPinVerification[] = [];
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => videoAuthority, listPins: async () => pins },
      immutableOriginals: videoBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    expect(
      (await pipeline.prepare(videoOperation)).map(({ artifact }) => artifact.artifactKind),
    ).toEqual(["canonical_video", "poster"]);

    pins = [
      verifiedPin("canonical_video", "c".repeat(64), 4n),
      verifiedPin("poster", "d".repeat(64), 3n),
    ];
    const prepared = await pipeline.prepare(videoOperation);
    expect(prepared.map(({ artifact }) => artifact.artifactKind)).toEqual([
      "canonical_video",
      "poster",
      "ip_metadata",
      "nft_metadata",
    ]);
    const ipMetadata = prepared.find(({ artifact }) => artifact.artifactKind === "ip_metadata");
    if (ipMetadata === undefined) throw new Error("video IP metadata fixture missing");
    expect(JSON.parse(await collect(ipMetadata.open))).toMatchObject({
      mediaUrl: "ipfs://bafycanonical_video",
      image: "ipfs://bafyposter",
      mediaType: "video/mp4",
      content_rating: "general",
      rights: { basis: "original", offered_license: null },
      post: { original_sound_id: "original-sound-1" },
    });
  });

  test("rejects a null song license before preparing any artifact", async () => {
    const malformedAuthority = {
      ...authority,
      licensePreset: null,
    } as unknown as DataRegistrationArtifactAuthority;
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => malformedAuthority, listPins: async () => [] },
      immutableOriginals: fakeBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    await expect(pipeline.prepare(operation)).rejects.toThrow(
      "song DATA artifacts require a supported original-song intent with offered license terms",
    );
  });

  test("rejects a derivative song before preparing original-song artifacts", async () => {
    const derivativeAuthority = {
      ...authority,
      rightsBasis: "derivative",
    } as const;
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => derivativeAuthority, listPins: async () => [] },
      immutableOriginals: fakeBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    await expect(pipeline.prepare(operation)).rejects.toThrow(
      "song DATA artifacts require a supported original-song intent with offered license terms",
    );
  });

  test("pins audio first, then builds metadata against the durable audio CID", async () => {
    let pins: readonly DataRegistrationPinVerification[] = [];
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => authority, listPins: async () => pins },
      immutableOriginals: fakeBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    expect(
      (await pipeline.prepare(operation)).map(({ artifact }) => artifact.artifactKind),
    ).toEqual(["canonical_audio"]);

    pins = [audioPin];
    const prepared = await pipeline.prepare(operation);
    expect(prepared.map(({ artifact }) => artifact.artifactKind)).toEqual([
      "canonical_audio",
      "ip_metadata",
      "nft_metadata",
    ]);
    const ipMetadata = prepared.find(({ artifact }) => artifact.artifactKind === "ip_metadata");
    if (ipMetadata === undefined) throw new Error("IP metadata fixture missing");
    const decoded = JSON.parse(await collect(ipMetadata.open));
    expect(decoded).toMatchObject({
      mediaUrl: "ipfs://bafycanonicalaudio",
      lyrics_explicitness: "explicit",
      primary_language_bcp47: "en",
    });
    expect(decoded).not.toHaveProperty("content_rating");
  });

  test("does not silently register a publication with unhandled artwork", async () => {
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: {
        read: async () => ({ ...authority, coverArtifactRef: "media://cover/present" }),
        listPins: async () => [],
      },
      immutableOriginals: fakeBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    await expect(pipeline.prepare(operation)).rejects.toThrow("authority mismatch");
  });

  test("retries only the independent gateway after a durable Filebase pin", async () => {
    let providerPinCalls = 0;
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => authority, listPins: async () => [audioPin] },
      immutableOriginals: fakeBucket,
      pinning: {
        pin: () => {
          providerPinCalls += 1;
          return Effect.die("Filebase must not be called again");
        },
      },
      gateway: {
        verify: (input) =>
          Effect.succeed({
            status: "verified",
            cid: input.cid,
            byte_length: input.expected_byte_length,
            sha256: input.expected_sha256,
            provider_id: "ipfs.io",
          }),
      },
      publicOrigin: "https://staging.pirate.sc",
      now: () => Date.parse("2026-08-27T00:00:00.000Z"),
    });
    const audio = (await pipeline.prepare(operation))[0];
    if (audio === undefined) throw new Error("audio fixture missing");
    expect(await pipeline.pinAndVerify(operation, audio)).toMatchObject({
      status: "verified",
      cid: audioPin.cid,
      primaryEvidenceRef: audioPin.evidenceRef,
    });
    expect(providerPinCalls).toBe(0);
  });
});
