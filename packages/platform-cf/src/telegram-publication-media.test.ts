import { expect, test } from "bun:test";
import { makeTelegramPublicationPoster } from "./telegram-publication-media.ts";

const authority = {
  artifactRef: "media://derived/key/poster.jpg",
  key: "video-analysis/op/v1/c1/a1/poster.jpg",
  sha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  policyRevision: "1",
};

test("resolves the sealed poster identity for an authorized public video post", async () => {
  const resolver = makeTelegramPublicationPoster({
    authorize: async () => true,
    posterArtifactRef: async () => authority.artifactRef,
    resolvePoster: async () => authority,
  });
  expect(await resolver({ id: "post", communityId: "community" })).toEqual(authority);
});

test("denied, missing and mismatched artifacts degrade to no media", async () => {
  const denied = makeTelegramPublicationPoster({
    authorize: async () => false,
    posterArtifactRef: async () => authority.artifactRef,
    resolvePoster: async () => authority,
  });
  expect(await denied({ id: "post", communityId: "community" })).toBeNull();

  const missing = makeTelegramPublicationPoster({
    authorize: async () => true,
    posterArtifactRef: async () => null,
    resolvePoster: async () => authority,
  });
  expect(await missing({ id: "post", communityId: "community" })).toBeNull();

  const noAuthority = makeTelegramPublicationPoster({
    authorize: async () => true,
    posterArtifactRef: async () => authority.artifactRef,
    resolvePoster: async () => null,
  });
  expect(await noAuthority({ id: "post", communityId: "community" })).toBeNull();

  const mismatched = makeTelegramPublicationPoster({
    authorize: async () => true,
    posterArtifactRef: async () => authority.artifactRef,
    resolvePoster: async () => ({ ...authority, artifactRef: "media://derived/other.jpg" }),
  });
  expect(await mismatched({ id: "post", communityId: "community" })).toBeNull();
});
