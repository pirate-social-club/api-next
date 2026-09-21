import {
  canonicalTextModerationInput,
  MODERATION_POLICY_CATEGORIES_V1,
  MODERATION_RATING_RULE_V2,
  resolveCommunityModerationPolicyV2,
} from "@pirate/domain";
import { Effect } from "effect";
import type { ImageModerationProviderServiceV1 } from "../../application/src/media/processing-contracts.ts";
import { mediaSha256Bytes } from "../../application/src/media/submission-service.ts";
import type {
  TextModerationPolicySnapshotV2,
  TextModerationProviderServiceV1,
} from "../../application/src/text-moderation-runtime.ts";
import {
  canonicalVideoCaptionSha256,
  type VideoAnalysisProviders,
  type VideoSafetyFact,
} from "../../application/src/video/analysis.ts";
import { VIDEO_POSTER_POLICY_V1 } from "../../domain/src/video-submission.ts";

export type VideoSafetyInput = Parameters<VideoAnalysisProviders["moderate"]>[0];
export type VideoSafetyFrameProviderResult = Effect.Success<
  ReturnType<ImageModerationProviderServiceV1["evaluateImage"]>
>;
export type VideoSafetyFrameClaimInput = Readonly<{
  operationId: string;
  submissionId: string;
  communityId: string;
  videoRevision: number;
  creationRevision: number;
  frameRole: (typeof VIDEO_POSTER_POLICY_V1.roles)[number];
  frameArtifactRef: string;
  frameSha256: string;
  timestampMs: number;
  requestedTimestampMs: number | null;
  requestId: string;
}>;
export type VideoSafetyFrameClaim =
  | Readonly<{ status: "dispatch"; claimToken: string }>
  | Readonly<{ status: "succeeded"; result: VideoSafetyFrameProviderResult }>
  | Readonly<{ status: "unresolved" }>;
export type VideoSafetyFrameClaimInspection =
  | Readonly<{ status: "absent" }>
  | Extract<VideoSafetyFrameClaim, { status: "succeeded" | "unresolved" }>;
export type VideoSafetyEvidence = Readonly<{
  ratingRuleRevision?: typeof MODERATION_RATING_RULE_V2;
  requestId: string;
  inputDigest: string;
  fact: VideoSafetyFact;
  platformHeld: boolean;
  policy: TextModerationPolicySnapshotV2 | null;
  inputs: readonly unknown[];
}>;
export type VideoSafetyEvidenceStore = Readonly<{
  load: (input: VideoSafetyInput, inputDigest: string) => Promise<VideoSafetyFact | null>;
  save: (
    input: VideoSafetyInput,
    evidence: VideoSafetyEvidence,
    unavailableFrames?: readonly VideoSafetyFrameClaimInput[],
  ) => Promise<VideoSafetyFact>;
  inspectFrame: (input: VideoSafetyFrameClaimInput) => Promise<VideoSafetyFrameClaimInspection>;
  claimFrame: (input: VideoSafetyFrameClaimInput) => Promise<VideoSafetyFrameClaim>;
  succeedFrame: (
    input: VideoSafetyFrameClaimInput,
    claimToken: string,
    result: VideoSafetyFrameProviderResult,
  ) => Promise<VideoSafetyFrameProviderResult>;
}>;

export class VideoSafetyModerationUnresolvedError extends Error {
  readonly code = "video_safety_moderation_unresolved";

