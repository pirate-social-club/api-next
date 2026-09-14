import { expect, test } from "bun:test";
import { makeTelegramPosterBytes, type SealedMediaObject } from "./telegram-poster-bytes.ts";

const poster = {
  artifactRef: "media://derived/key/poster.jpg",
  key: "video-analysis/op/v1/c1/a1/poster.jpg",
  sha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  policyRevision: "7",
};

function sealedObject(overrides: Partial<SealedMediaObject> = {}): SealedMediaObject {
  return {
    key: poster.key,
    size: 1024,
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: {
      sha256: poster.sha256,
      sourceSha256: poster.sourceSha256,
      policyRevision: poster.policyRevision,
    },
    arrayBuffer: async () => new Uint8Array(1024).buffer,
    ...overrides,
  };
}

test("reads a sealed poster that matches its authorized identity", async () => {
  const reader = makeTelegramPosterBytes({ get: async () => sealedObject() });
  const bytes = await reader(poster);
  expect(bytes?.byteLength).toBe(1024);
});

test("unvalidated, oversized and unavailable objects return null", async () => {
  for (const overrides of [
    { key: "other/key.jpg" },
    { httpMetadata: { contentType: "image/png" } },
    { httpMetadata: { contentType: "image/jpeg", contentEncoding: "gzip" } },
    { customMetadata: { ...sealedObject().customMetadata, sha256: "c".repeat(64) } },
    { customMetadata: { ...sealedObject().customMetadata, policyRevision: "8" } },
    { size: 6 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(6 * 1024 * 1024) },
    { size: 2048 },
  ]) {
    const reader = makeTelegramPosterBytes({ get: async () => sealedObject(overrides) });
    expect(await reader(poster)).toBeNull();
  }
  expect(await makeTelegramPosterBytes({ get: async () => null })(poster)).toBeNull();
  expect(
    await makeTelegramPosterBytes({
      get: async () => {
        throw new Error("storage unavailable");
      },
    })(poster),
  ).toBeNull();
});
