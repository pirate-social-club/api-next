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
  type VideoSafetyFrameProviderResult,
  type VideoSafetyInput,
  VideoSafetyModerationUnresolvedError,
} from "./video-safety-provider.ts";

async function fixture(
  mode:
    | "clean"
    | "minors"
    | "caption"
    | "adult"
    | "adult-review"
    | "unavailable"
    | "bad-digest"
    | "disabled"
    | "oversized-evidence" = "clean",
) {
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const sha256 = await mediaSha256Bytes(bytes);
  const caption =
    mode === "caption" || mode === "adult" || mode === "adult-review" ? "Normalized caption" : null;
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
  let failFrameCompletion = false;
  let failEvidenceSave = false;
  let pauseFirstProviderCall = false;
  let pauseFirstClaimAcquisition = false;
  let claimAcquisitionPaused = false;
  let releaseFirstProviderCall: (() => void) | undefined;
  let releaseFirstClaimAcquisition: (() => void) | undefined;
  let providerCallStarted: (() => void) | undefined;
  let claimAcquisitionStarted: (() => void) | undefined;
  const firstProviderCallStarted = new Promise<void>((resolve) => {
    providerCallStarted = resolve;
  });
  const firstClaimAcquisitionStarted = new Promise<void>((resolve) => {
    claimAcquisitionStarted = resolve;
  });
  const frameClaims = new Map<
    string,
    | { status: "sending"; claimToken: string }
    | { status: "succeeded"; result: VideoSafetyFrameProviderResult }
  >();
  const cleanFrameResult = (): VideoSafetyFrameProviderResult => ({
    provider_id: "openai",
    requested_model: OPENAI_MODERATION_MODEL,
    returned_model: OPENAI_MODERATION_MODEL,
    input_sha256: sha256,
    matched_categories: [],
    evidence: {
      input_sha256: sha256,
      categories: Object.fromEntries(
        MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, false]),
      ) as VideoSafetyFrameProviderResult["evidence"]["categories"],
      scores: Object.fromEntries(
        MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, 0.01]),
      ) as VideoSafetyFrameProviderResult["evidence"]["scores"],
      applied_input_types: Object.fromEntries(
        MODERATION_POLICY_CATEGORIES_V1.map((c) => [c, ["image"]]),
      ) as unknown as VideoSafetyFrameProviderResult["evidence"]["applied_input_types"],
    },
  });
  const requestIdFor = (role: "poster" | "first" | "midpoint") =>
    `video-safety-${input.operationId}-c${input.creationRevision}:v${input.videoRevision}:${role}`;
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
      if (pauseFirstProviderCall && calls.length === 1) {
        providerCallStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirstProviderCall = resolve;
        });
      }
      if (mode === "unavailable") throw new Error("private transport failure");
      const category =
        mode === "minors"
          ? "sexual/minors"
          : mode === "caption" && type === "text"
            ? "hate"
            : mode === "adult" || mode === "adult-review"
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
        if (failEvidenceSave) throw new Error("evidence write failed");
        saved = evidence;
        retained = evidence.fact;
        return evidence.fact;
      },
      inspectFrame: async (claim) => {
        const previous = frameClaims.get(claim.requestId);
        if (previous?.status === "succeeded")
          return { status: "succeeded", result: previous.result };
        if (previous?.status === "sending") return { status: "unresolved" };
        return { status: "absent" };
      },
      claimFrame: async (claim) => {
        if (pauseFirstClaimAcquisition && !claimAcquisitionPaused) {
          claimAcquisitionPaused = true;
          claimAcquisitionStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstClaimAcquisition = resolve;
          });
        }
        const previous = frameClaims.get(claim.requestId);
        if (previous?.status === "succeeded")
          return { status: "succeeded", result: previous.result };
        if (previous?.status === "sending") return { status: "unresolved" };
        const claimToken = `claim-${claim.frameRole}`;
        frameClaims.set(claim.requestId, { status: "sending", claimToken });
        return { status: "dispatch", claimToken };
      },
      succeedFrame: async (claim, claimToken, result) => {
        const previous = frameClaims.get(claim.requestId);
        if (previous?.status !== "sending" || previous.claimToken !== claimToken)
          throw new Error("claim completion mismatch");
        if (failFrameCompletion) throw new Error("claim completion failed");
        frameClaims.set(claim.requestId, { status: "succeeded", result });
        return result;
      },
    },
  });
  return {
    input,
    moderate,
    calls,
    reads,
    evidence: () => saved,
    failFrameCompletion: () => {
      failFrameCompletion = true;
    },
    failEvidenceSave: () => {
      failEvidenceSave = true;
    },
    pauseFirstProviderCall: () => {
      pauseFirstProviderCall = true;
    },
    pauseFirstClaimAcquisition: () => {
      pauseFirstClaimAcquisition = true;
    },
    waitForFirstProviderCall: () => firstProviderCallStarted,
    waitForFirstClaimAcquisition: () => firstClaimAcquisitionStarted,
    releaseClaimAcquisition: () => {
      releaseFirstClaimAcquisition?.();
    },
    releaseProviderCall: () => {
      releaseFirstProviderCall?.();
    },
    seedUnresolvedFrames: (...roles: ("poster" | "first" | "midpoint")[]) => {
      for (const role of roles)
        frameClaims.set(requestIdFor(role), { status: "sending", claimToken: `claim-${role}` });
    },
    seedSucceededFrames: (...roles: ("poster" | "first" | "midpoint")[]) => {
      for (const role of roles)
        frameClaims.set(requestIdFor(role), { status: "succeeded", result: cleanFrameResult() });
    },
  };
}
test("clean frames stay in review, ordered inputs share one retained request and replay makes no provider calls", async () => {
  const f = await fixture();
  const fact = await f.moderate(f.input);
  expect(fact).toMatchObject({
    mediaSafety: "review_required",
    captionSafety: "not_applicable",
    minorSafetyEvidenceRef: null,
    adapterRevision: "video-openai-safety-v2",
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
test.each(["minors", "caption", "adult", "adult-review", "bad-digest", "disabled"] as const)(
  "video safety policy and unavailable mapping: %s",
  async (mode) => {
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
    if (mode === "adult" || mode === "adult-review") {
      expect(fact.automatedRating).toBe("adult_18");
      expect(f.evidence()?.ratingRuleRevision).toBe("accepted-adult-signals-v2");
    }
    if (mode === "adult-review") expect(fact.captionSafety).toBe("review_required");
    if (["bad-digest", "disabled"].includes(mode))
      expect(fact.adapterRevision).toBe("safety-unavailable");
    if (mode === "bad-digest" || mode === "disabled") expect(f.calls).toHaveLength(0);
  },
);

test("an ambiguous provider response remains unresolved and is never dispatched again", async () => {
  const f = await fixture("unavailable");
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
});

test("invalid provider evidence remains unresolved and is never dispatched again", async () => {
  const f = await fixture("oversized-evidence");
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
});

test("provider success followed by claim-result persistence failure is not redispatched", async () => {
  const f = await fixture();
  f.failFrameCompletion();
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
});

test("concurrent moderation admits one provider dispatch for the same frame identity", async () => {
  const f = await fixture();
  f.pauseFirstProviderCall();
  const owner = f.moderate(f.input);
  await f.waitForFirstProviderCall();
  await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
  f.releaseProviderCall();
  const result = await owner;
  expect(f.calls).toEqual(["image", "image", "image"]);
  expect(await f.moderate(f.input)).toEqual(result);
  expect(f.calls).toEqual(["image", "image", "image"]);
});

test.each(["bad-digest", "disabled"] as const)(
  "an unresolved frame claim survives %s without a read, redispatch, or aggregate evidence",
  async (mode) => {
    const f = await fixture(mode);
    f.seedUnresolvedFrames("poster");
    await expect(f.moderate(f.input)).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
    expect(f.reads).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.evidence()).toBeUndefined();
  },
);

test.each(["bad-digest", "disabled"] as const)(
  "succeeded frame claims replay through %s without frame reads or provider calls",
  async (mode) => {
    const f = await fixture(mode);
    f.seedSucceededFrames("poster", "first", "midpoint");
    const fact = await f.moderate(f.input);
    expect(f.reads).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(fact.adapterRevision).toBe("video-openai-safety-v2");
    expect(f.evidence()?.inputs).toHaveLength(3);
  },
);

test("an atomic acquisition resolves a claim created after absent inspection without redispatch", async () => {
  const f = await fixture();
  f.pauseFirstClaimAcquisition();
  f.pauseFirstProviderCall();
  const earlierInspector = f.moderate(f.input);
  await f.waitForFirstClaimAcquisition();
  const winner = f.moderate(f.input);
  await f.waitForFirstProviderCall();
  f.releaseClaimAcquisition();
  await expect(earlierInspector).rejects.toBeInstanceOf(VideoSafetyModerationUnresolvedError);
  expect(f.calls).toEqual(["image"]);
  f.releaseProviderCall();
  const result = await winner;
  expect(f.calls).toEqual(["image", "image", "image"]);
  expect(await f.moderate(f.input)).toEqual(result);
  expect(f.calls).toEqual(["image", "image", "image"]);
});

test("persisted frame results replay after aggregate evidence persistence fails", async () => {
  const f = await fixture();
  f.failEvidenceSave();
  await expect(f.moderate(f.input)).rejects.toThrow("evidence write failed");
  expect(f.calls).toEqual(["image", "image", "image"]);
  await expect(f.moderate(f.input)).rejects.toThrow("evidence write failed");
  expect(f.calls).toEqual(["image", "image", "image"]);
});
