import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { MediaTransformVideoProbeInput } from "../../packages/application/src/media/transform.ts";
import {
  makeModeratedDanceCloudConvertProbe,
  makeR2ModeratedDanceProbeSource,
} from "../../packages/platform-cf/src/moderated-dance-cloudconvert-probe.ts";

const bindings = env as typeof env & { MEDIA_IMMUTABLE_ORIGINALS: R2Bucket };

describe("private probe stream in Workerd with real R2 and intercepted provider", () => {
  test("sealed identity streams dynamic multipart fields once; an uncertain upload only observes", async () => {
    const key = `moderated-dance/originals/${crypto.randomUUID()}/source`,
      bytes = new Uint8Array([0, 1, 2, 3, 4, 255]);
    const object = await bindings.MEDIA_IMMUTABLE_ORIGINALS.put(key, bytes, {
      httpMetadata: { contentType: "video/mp4" },
    });
    const sealed = {
      destination_ref: key,
      canonical_sha256: "a".repeat(64),
      size_bytes: bytes.length,
      version: object.version,
      etag: object.etag,
    };
    const request: MediaTransformVideoProbeInput = {
      version: "media-transform-video-probe-input-v1",
      binding: {
        operationId: "fixture",
        videoRevision: 1,
        creationRevision: 1,
        analysisRevision: 1,
        canonicalVideoSha256: sealed.canonical_sha256,
        requestId: "private-probe-fixture",
      },
      source: {
        objectKey: key,
        sha256: sealed.canonical_sha256,
        byteLength: bytes.length,
        mediaType: "video/mp4",
      },
      attempt: {
        version: "media-transform-attempt-v1",
        runtimeFence: { submittedAtMs: Date.now(), runtimeDeadlineMs: Date.now() + 60_000 },
        providerJobId: "original-job",
        providerJobPhase: "submitting",
      },
    };
    let uploaded = 0,
      finished = false;
    const methods: string[] = [];
    const probe = makeModeratedDanceCloudConvertProbe({
      apiKey: "fictional-provider-key",
      timeoutSeconds: 30,
      readSource: makeR2ModeratedDanceProbeSource(bindings.MEDIA_IMMUTABLE_ORIGINALS, sealed),
      send: async (url, init) => {
        methods.push(String(init.method));
        if (init.method === "POST") {
          expect(url).toBe("https://eu-central.storage.cloudconvert.com/original-import");
          if (!(init.headers instanceof Headers) || !(init.body instanceof ReadableStream))
            throw new Error("Expected streamed upload with headers");
          expect(init.headers.has("Authorization")).toBe(false);
          const form = await new Response(init.body, { headers: init.headers }).formData();
          expect([...form.keys()]).toEqual(["signature", "arbitrary_field", "file"]);
          const file = form.get("file");
          if (!(file instanceof File)) throw new Error("Multipart file missing");
          expect(file.name).toBe("source.mp4");
          expect(file.type).toBe("video/mp4");
          expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
          uploaded++;
          finished = true;
          throw new Error("Provider accepted the file but its reply was lost");
        }
        expect(url).toBe("https://api.cloudconvert.com/v2/jobs/original-job");
        const status = finished ? "finished" : "waiting";
        return Response.json({
          data: {
            id: "original-job",
            tag: request.binding.requestId,
            status,
            tasks: [
              {
                id: "original-import",
                name: "import-recording",
                operation: "import/upload",
                status,
                depends_on_task_ids: [],
                result: {
                  form: {
                    url: "https://eu-central.storage.cloudconvert.com/original-import",
                    parameters: { signature: "fictional-signature", arbitrary_field: "dynamic" },
                  },
                },
              },
              {
                id: "original-metadata",
                name: "source-probe",
                operation: "metadata",
                status,
                engine: "ffmpeg",
                engine_version: "6.1.4",
                depends_on_task_ids: ["original-import"],
                result: {
                  metadata: {
                    format: { duration: "12", size: String(bytes.length) },
                    streams: [
                      {
                        codec_type: "video",
                        codec_name: "h264",
                        width: 1080,
                        height: 1920,
                        avg_frame_rate: "30/1",
                      },
                      { codec_type: "audio", codec_name: "aac" },
                    ],
                  },
                },
              },
            ],
          },
        });
      },
    });
    expect(await Effect.runPromise(probe.submit(request))).toMatchObject({
      status: "retryable_failure",
      attempt: request.attempt,
    });
    expect(await Effect.runPromise(probe.observe(request))).toMatchObject({
      status: "completed",
      probe: { durationMs: 12000, frameRateMillihertz: 30000 },
    });
    expect(methods).toEqual(["GET", "POST", "GET"]);
    expect(uploaded).toBe(1);
    await bindings.MEDIA_IMMUTABLE_ORIGINALS.delete(key);
  });
  test("replacement R2 versions and size/hash/key changes cannot enter the upload stream", async () => {
    const key = `moderated-dance/originals/${crypto.randomUUID()}/source`,
      bucket = bindings.MEDIA_IMMUTABLE_ORIGINALS;
    const first = await bucket.put(key, "original", { httpMetadata: { contentType: "video/mp4" } });
    const sealed = {
      destination_ref: key,
      canonical_sha256: "a".repeat(64),
      size_bytes: 8,
      version: first.version,
      etag: first.etag,
    };
    const source = {
      objectKey: key,
      sha256: sealed.canonical_sha256,
      byteLength: 8,
      mediaType: "video/mp4" as const,
    };
    const read = makeR2ModeratedDanceProbeSource(bucket, sealed);
    await expect(read({ ...source, sha256: "b".repeat(64) })).rejects.toThrow("binding changed");
    await expect(read({ ...source, objectKey: `${key}-other` })).rejects.toThrow("binding changed");
    await bucket.put(key, "replaced", { httpMetadata: { contentType: "video/mp4" } });
    await expect(read(source)).rejects.toThrow();
    await bucket.delete(key);
  });
});
