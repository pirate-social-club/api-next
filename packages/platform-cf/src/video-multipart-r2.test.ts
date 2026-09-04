import { describe, expect, test } from "bun:test";
import {
  makeR2VideoMultipartGateway,
  VIDEO_MULTIPART_CORS_REQUIREMENTS,
} from "./video-multipart-r2.ts";

const options = {
  accountId: "a".repeat(32),
  bucket: "video-ingress",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key-never-exposed",
  now: () => new Date("2026-09-04T00:00:00.000Z"),
};
const objectKey = "reservations/media-reservation-00000000-0000-4000-8000-000000000001/source";

const toRequest = (input: string | URL | Request, init?: RequestInit): Request =>
  input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

describe("R2 video multipart gateway", () => {
  test("creates a server-owned upload and signs the exact fixed part set", async () => {
    const requests: Request[] = [];
    const gateway = makeR2VideoMultipartGateway({
      ...options,
      fetch: async (input, init) => {
        const request = toRequest(input, init);
        requests.push(request);
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>opaque/upload+id</UploadId></InitiateMultipartUploadResult>",
        );
      },
    });
    const result = await gateway.create({
      objectKey,
      contentType: "video/mp4",
      partSizeBytes: 10,
      partCount: 2,
      expiresInSeconds: 3_600,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]?.url ?? "https://invalid").searchParams.has("uploads")).toBe(true);
    expect(result.parts.map(({ partNumber }) => partNumber)).toEqual([1, 2]);
    expect(result.parts[0]?.url).toContain("partNumber=1");
    expect(result.parts[0]?.url).toContain("uploadId=opaque%2Fupload%2Bid");
    expect(result.parts[0]?.url).not.toContain(options.secretAccessKey);
    expect(await requests[0]?.text()).not.toContain(options.secretAccessKey);
  });

  test("lost completion response converges through exact-object inspection", async () => {
    let exists = false;
    let completionCalls = 0;
    const gateway = makeR2VideoMultipartGateway({
      ...options,
      fetch: async (input, init) => {
        const request = toRequest(input, init);
        if (request.method === "HEAD") return new Response(null, { status: exists ? 200 : 404 });
        if (request.method === "POST") {
          completionCalls += 1;
          exists = true;
          throw new TypeError("lost response");
        }
        throw new Error("unexpected request");
      },
    });
    const input = {
      objectKey,
      uploadId: "opaque-upload",
      contentType: "video/mp4" as const,
      parts: [{ partNumber: 1, etag: "etag-one" }],
    };
    await expect(gateway.completeOrInspect(input)).resolves.toEqual({ completed: true });
    await expect(gateway.completeOrInspect(input)).resolves.toEqual({ completed: true });
    expect(completionCalls).toBe(1);
  });

  test("completion XML escapes opaque ETags and does not disclose credentials", async () => {
    const bodies: string[] = [];
    let heads = 0;
    const gateway = makeR2VideoMultipartGateway({
      ...options,
      fetch: async (input, init) => {
        const request = toRequest(input, init);
        if (request.method === "HEAD") {
          heads += 1;
          return new Response(null, { status: 404 });
        }
        bodies.push(await request.text());
        return new Response("<CompleteMultipartUploadResult />");
      },
    });
    await gateway.completeOrInspect({
      objectKey,
      uploadId: "opaque-upload",
      contentType: "video/mp4",
      parts: [{ partNumber: 1, etag: "opaque<&etag" }],
    });
    expect(heads).toBe(1);
    expect(bodies[0]).toContain("opaque&lt;&amp;etag");
    expect(bodies[0]).not.toContain(options.secretAccessKey);
  });

  test("publishes the browser CORS requirement as an exact closed constant", () => {
    expect(VIDEO_MULTIPART_CORS_REQUIREMENTS).toEqual({
      methods: ["PUT"],
      exposeHeaders: ["ETag"],
    });
  });
});
