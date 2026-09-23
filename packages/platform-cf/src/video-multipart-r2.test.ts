import { describe, expect, test } from "bun:test";
import {
  makeR2VideoMultipartGateway,
  type R2VideoMultipartOptions,
  VIDEO_MULTIPART_CORS_REQUIREMENTS,
} from "./video-multipart-r2.ts";

const objectKey = "reservations/media-reservation-00000000-0000-4000-8000-000000000001/source";
const options = {
  accountId: "a".repeat(32),
  bucket: "video-ingress",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key-never-exposed",
  now: () => new Date("2026-09-04T00:00:00.000Z"),
};
type BucketBinding = R2VideoMultipartOptions["bucketBinding"];

describe("R2 video multipart gateway", () => {
  test("creates a metadata-bearing upload in the binding and signs the exact fixed part set", async () => {
    const creations: Array<{ key: string; contentType: string | undefined }> = [];
    const bucketBinding = {
      createMultipartUpload: async (
        key: string,
        metadata: { httpMetadata: { contentType: string } },
      ) => {
        creations.push({ key, contentType: metadata.httpMetadata?.contentType });
        return { uploadId: "opaque/upload+id" };
      },
      head: async () => null,
      resumeMultipartUpload: () => ({ complete: async () => ({}), abort: async () => {} }),
    } as BucketBinding;
    const gateway = makeR2VideoMultipartGateway({ ...options, bucketBinding });
    const result = await gateway.create({
      objectKey,
      contentType: "video/mp4",
      partSizeBytes: 10,
      partCount: 2,
      expiresInSeconds: 3_600,
    });
    expect(creations).toEqual([{ key: objectKey, contentType: "video/mp4" }]);
    expect(result.parts.map(({ partNumber }) => partNumber)).toEqual([1, 2]);
    expect(result.parts[0]?.url).toContain("partNumber=1");
    expect(result.parts[0]?.url).toContain("uploadId=opaque%2Fupload%2Bid");
    expect(result.parts[0]?.url).not.toContain(options.secretAccessKey);
  });

  test("a persisted object replays without another completion", async () => {
    let completionCalls = 0;
    const bucketBinding = {
      head: async () => ({ key: objectKey }),
      createMultipartUpload: async () => ({ uploadId: "unused" }),
      resumeMultipartUpload: () => ({
        complete: async () => {
          completionCalls += 1;
          return { key: objectKey };
        },
        abort: async () => {},
      }),
    } as BucketBinding;
    const gateway = makeR2VideoMultipartGateway({ ...options, bucketBinding });
    const input = {
      objectKey,
      uploadId: "opaque-upload",
      contentType: "video/mp4" as const,
      parts: [{ partNumber: 1, etag: "etag-one" }],
    };
    await expect(gateway.completeOrInspect(input)).resolves.toEqual({ completed: true });
    await expect(gateway.completeOrInspect(input)).resolves.toEqual({ completed: true });
    expect(completionCalls).toBe(0);
  });

  test("refuses malformed part plans before creating an external upload", async () => {
    let creations = 0;
    const bucketBinding = {
      head: async () => null,
      createMultipartUpload: async () => {
        creations += 1;
        return { uploadId: "unused" };
      },
      resumeMultipartUpload: () => ({ complete: async () => ({}), abort: async () => {} }),
    } as BucketBinding;
    const gateway = makeR2VideoMultipartGateway({ ...options, bucketBinding });
    await expect(
      gateway.create({
        objectKey,
        contentType: "video/mp4",
        partSizeBytes: 10,
        partCount: 0,
        expiresInSeconds: 300,
      }),
    ).rejects.toThrow("invalid multipart target");
    expect(creations).toBe(0);
  });

  test("a lost completion result converges through exact-object inspection", async () => {
    let exists = false;
    let completionCalls = 0;
    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    const bucketBinding = {
      head: async () => (exists ? { key: objectKey } : null),
      createMultipartUpload: async () => ({ uploadId: "unused" }),
      resumeMultipartUpload: (key: string, uploadId: string) => {
        expect([key, uploadId]).toEqual([objectKey, "opaque-upload"]);
        return {
          complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
            completionCalls += 1;
            completedParts.push(...parts);
            exists = true;
            throw new TypeError("lost response");
          },
          abort: async () => {},
        };
      },
    } as BucketBinding;
    const gateway = makeR2VideoMultipartGateway({ ...options, bucketBinding });
    const input = {
      objectKey,
      uploadId: "opaque-upload",
      contentType: "video/mp4" as const,
      parts: [{ partNumber: 1, etag: "unquoted-browser-etag" }],
    };
    await expect(gateway.completeOrInspect(input)).resolves.toEqual({ completed: true });
    await expect(gateway.completeOrInspect(input)).resolves.toEqual({ completed: true });
    expect(completionCalls).toBe(1);
    expect(completedParts).toEqual([{ partNumber: 1, etag: "unquoted-browser-etag" }]);
  });

  test("an unresolved completion never reports success without an object", async () => {
    let calls = 0;
    const bucketBinding = {
      head: async () => null,
      createMultipartUpload: async () => ({ uploadId: "unused" }),
      resumeMultipartUpload: () => ({
        complete: async () => {
          calls += 1;
          throw new TypeError("lost response");
        },
        abort: async () => {},
      }),
    } as BucketBinding;
    const gateway = makeR2VideoMultipartGateway({ ...options, bucketBinding });
    await expect(
      gateway.completeOrInspect({
        objectKey,
        uploadId: "opaque-upload",
        contentType: "video/mp4",
        parts: [{ partNumber: 1, etag: "etag-one" }],
      }),
    ).rejects.toThrow("lost response");
    expect(calls).toBe(1);
  });

  test("aborts only the exact upload through the binding", async () => {
    const aborted: string[] = [];
    const bucketBinding = {
      head: async () => null,
      createMultipartUpload: async () => ({ uploadId: "unused" }),
      resumeMultipartUpload: (key: string, uploadId: string) => ({
        complete: async () => ({}),
        abort: async () => {
          aborted.push(`${key}:${uploadId}`);
        },
      }),
    } as BucketBinding;
    const gateway = makeR2VideoMultipartGateway({ ...options, bucketBinding });
    await gateway.abort({ objectKey, uploadId: "opaque-upload" });
    expect(aborted).toEqual([`${objectKey}:opaque-upload`]);
    await expect(gateway.abort({ objectKey: "wrong", uploadId: "opaque-upload" })).rejects.toThrow(
      "invalid multipart target",
    );
  });

  test("publishes the browser CORS requirement as an exact closed constant", () => {
    expect(VIDEO_MULTIPART_CORS_REQUIREMENTS).toEqual({
      methods: ["PUT"],
      exposeHeaders: ["ETag"],
    });
  });
});
