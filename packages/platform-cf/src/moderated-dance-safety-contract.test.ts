import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { MODERATION_POLICY_CATEGORIES_V1 } from "../../contracts/src/community-moderation-policy.ts";
import {
  MODERATED_DANCE_SAFETY_CONTRACT,
  makeModeratedDanceSafetyProtocol,
} from "./moderated-dance-safety-contract.ts";
import { makeOpenAiTextModerationProvider } from "./openai-text-moderation.ts";
import { sha256Hex } from "./r2-upload-signing.ts";
import type { VideoSafetyFrameClaimInput } from "./video-safety-provider.ts";

const frame: VideoSafetyFrameClaimInput = {
  operationId: "attempt",
  submissionId: "review",
  communityId: "community",
  videoRevision: 1,
  creationRevision: 1,
  frameRole: "poster",
  frameArtifactRef: "private-frame",
  frameSha256: "a".repeat(64),
  timestampMs: 0,
  requestedTimestampMs: 0,
  requestId: "request",
};
describe("private safety provider contract with offline transport", () => {
  test("claim, inspect and result retain the original frame/contract hash; caller fields cannot substitute it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const protocol = makeModeratedDanceSafetyProtocol({
      uploadId: "upload",
      token: "work",
      call: async (_label, _sql, values) => {
        seen.push(JSON.parse(String(values[3])));
        return null;
      },
    });
    await protocol.frame("claim", frame, {
      claimToken: "original",
      providerContract: { version: "foreign" },
      requestHash: "foreign",
    });
    await protocol.frame("inspect", frame);
    await protocol.frame("succeed", frame, { claimToken: "original", result: {} });
    expect(seen.map((p) => p.requestHash)).toEqual(
      Array.from({ length: 3 }, () => seen[0]?.requestHash),
    );
    for (const p of seen) expect(p.providerContract).toEqual(MODERATED_DANCE_SAFETY_CONTRACT);
    await protocol.frame("claim", { ...frame, frameSha256: "b".repeat(64) });
    expect(seen[3]?.requestHash).not.toBe(seen[0]?.requestHash);
  });
  test("unknown claim acknowledgement escapes once without a retry or replacement purpose", async () => {
    let calls = 0;
    const protocol = makeModeratedDanceSafetyProtocol({
      uploadId: "upload",
      token: "work",
      call: async () => {
        calls++;
        throw new Error("offline COMMIT unknown");
      },
    });
    await expect(protocol.frame("claim", frame, { claimToken: "original" })).rejects.toThrow(
      "offline COMMIT unknown",
    );
    expect(calls).toBe(1);
  });
  test("the real adapter's inline request matches the bound endpoint and model without a stored file", async () => {
    const bytes = new Uint8Array([255, 216, 255, 217]),
      sha = await sha256Hex(bytes);
    const provider = makeOpenAiTextModerationProvider({
      apiKey: "offline-only",
      transport: async (request) => {
        expect(request.url).toBe(MODERATED_DANCE_SAFETY_CONTRACT.endpoint);
        const body = await request.json();
        expect(body).toEqual({
          model: MODERATED_DANCE_SAFETY_CONTRACT.model,
          input: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}` },
            },
          ],
        });
        return new Response(
          JSON.stringify({
            id: "offline-response",
            model: MODERATED_DANCE_SAFETY_CONTRACT.model,
            results: [
              {
                flagged: false,
                categories: Object.fromEntries(
                  MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, false]),
                ),
                category_scores: Object.fromEntries(
                  MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, 0]),
                ),
                category_applied_input_types: Object.fromEntries(
                  MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, ["image"]]),
                ),
              },
            ],
          }),
        );
      },
    });
    const result = await Effect.runPromise(
      provider.evaluateImage({ bytes, sha256: sha, mediaType: "image/jpeg" }),
    );
    expect(result.input_sha256).toBe(sha);
    expect(result.requested_model).toBe(MODERATED_DANCE_SAFETY_CONTRACT.model);
    expect(result.returned_model).toBe(result.requested_model);
  });
});
