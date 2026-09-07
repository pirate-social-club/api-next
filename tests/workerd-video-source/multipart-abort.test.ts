import { env } from "cloudflare:test";
import { expect, test } from "vitest";

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
