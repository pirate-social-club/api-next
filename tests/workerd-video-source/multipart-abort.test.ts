import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { makeR2VideoMultipartGateway } from "../../packages/platform-cf/src/video-multipart-r2.ts";

const bucket = (env as typeof env & { MEDIA_IMMUTABLE_ORIGINALS: R2Bucket })
  .MEDIA_IMMUTABLE_ORIGINALS;

test("native R2 multipart abort can replay after storage accepted the first abort", async () => {
  const key = `cleanup-fixture/${crypto.randomUUID()}`;
  const upload = await bucket.createMultipartUpload(key);
  await upload.uploadPart(1, new TextEncoder().encode("unfinished"));
  await bucket.resumeMultipartUpload(key, upload.uploadId).abort();
  await bucket.resumeMultipartUpload(key, upload.uploadId).abort();
  expect(await bucket.head(key)).toBeNull();
});

test("video multipart control completes through the R2 binding with source metadata and replays", async () => {
  const key = `reservations/media-reservation-${crypto.randomUUID()}/source`;
  const gateway = makeR2VideoMultipartGateway({
    accountId: "a".repeat(32),
    bucket: "fixture",
    accessKeyId: "fixture-access-key",
    secretAccessKey: "fixture-secret-key",
    bucketBinding: bucket,
  });
  const created = await gateway.create({
    objectKey: key,
    contentType: "video/mp4",
    partSizeBytes: 32,
    partCount: 1,
    expiresInSeconds: 300,
  });
  const part = await bucket
    .resumeMultipartUpload(key, created.uploadId)
    .uploadPart(1, new TextEncoder().encode("video-multipart-binding-fixture"));
  const input = {
    objectKey: key,
    uploadId: created.uploadId,
    contentType: "video/mp4" as const,
    parts: [{ partNumber: part.partNumber, etag: part.etag }],
  };
  try {
    expect(await gateway.completeOrInspect(input)).toEqual({ completed: true });
    const stored = await bucket.head(key);
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
    expect(await gateway.completeOrInspect(input)).toEqual({ completed: true });
    expect((await bucket.head(key))?.version).toBe(stored?.version);
  } finally {
    await bucket.delete(key);
  }
});
