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
  attachedLicense: null,
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

const derivativeOperation: DataRegistrationOperation = {
  ...operation,
  canonicalAudioSha256: "e".repeat(64),
  mediaKind: "video",
  rightsBasis: "derivative",
};

const MASTER_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

const derivativeAuthority: DataRegistrationArtifactAuthority = {
  postId: operation.postId,
  projectedAt: "2026-09-11T00:00:00.000Z",
  contentRating: "adult_18",
  mediaKind: "video",
  rightsBasis: "derivative",
  licensePreset: null,
  caption: null,
  master: {
    objectKey: "media://immutable/song-video-masters/song-video-plan:submission-1/g1",
    objectVersion: "v7",
    mediaType: "video/mp4",
    byteLength: 5n,
    sha256: "e".repeat(64),
  },
  posterArtifactRef: "media://derived/media-operation-1/poster",
  posterSha256: "d".repeat(64),
  parent: {
    assetId: "song-post-1",
    registrationOperationId: "data-registration:1315:song-post-1:1",
    relationship: "references_song",
    ipId: "0x5555555555555555555555555555555555555555",
    licenseTemplate: "0x2e896b0b2fdb7457499b56aaaa4ae55bcb4cd316",
    licenseTermsId: "1894",
    preset: "commercial-remix",
    commercialRevShareBps: 500,
  },
  ownerPolicy: { revision: 3n, hash: "f".repeat(64) },
  royaltyAllocations: [
    {
      recipientId: "persona-1",
      address: "0x1111111111111111111111111111111111111111",
      shareBps: 10_000,
    },
  ],
  creatorAddress: "0x1111111111111111111111111111111111111111",
};

