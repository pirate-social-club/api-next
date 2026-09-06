import { env } from "cloudflare:test";
import { setupNetwork } from "@msw/cloudflare";
import { MODERATION_POLICY_CATEGORIES_V1 } from "@pirate/contracts";
import { Effect } from "effect";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mediaSha256Bytes } from "../../packages/application/src/media/submission-service.ts";
import {
  makeOpenAiTextModerationProvider,
  OPENAI_MODERATION_MODEL,
} from "../../packages/platform-cf/src/openai-text-moderation.ts";
import { makeVideoSafetyFrameReader } from "../../packages/platform-cf/src/video-safety-frame-reader.ts";

const network = setupNetwork();
beforeEach(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  network.disable();
});
test("video safety reads a sealed frame and moderates through the real Workerd fetch path", async () => {
  const bucket = (env as unknown as { MEDIA_IMMUTABLE_ORIGINALS: R2Bucket })
    .MEDIA_IMMUTABLE_ORIGINALS;
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const sha256 = await mediaSha256Bytes(bytes);
  await bucket.put("video-safety/poster.jpg", bytes, {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { sha256 },
  });
  const read = makeVideoSafetyFrameReader(bucket);
  const image = await read("media://derived/video-safety/poster.jpg", sha256);
  let captured = "";
  network.use(
    http.post("https://api.openai.com/v1/moderations", async ({ request }) => {
      expect(request.redirect).toBe("manual");
      captured = await request.text();
      return HttpResponse.json({
        id: "modr_workerd",
        model: OPENAI_MODERATION_MODEL,
        results: [
          {
            flagged: false,
            categories: Object.fromEntries(MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, false])),
            category_scores: Object.fromEntries(
              MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, 0.01]),
            ),
            category_applied_input_types: Object.fromEntries(
              MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, ["image"]]),
            ),
          },
        ],
      });
    }),
  );
  const provider = makeOpenAiTextModerationProvider({ apiKey: "fixture-key" });
  const result = await Effect.runPromise(
    provider.evaluateImage({ bytes: image, mediaType: "image/jpeg", sha256 }),
  );
  expect(result.input_sha256).toBe(sha256);
  expect(JSON.parse(captured).input).toEqual([
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/2Q==" } },
  ]);
  await expect(read("media://derived/video-safety/poster.jpg", "a".repeat(64))).rejects.toThrow(
    "identity mismatch",
  );
});
test("video safety real fetch refuses redirects without following the location", async () => {
  let followed = false;
  network.use(
    http.post(
      "https://api.openai.com/v1/moderations",
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
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const provider = makeOpenAiTextModerationProvider({
    apiKey: "fixture-key",
    reportDiagnostic: () => {},
  });
  await expect(
    Effect.runPromise(
      provider.evaluateImage({
        bytes,
        mediaType: "image/jpeg",
        sha256: await mediaSha256Bytes(bytes),
      }),
    ),
  ).rejects.toBeDefined();
  expect(followed).toBe(false);
});
