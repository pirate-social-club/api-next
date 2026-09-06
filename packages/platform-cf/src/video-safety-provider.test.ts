import { expect, test } from "bun:test";
import {
  INITIAL_COMMUNITY_MODERATION_POLICY_V1,
  MODERATION_PLATFORM_FLOOR_V1,
  MODERATION_POLICY_CATEGORIES_V1,
} from "@pirate/domain";
import { mediaSha256Bytes } from "../../application/src/media/submission-service.ts";
import {
  canonicalVideoCaptionSha256,
  type VideoSafetyFact,
} from "../../application/src/video/analysis.ts";
import {
  makeOpenAiTextModerationProvider,
  OPENAI_MODERATION_MODEL,
} from "./openai-text-moderation.ts";
import {
  makeVideoSafetyProvider,
  type VideoSafetyEvidence,
  type VideoSafetyInput,
} from "./video-safety-provider.ts";

async function fixture(
  mode:
    | "clean"
    | "minors"
    | "caption"
    | "adult"
    | "unavailable"
    | "bad-digest"
    | "disabled"
    | "oversized-evidence" = "clean",
) {
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const sha256 = await mediaSha256Bytes(bytes);
  const caption = mode === "caption" || mode === "adult" ? "Normalized caption" : null;
  const frame = (role: "poster" | "first" | "midpoint") => ({
    role,
    artifactRef: `media://derived/${role}.jpg`,
    sha256,
    timestampMs: 1000,
    requestedTimestampMs: null,
  });
  const input: VideoSafetyInput = {
    operationId: "operation-1",
    submissionId: "submission-1",
    communityId: "community-1",
    videoRevision: 1,
    creationRevision: 2,
    authorDeclaredRating: "general",
    caption,
    captionSha256: await canonicalVideoCaptionSha256(caption),
    frames: [frame("poster"), frame("first"), frame("midpoint")],
  };
  const calls: string[] = [];
  const reads: string[] = [];
  let saved: VideoSafetyEvidence | undefined;
  let retained: VideoSafetyFact | null = null;
  const port = makeOpenAiTextModerationProvider({
    apiKey: "fixture",
    reportDiagnostic: () => {},
    transport: async (request) => {
      const body = (await request.json()) as { input: ({ type?: string } | string)[] };
      const type =
        typeof body.input[0] === "string"
          ? "text"
          : body.input[0]?.type === "image_url"
            ? "image"
            : "text";
      calls.push(type);
      if (mode === "unavailable") throw new Error("private transport failure");
      const category =
        mode === "minors"
          ? "sexual/minors"
          : mode === "caption" && type === "text"
            ? "hate"
            : mode === "adult"
              ? "sexual"
              : null;
      return Response.json({
        id: "modr_fixture",
        model: OPENAI_MODERATION_MODEL,
        results: [
          {
            flagged: category !== null,
            categories: Object.fromEntries(
              MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, c === category]),
            ),
            category_scores: Object.fromEntries(
              MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, c === category ? 0.99 : 0.01]),
            ),
            category_applied_input_types: Object.fromEntries(
              MODERATION_POLICY_CATEGORIES_V1.map((c) => [
                c,
                mode === "oversized-evidence" ? Array(200).fill(type) : [type],
              ]),
            ),
          },
        ],
      });
    },
  });
  const moderate = makeVideoSafetyProvider({
    image: mode === "disabled" ? null : port,
    text: port,
    readFrame: async (reference) => {
      reads.push(reference);
      return mode === "bad-digest" ? new Uint8Array([0]) : bytes;
    },
    readPolicy: async () => ({
      policy_revision: "moderation-v1",
      policy_hash: "a".repeat(64),
      platform_policy_revision: "floor-v1",
      platform_policy_hash: "b".repeat(64),
      platform_policy: MODERATION_PLATFORM_FLOOR_V1,
      community_policy_revision: "community-v1",
      community_policy_hash: "c".repeat(64),
      community_policy:
        mode === "adult" ? MODERATION_PLATFORM_FLOOR_V1 : INITIAL_COMMUNITY_MODERATION_POLICY_V1,
    }),
    evidence: {
      load: async () => retained,
      save: async (_input, evidence) => {
        saved = evidence;
        retained = evidence.fact;
        return evidence.fact;
      },
    },
  });
  return { input, moderate, calls, reads, evidence: () => saved };
}
test("clean frames stay in review, ordered inputs share one retained request and replay makes no provider calls", async () => {
  const f = await fixture();
  const fact = await f.moderate(f.input);
  expect(fact).toMatchObject({
    mediaSafety: "review_required",
    captionSafety: "not_applicable",
    minorSafetyEvidenceRef: null,
    adapterRevision: "video-openai-safety-v1",
  });
  expect(f.reads).toEqual([
    "media://derived/poster.jpg",
    "media://derived/first.jpg",
    "media://derived/midpoint.jpg",
  ]);
  expect(f.calls).toEqual(["image", "image", "image"]);
  expect(await f.moderate(f.input)).toEqual(fact);
  expect(f.calls).toHaveLength(3);
  expect(f.evidence()?.inputs).toHaveLength(3);
});
test.each([
  "minors",
  "caption",
  "adult",
  "unavailable",
  "bad-digest",
  "disabled",
  "oversized-evidence",
] as const)("video safety policy and unavailable mapping: %s", async (mode) => {
  const f = await fixture(mode);
  const fact = await f.moderate(f.input);
  expect(fact.mediaSafety).not.toBe("allow");
  expect(fact.minorSafetyEvidenceRef).toBeNull();
  if (mode === "minors") {
    expect(fact.mediaSafety).toBe("blocked");
    expect(f.evidence()?.platformHeld).toBe(true);
  }
  if (mode === "caption") {
    expect(fact.captionSafety).toBe("review_required");
    expect(f.calls).toEqual(["image", "image", "image", "text"]);
  }
  if (mode === "adult") expect(fact.automatedRating).toBe("adult_18");
  if (["unavailable", "bad-digest", "disabled", "oversized-evidence"].includes(mode))
    expect(fact.adapterRevision).toBe("safety-unavailable");
  if (mode === "bad-digest" || mode === "disabled") expect(f.calls).toHaveLength(0);
});
