import type { SongSourceRegistration } from "@pirate/application/media/source-recording-authority";
import { describe, expect, test } from "vitest";
import {
  makeSongSourceAcrCloudCatalog,
  type SongSourceAcrCloudCatalogRequest,
  songSourceCatalogResponse,
} from "./song-source-acrcloud-catalog";

const HASH = "a".repeat(64);
const registration: SongSourceRegistration = {
  registrationId: "registration-1",
  assetId: "post-1",
  submissionId: "submission-1",
  operationId: "operation-1",
  audioRevision: 1,
  analysisRevision: 1,
  publicationRevision: 1,
  termsRevision: 1,
  canonicalAudioSha256: HASH,
  immutableAudioRef: "media/audio.mp3",
  verificationSample: {
    objectKey: "samples/source-1.mp3",
    contentType: "audio/mpeg",
    byteLength: 3,
  },
  provider: "acrcloud",
  bucketId: "8891",
  opaqueTitle: "pirate-source-registration-1",
  state: "pending_upload",
  providerFileId: null,
  providerMatchId: null,
  claimOwner: "worker-1",
  claimFence: 1n,
};

const providerFile = (overrides: Record<string, unknown> = {}) => ({
  id: 20,
  bucket_id: 8891,
  acr_id: "6d3e17559677cd79ecb0b7cd2c79bea0",
  state: 0,
  title: registration.opaqueTitle,
  user_defined: {
    registration_id: registration.registrationId,
    asset_id: registration.assetId,
    canonical_audio_sha256: HASH,
  },
  ...overrides,
});

const catalog = (
  request: (
    request: SongSourceAcrCloudCatalogRequest,
  ) => Promise<ReturnType<typeof songSourceCatalogResponse>>,
) =>
  makeSongSourceAcrCloudCatalog({
    origin: "https://api-v2.acrcloud.com",
    bucketId: "8891",
    token: "scoped-console-token",
    maxResponseBytes: 32_768,
    maxAudioBytes: 64 * 1024 * 1024,
    request,
  });

describe("ACRCloud source catalog", () => {
  test("lists by opaque title and accepts one exact fenced record", async () => {
    let captured: SongSourceAcrCloudCatalogRequest | null = null;
    const result = await catalog(async (request) => {
      captured = request;
      return songSourceCatalogResponse({ data: [providerFile()] });
    }).findExact(registration, new AbortController().signal);
    expect(result).toEqual({
      outcome: "exact",
      file: {
        providerFileId: "20",
        providerMatchId: "6d3e17559677cd79ecb0b7cd2c79bea0",
        bucketId: "8891",
        opaqueTitle: registration.opaqueTitle,
        state: "processing",
        registrationId: registration.registrationId,
        assetId: registration.assetId,
        canonicalAudioSha256: HASH,
      },
    });
    expect(captured).not.toBeNull();
    const request = captured as unknown as SongSourceAcrCloudCatalogRequest;
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.url).toContain("search=pirate-source-registration-1");
    expect(request.headers.authorization).toBe("Bearer scoped-console-token");
  });

  test("does not accept title-only or duplicated matches", async () => {
    const mismatch = await catalog(async () =>
      songSourceCatalogResponse({
        data: [
          providerFile({ user_defined: { ...providerFile().user_defined, asset_id: "other" } }),
        ],
      }),
    ).findExact(registration, new AbortController().signal);
    expect(mismatch).toEqual({ outcome: "none" });

    const duplicate = await catalog(async () =>
      songSourceCatalogResponse({ data: [providerFile(), providerFile({ id: 21 })] }),
    ).findExact(registration, new AbortController().signal);
    expect(duplicate).toEqual({ outcome: "ambiguous" });
  });

  test("uploads only private deterministic metadata", async () => {
    let body: FormData | undefined;
    const result = await catalog(async (request) => {
      body = request.body;
      return songSourceCatalogResponse({ data: providerFile() });
    }).upload(
      registration,
      { bytes: new Uint8Array([1, 2, 3]), filename: "source.mp3", contentType: "audio/mpeg" },
      new AbortController().signal,
    );
    expect(result.outcome).toBe("accepted");
    expect(body?.get("title")).toBe(registration.opaqueTitle);
    expect(body?.get("data_type")).toBe("audio");
    expect(JSON.parse(String(body?.get("user_defined")))).toEqual({
      registration_id: registration.registrationId,
      asset_id: registration.assetId,
      canonical_audio_sha256: HASH,
    });
    expect(body?.has("creator")).toBe(false);
    expect(body?.has("community")).toBe(false);
  });

  test("quarantines transport and malformed success outcomes as ambiguous", async () => {
    const lost = await catalog(async () => Promise.reject(new Error("lost response"))).upload(
      registration,
      { bytes: new Uint8Array([1]), filename: "source.mp3", contentType: "audio/mpeg" },
      new AbortController().signal,
    );
    expect(lost.outcome).toBe("ambiguous");

    const malformed = await catalog(async () =>
      songSourceCatalogResponse({ data: { id: 20 } }),
    ).upload(
      registration,
      { bytes: new Uint8Array([1]), filename: "source.mp3", contentType: "audio/mpeg" },
      new AbortController().signal,
    );
    expect(malformed.outcome).toBe("ambiguous");
  });

  test("rejects an unpinned origin before transport", async () => {
    let called = false;
    const result = await makeSongSourceAcrCloudCatalog({
      origin: "https://example.com",
      bucketId: "8891",
      token: "scoped-console-token",
      maxResponseBytes: 32_768,
      maxAudioBytes: 64 * 1024 * 1024,
      request: async () => {
        called = true;
        return songSourceCatalogResponse({ data: [] });
      },
    }).findExact(registration, new AbortController().signal);
    expect(result).toEqual({ outcome: "rejected", reason: "catalog_configuration_invalid" });
    expect(called).toBe(false);
  });
});