  constructor(
    readonly requestId: string,
    options?: ErrorOptions,
  ) {
    super("video safety moderation dispatch is unresolved", options);
    this.name = "VideoSafetyModerationUnresolvedError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

export function validateVideoSafetyFrameProviderResult(
  value: unknown,
  expectedSha256: string,
): VideoSafetyFrameProviderResult {
  if (!isRecord(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 12_288)
    throw new Error("video safety provider result invalid");
  if (
    !hasExactKeys(value, [
      "provider_id",
      "requested_model",
      "returned_model",
      "input_sha256",
      "matched_categories",
      "evidence",
    ]) ||
    value.provider_id !== "openai" ||
    typeof value.requested_model !== "string" ||
    value.requested_model.length === 0 ||
    typeof value.returned_model !== "string" ||
    value.returned_model.length === 0 ||
    value.input_sha256 !== expectedSha256 ||
    !Array.isArray(value.matched_categories) ||
    !isRecord(value.evidence)
  )
    throw new Error("video safety provider result shape mismatch");
  const categorySet = new Set<string>(MODERATION_POLICY_CATEGORIES_V1);
  const matched = value.matched_categories;
  if (
    matched.some((category) => typeof category !== "string" || !categorySet.has(category)) ||
    new Set(matched).size !== matched.length ||
    !hasExactKeys(value.evidence, [
      "input_sha256",
      "categories",
      "scores",
      "applied_input_types",
    ]) ||
    value.evidence.input_sha256 !== expectedSha256 ||
    !isRecord(value.evidence.categories) ||
    !isRecord(value.evidence.scores) ||
    !isRecord(value.evidence.applied_input_types) ||
    !hasExactKeys(value.evidence.categories, MODERATION_POLICY_CATEGORIES_V1) ||
    !hasExactKeys(value.evidence.scores, MODERATION_POLICY_CATEGORIES_V1) ||
    !hasExactKeys(value.evidence.applied_input_types, MODERATION_POLICY_CATEGORIES_V1)
  )
    throw new Error("video safety provider evidence shape mismatch");
  for (const category of MODERATION_POLICY_CATEGORIES_V1) {
    const score = value.evidence.scores[category];
    const applied = value.evidence.applied_input_types[category];
    if (
      typeof value.evidence.categories[category] !== "boolean" ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1 ||
      !Array.isArray(applied) ||
      applied.some((inputType) => inputType !== "text" && inputType !== "image") ||
      value.evidence.categories[category] !== matched.includes(category)
    )
      throw new Error("video safety provider category evidence mismatch");
  }
  return value as VideoSafetyFrameProviderResult;
}

/** OpenAI is a signal provider; without the separate visual gate media allow is unreachable. */
export function makeVideoSafetyProvider(
  options: Readonly<{
    image: ImageModerationProviderServiceV1 | null;
    text: TextModerationProviderServiceV1 | null;
    readFrame: (reference: string, sha256: string) => Promise<Uint8Array>;
    readPolicy: (communityId: string) => Promise<TextModerationPolicySnapshotV2>;
    evidence: VideoSafetyEvidenceStore;
  }>,
): VideoAnalysisProviders["moderate"] {
  return async (input) => {
    const requestId = `video-safety-${input.operationId}-c${input.creationRevision}`;
    const caption =
      input.caption === null
        ? null
        : input.caption.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
    const inputDigest = await mediaSha256Bytes(
      new TextEncoder().encode(
        JSON.stringify([
          requestId,
          input.submissionId,
          input.communityId,
          input.videoRevision,
          input.authorDeclaredRating,
          caption,
          input.captionSha256,
          input.frames.map((frame) => [
            frame.role,
            frame.artifactRef,
            frame.sha256,
            frame.timestampMs,
            frame.requestedTimestampMs,
          ]),
        ]),
      ),
    );
    const retained = await options.evidence.load(input, inputDigest);
    if (retained !== null) return retained;
    let policy: TextModerationPolicySnapshotV2 | null = null;
    let unavailable = false;
    try {
      policy = await options.readPolicy(input.communityId);
    } catch {
      unavailable = true;
    }
    let platformHeld = false;
    let automatedRating: VideoSafetyFact["automatedRating"] = "general";
    const inputs: unknown[] = [];
    const unavailableFrames: VideoSafetyFrameClaimInput[] = [];
    let mediaSafety: VideoSafetyFact["mediaSafety"] = "review_required";
    let captionSafety: VideoSafetyFact["captionSafety"] =
      caption === null ? "not_applicable" : "review_required";
    const resolve = (categories: readonly string[]) => {
      // A known hard-floor signal cannot be weakened by an unavailable community policy.
      if (categories.includes("sexual/minors")) platformHeld = true;
      const result = resolveCommunityModerationPolicyV2({
        platform_floor: policy?.platform_policy,
        community_policy: policy?.community_policy,
        matched_categories: categories,
        author_declared_rating: input.authorDeclaredRating,
      });
      if (result.automated_rating === "adult_18") automatedRating = "adult_18";
      if (result.fail_closed_reasons.length > 0) unavailable = true;
      return result;
    };
    for (const [index, frame] of input.frames.entries()) {
      const claimInput: VideoSafetyFrameClaimInput = {
        operationId: input.operationId,
        submissionId: input.submissionId,
        communityId: input.communityId,
        videoRevision: input.videoRevision,
        creationRevision: input.creationRevision,
        frameRole: frame.role,
        frameArtifactRef: frame.artifactRef,
        frameSha256: frame.sha256,
        timestampMs: frame.timestampMs,
        requestedTimestampMs: frame.requestedTimestampMs,
        requestId: `${requestId}:v${input.videoRevision}:${frame.role}`,
      };
      const retainedClaim = await options.evidence.inspectFrame(claimInput);
      if (retainedClaim.status === "unresolved") {
        throw new VideoSafetyModerationUnresolvedError(claimInput.requestId);
      }
      let result: VideoSafetyFrameProviderResult;
      if (retainedClaim.status === "succeeded") {
        result = retainedClaim.result;
      } else {
        let bytes: Uint8Array;
        try {
          if (frame.role !== VIDEO_POSTER_POLICY_V1.roles[index] || options.image === null)
            throw new Error("video safety input unavailable");
          bytes = await options.readFrame(frame.artifactRef, frame.sha256);
          if (
            bytes.byteLength > VIDEO_POSTER_POLICY_V1.maxBytesPerFrame ||
            (await mediaSha256Bytes(bytes)) !== frame.sha256
          )
            throw new Error("video safety digest mismatch");
        } catch {
          unavailable = true;
          unavailableFrames.push(claimInput);
          inputs.push({ role: frame.role, sha256: frame.sha256, outcome: "unavailable" });
          continue;
        }
        const claim = await options.evidence.claimFrame(claimInput);
        if (claim.status === "unresolved") {
          throw new VideoSafetyModerationUnresolvedError(claimInput.requestId);
        }
        if (claim.status === "succeeded") {
          result = claim.result;
        } else {
          try {
            result = validateVideoSafetyFrameProviderResult(
              await Effect.runPromise(
                options.image.evaluateImage({
                  bytes,
                  mediaType: "image/jpeg",
                  sha256: frame.sha256,
                }),
              ),
              frame.sha256,
            );
            result = await options.evidence.succeedFrame(claimInput, claim.claimToken, result);
          } catch (cause) {
            throw new VideoSafetyModerationUnresolvedError(claimInput.requestId, { cause });
          }
        }
      }
      const resolution = resolve(result.matched_categories);
      if (
        resolution.effective_policy_decision === "block" ||
        result.matched_categories.includes("sexual/minors")
      )
        mediaSafety = "blocked";
      inputs.push({
        role: frame.role,
        sha256: frame.sha256,
        outcome: "evaluated",
        provider: result,
        resolution,
      });
    }
    if (caption !== null) {
      try {
        if (
          options.text === null ||
          (await canonicalVideoCaptionSha256(caption)) !== input.captionSha256
        )
          throw new Error("video caption unavailable");
        const textInput = {
          version: "text-moderation-input-v1" as const,
          surface: "text_post" as const,
          community_id: input.communityId,
          title: caption,
          body: null,
        };
        const canonical = canonicalTextModerationInput(textInput);
        if (canonical.kind !== "accepted") throw new Error("video caption invalid");
        const result = await Effect.runPromise(options.text.evaluate(textInput));
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 12_288)
          throw new Error("video caption evidence exceeds bound");
        if (result.input_sha256 !== canonical.sha256)
          throw new Error("video caption input mismatch");
        const resolution = resolve(result.matched_categories);
        captionSafety =
          result.matched_categories.includes("sexual/minors") ||
          resolution.effective_policy_decision === "block"
            ? "blocked"
            : resolution.effective_policy_decision === "permit"
              ? "allow"
              : "review_required";
        inputs.push({
          role: "caption",
          sha256: input.captionSha256,
          outcome: "evaluated",
          provider: result,
          resolution,
        });
      } catch {
        unavailable = true;
        inputs.push({ role: "caption", sha256: input.captionSha256, outcome: "unavailable" });
      }
    }
    const evidenceDigest = await mediaSha256Bytes(
      new TextEncoder().encode(
        JSON.stringify([
          "video-safety-evidence-v2",
          MODERATION_RATING_RULE_V2,
          requestId,
          inputDigest,
          policy,
          inputs,
        ]),
      ),
    );
    const fact: VideoSafetyFact = {
      requestId,
      evidenceRef: `evidence_${evidenceDigest}`,
      minorSafetyEvidenceRef: null,
      mediaSafety,
      captionSafety,
      automatedRating,
      policyRevision:
        policy === null
          ? "safety-policy-unavailable"
          : `video-safety-policy-${await mediaSha256Bytes(
              new TextEncoder().encode(
                JSON.stringify([
                  MODERATION_RATING_RULE_V2,
                  policy.policy_revision,
                  policy.policy_hash,
                  policy.platform_policy_revision,
                  policy.platform_policy_hash,
                  policy.community_policy_revision,
                  policy.community_policy_hash,
                ]),
              ),
            )}`,
      adapterRevision: unavailable ? "safety-unavailable" : "video-openai-safety-v2",
    };
    // Database failures propagate as infrastructure failures; they never fabricate accepted evidence.
    return options.evidence.save(
      input,
      {
        ratingRuleRevision: MODERATION_RATING_RULE_V2,
        requestId,
        inputDigest,
        fact,
        platformHeld,
        policy,
        inputs,
      },
      unavailableFrames,
    );
  };
}
