import { env } from "cloudflare:test";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mediaSha256Bytes } from "../../packages/application/src/media/submission-service.ts";
import {
  makeAcrCloudFetchTransport,
  makeR2MediaProcessingArtifactReader,
} from "../../packages/platform-cf/src/media-processing-runtime.ts";
import { makeAcrCloudAdapter } from "../../packages/platform-cf/src/media-providers/acrcloud.ts";
import { makeVideoRecognitionProvider } from "../../packages/platform-cf/src/video-recognition-provider.ts";

const network = setupNetwork();
beforeEach(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  network.disable();
});

test("video recognition reads sealed clips and uses the real Workerd ACR fetch path", async () => {
  const bucket = (env as unknown as { MEDIA_IMMUTABLE_ORIGINALS: R2Bucket })
    .MEDIA_IMMUTABLE_ORIGINALS;
  const bytes = new Uint8Array([255, 251, 144, 0]);
  const digest = await mediaSha256Bytes(bytes);
  const calls: string[] = [];
  for (const variant of ["primary", "alternate"])
    await bucket.put(`video-recognition/${variant}.mp3`, bytes, {
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: { sha256: digest },
    });
  network.use(
    http.post("https://identify-eu-west-1.acrcloud.com/v1/identify", async ({ request }) => {
      expect(request.redirect).toBe("manual");
      const body = await request.formData();
      const sample = body.get("sample");
      if (!(sample instanceof File)) throw new Error("missing sample");
      calls.push(sample.name);
      expect(sample.type).toBe("audio/mpeg");
      expect(new Uint8Array(await sample.arrayBuffer())).toEqual(bytes);
      expect(body.get("signature")).toBeTruthy();
      return HttpResponse.json({ status: { code: 1001 } });
    }),
  );
  const identification = makeAcrCloudAdapter({
    host: "identify-eu-west-1.acrcloud.com",
    credentials: { accessKey: "fixture-key", accessSecret: "fixture-secret" },
    adapterRevision: "acrcloud-adapter-v1",
    clock: () => 1_800_000_000,
    transport: makeAcrCloudFetchTransport("identify-eu-west-1.acrcloud.com"),
    limits: {
      maxSampleBytes: 4_000_000,
      maxRequestBytes: 4_100_000,
      maxResponseBytes: 1_048_576,
      timeoutMs: 120_000,
    },
  });
  const provider = makeVideoRecognitionProvider({
    identification,
    reader: makeR2MediaProcessingArtifactReader(bucket),
  });
  const clip = (variant: "primary" | "alternate") => ({
    variant,
    artifactRef: `media://derived/video-recognition/${variant}.mp3`,
    canonicalSha256: digest,
    sizeBytes: bytes.length,
    offsetMs: 0,
    durationMs: 1000,
    mediaType: "audio/mpeg" as const,
  });
  const input = {
    operationId: "video-workerd-acr",
    videoRevision: 1,
    creationRevision: 1,
    clips: [clip("primary"), clip("alternate")] as const,
  };
  expect((await provider(input)).verification?.status).toBe("no_match");
  expect(calls).toEqual(["primary.mp3", "alternate.mp3"]);
  let followed = false;
  network.use(
    http.post(
      "https://identify-eu-west-1.acrcloud.com/v1/identify",
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: "https://untrusted.invalid/" },
        }),
    ),
    http.get("https://untrusted.invalid/", () => {
      followed = true;
      return new HttpResponse(null);
    }),
  );
  expect(await provider(input)).toMatchObject({ verification: null, exhaustion: "acr_exhausted" });
  expect(followed).toBe(false);
});