describe("DATA registration artifacts of a song-reference video", () => {
  const opened: string[] = [];
  const masters = {
    open: async (objectKey: string, objectVersion: string) => {
      opened.push(`${objectKey}@${objectVersion}`);
      return (async function* () {
        yield MASTER_BYTES.slice(0, 2);
        yield MASTER_BYTES.slice(2);
      })();
    },
  };

  test("registers the accepted master and names the resolved parent in its metadata", async () => {
    let pins: readonly DataRegistrationPinVerification[] = [];
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => derivativeAuthority, listPins: async () => pins },
      immutableOriginals: videoBucket,
      songVideoMasters: masters,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    const first = await pipeline.prepare(derivativeOperation);
    expect(first.map(({ artifact }) => artifact.artifactKind)).toEqual([
      "canonical_video",
      "poster",
    ]);
    const [video] = first;
    if (video === undefined) throw new Error("master artifact missing");
    expect(video.artifact).toMatchObject({
      sourceRef: "media://immutable/song-video-masters/song-video-plan:submission-1/g1@v7",
      mediaType: "video/mp4",
      byteLength: 5n,
      canonicalSha256: "e".repeat(64),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of video.open(new AbortController().signal)) chunks.push(chunk);
    // The sealed version is what is read, never the key's latest object.
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(MASTER_BYTES));
    expect(opened).toEqual([
      "media://immutable/song-video-masters/song-video-plan:submission-1/g1@v7",
    ]);

    pins = [
      verifiedPin("canonical_video", "e".repeat(64), 5n),
      verifiedPin("poster", "d".repeat(64), 3n),
    ];
    const prepared = await pipeline.prepare(derivativeOperation);
    const ipMetadata = prepared.find(({ artifact }) => artifact.artifactKind === "ip_metadata");
    const nftMetadata = prepared.find(({ artifact }) => artifact.artifactKind === "nft_metadata");
    if (ipMetadata === undefined || nftMetadata === undefined) throw new Error("metadata missing");
    const document = JSON.parse(await collect(ipMetadata.open));
    expect(document).toMatchObject({
      mediaUrl: "ipfs://bafycanonical_video",
      mediaHash: `0x${"e".repeat(64)}`,
      mediaType: "video/mp4",
      media_byte_length: 5,
      image: "ipfs://bafyposter",
      content_rating: "adult_18",
      rights: {
        basis: "derivative",
        offered_license: null,
        parent: {
          asset_id: "song-post-1",
          ip_id: "0x5555555555555555555555555555555555555555",
          relationship: "references_song",
          consumed_license: {
            license_template: "0x2e896b0b2fdb7457499b56aaaa4ae55bcb4cd316",
            license_terms_id: "1894",
            preset: "commercial-remix",
            commercial_rev_share_bps: 500,
          },
        },
        owner_policy: { revision: 3, hash: "f".repeat(64) },
      },
    });
    // No recognition provenance: the soundtrack is the referenced song itself.
    expect(document.provenance).toBeUndefined();
    expect(JSON.parse(await collect(nftMetadata.open)).attributes).toEqual(
      expect.arrayContaining([
        { trait_type: "Rights basis", value: "derivative" },
        { trait_type: "Relationship", value: "references_song" },
      ]),
    );
  });

  test("fails closed without a master source", async () => {
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => derivativeAuthority, listPins: async () => [] },
      immutableOriginals: videoBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    await expect(pipeline.prepare(derivativeOperation)).rejects.toThrow("no master source");
  });

  test("refuses a master other than the one the registration names", async () => {
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => derivativeAuthority, listPins: async () => [] },
      immutableOriginals: videoBucket,
      songVideoMasters: masters,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    await expect(
      pipeline.prepare({ ...derivativeOperation, canonicalAudioSha256: "a".repeat(64) }),
    ).rejects.toThrow("authority mismatch");
  });
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

  test("pins through Filebase before verifying the fresh CID through the gateway", async () => {
    const calls: string[] = [];
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => authority, listPins: async () => [] },
      immutableOriginals: fakeBucket,
      pinning: {
        pin: () => {
          calls.push("filebase");
          return Effect.succeed({
            status: "pinned",
            outcome: "pinned",
            cid: "bafyfresh",
            byte_length: 3,
            sha256: authority.canonicalAudioSha256,
            recursive: true,
          });
        },
      },
      gateway: {
        verify: (input) => {
          calls.push("gateway");
          return Effect.succeed({
            status: "verified",
            cid: input.cid,
            byte_length: input.expected_byte_length,
            sha256: input.expected_sha256,
            provider_id: "ipfs.io",
          });
        },
      },
      publicOrigin: "https://staging.pirate.sc",
      now: () => Date.parse("2026-08-27T00:00:00.000Z"),
    });
    const audio = (await pipeline.prepare(operation))[0];
    if (audio === undefined) throw new Error("audio fixture missing");

    await expect(pipeline.pinAndVerify(operation, audio)).resolves.toEqual({
      status: "verified",
      cid: "bafyfresh",
      byteLength: 3n,
      canonicalSha256: authority.canonicalAudioSha256,
      primaryEvidenceRef: `data-registration://filebase/${audio.artifact.artifactId}`,
      gatewayEvidenceRef: `data-registration://ipfs.io/${audio.artifact.artifactId}`,
      verifiedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(calls).toEqual(["filebase", "gateway"]);
  });

  test("retains a durable primary pin when gateway verification is retryable", async () => {
    let providerPinCalls = 0;
    let gatewayCalls = 0;
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => authority, listPins: async () => [audioPin] },
      immutableOriginals: fakeBucket,
      pinning: {
        pin: () => {
          providerPinCalls += 1;
          return Effect.die("Filebase must not be called for a retained primary pin");
        },
      },
      gateway: {
        verify: () => {
          gatewayCalls += 1;
          return Effect.succeed({ status: "retryable", reason: "not_found" as const });
        },
      },
      publicOrigin: "https://staging.pirate.sc",
      now: () => Date.parse("2026-08-27T00:00:00.000Z"),
    });
    const audio = (await pipeline.prepare(operation))[0];
    if (audio === undefined) throw new Error("audio fixture missing");

    await expect(pipeline.pinAndVerify(operation, audio)).resolves.toEqual({
      status: "primary_verified",
      cid: "bafycanonicalaudio",
      byteLength: 3n,
      canonicalSha256: "a".repeat(64),
      primaryEvidenceRef: "evidence://audio",
      gatewayEvidenceRef: `data-registration://ipfs.io/${audio.artifact.artifactId}`,
      verifiedAt: "2026-08-27T00:00:00.000Z",
      gatewayRetryable: true,
    });
    expect(providerPinCalls).toBe(0);
    expect(gatewayCalls).toBe(1);
  });

  test("maps ordinary provider cancellation to retryable without invoking the gateway", async () => {
    const calls: string[] = [];
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: { read: async () => authority, listPins: async () => [] },
      immutableOriginals: fakeBucket,
      pinning: {
        pin: () => {
          calls.push("filebase");
          return Effect.succeed({ status: "cancelled", outcome: "cancelled" as const });
        },
      },
      gateway: {
        verify: () => {
          calls.push("gateway");
          return Effect.die("gateway must not run after a failed pin");
        },
      },
      publicOrigin: "https://staging.pirate.sc",
    });
    const audio = (await pipeline.prepare(operation))[0];
    if (audio === undefined) throw new Error("audio fixture missing");

    await expect(pipeline.pinAndVerify(operation, audio)).resolves.toEqual({
      status: "retryable",
    });
    expect(calls).toEqual(["filebase"]);
  });

  test("preserves authority-reader rejection through the Promise adapter", async () => {
    const failure = new Error("authority reader unavailable");
    let listPinsCalls = 0;
    const pipeline = makeDataRegistrationArtifactPipeline({
      authority: {
        read: async () => authority,
        listPins: async () => {
          listPinsCalls += 1;
          return listPinsCalls === 1 ? [] : Promise.reject(failure);
        },
      },
      immutableOriginals: fakeBucket,
      pinning: fakePinning,
      gateway: fakeGateway,
      publicOrigin: "https://staging.pirate.sc",
    });
    const audio = (await pipeline.prepare(operation))[0];
    if (audio === undefined) throw new Error("audio fixture missing");

    try {
      await pipeline.pinAndVerify(operation, audio);
      throw new Error("expected authority reader rejection");
    } catch (error) {
      expect(error).toBe(failure);
    }
  });
});
