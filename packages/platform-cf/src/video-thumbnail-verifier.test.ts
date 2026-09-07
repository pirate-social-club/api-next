import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  consumeVideoThumbnail,
  type VideoThumbnailClaim,
} from "../../application/src/video/thumbnail-enrichment.ts";
import { makeVideoThumbnailVerifier } from "./video-thumbnail-verifier.ts";

const claim: VideoThumbnailClaim = {
  effectIdentity: "thumbnail-effect",
  leaseToken: "claim-token",
  postId: "post",
  communityId: "community",
  artifactRef: "opaque-poster",
  sha256: "a".repeat(64),
  sourceSha256: "b".repeat(64),
  policyRevision: "1",
};
const authority = { ...claim, key: "server-owned-key" };
const object = {
  key: authority.key,
  size: 100,
  httpMetadata: { contentType: "image/jpeg" },
  customMetadata: { sha256: claim.sha256, sourceSha256: claim.sourceSha256, policyRevision: "1" },
};

test("thumbnail verifier rejects every seal mismatch without creating a second copy", async () => {
  for (const changed of [
    { ...object, key: "other" },
    { ...object, size: 0 },
    { ...object, size: Number.MAX_SAFE_INTEGER },
    { ...object, httpMetadata: { contentType: "image/png" } },
    { ...object, httpMetadata: { contentType: "image/jpeg", contentEncoding: "gzip" } },
    { ...object, customMetadata: { ...object.customMetadata, sha256: "c".repeat(64) } },
    { ...object, customMetadata: { ...object.customMetadata, sourceSha256: "c".repeat(64) } },
    { ...object, customMetadata: { ...object.customMetadata, policyRevision: "2" } },
  ]) {
    const verify = makeVideoThumbnailVerifier({
      resolveArtifact: () => Effect.succeed(authority),
      bucket: {
        head: async (key) => {
          expect(key).toBe(authority.key);
          return changed;
        },
      },
    });
    expect(await verify(claim)).toBe("invalid");
  }
});

test("thumbnail verifier checks authority before object I/O", async () => {
  for (const result of [
    null,
    { ...authority, artifactRef: "other" },
    { ...authority, sha256: "c".repeat(64) },
    { ...authority, sourceSha256: "c".repeat(64) },
    { ...authority, policyRevision: "2" },
  ]) {
    let reads = 0;
    const verify = makeVideoThumbnailVerifier({
      resolveArtifact: () => Effect.succeed(result),
      bucket: {
        head: async () => {
          reads++;
          return object;
        },
      },
    });
    expect(await verify(claim)).toBe("invalid");
    expect(reads).toBe(0);
  }
});

test("consumer never verifies an unclaimed intent or reports stale completion as ready", async () => {
  let reads = 0;
  const verify = async () => {
    reads++;
    return "available" as const;
  };
  expect(
    await consumeVideoThumbnail("effect", {
      verify,
      store: { claim: async () => null, complete: async () => true },
    }),
  ).toBe("unclaimed");
  expect(reads).toBe(0);
  expect(
    await consumeVideoThumbnail("effect", {
      verify,
      store: { claim: async () => claim, complete: async () => false },
    }),
  ).toBe("stale");
  expect(reads).toBe(1);
});

test("invalid sealed metadata persists failure rather than ready", async () => {
  const states: string[] = [];
  expect(
    await consumeVideoThumbnail("effect", {
      verify: async () => "invalid",
      store: {
        claim: async () => claim,
        complete: async (_, state) => {
          states.push(state);
          return true;
        },
      },
    }),
  ).toBe("failed");
  expect(states).toEqual(["failed"]);
});
