import { canonicalTextModerationInput, resolveCommunityModerationPolicy } from "@pirate/domain";
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
export type VideoSafetyEvidence = Readonly<{
  requestId: string;
  inputDigest: string;
  fact: VideoSafetyFact;
  platformHeld: boolean;
  policy: TextModerationPolicySnapshotV2 | null;
  inputs: readonly unknown[];
}>;
export type VideoSafetyEvidenceStore = Readonly<{
  load: (input: VideoSafetyInput, inputDigest: string) => Promise<VideoSafetyFact | null>;
  save: (input: VideoSafetyInput, evidence: VideoSafetyEvidence) => Promise<VideoSafetyFact>;
}>;

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
    let mediaSafety: VideoSafetyFact["mediaSafety"] = "review_required";
    let captionSafety: VideoSafetyFact["captionSafety"] =
      caption === null ? "not_applicable" : "review_required";
    const resolve = (categories: readonly string[]) => {
      // A known hard-floor signal cannot be weakened by an unavailable community policy.
      if (categories.includes("sexual/minors")) platformHeld = true;
      const result = resolveCommunityModerationPolicy({
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
      try {
        if (frame.role !== VIDEO_POSTER_POLICY_V1.roles[index] || options.image === null)
          throw new Error("video safety input unavailable");
        const bytes = await options.readFrame(frame.artifactRef, frame.sha256);
        if (
          bytes.byteLength > VIDEO_POSTER_POLICY_V1.maxBytesPerFrame ||
          (await mediaSha256Bytes(bytes)) !== frame.sha256
        )
          throw new Error("video safety digest mismatch");
        const result = await Effect.runPromise(
          options.image.evaluateImage({ bytes, mediaType: "image/jpeg", sha256: frame.sha256 }),
        );
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 12_288)
          throw new Error("video safety evidence exceeds bound");
        if (result.input_sha256 !== frame.sha256) throw new Error("video safety input mismatch");
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
      } catch {
        unavailable = true;
        inputs.push({ role: frame.role, sha256: frame.sha256, outcome: "unavailable" });
      }
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
        JSON.stringify(["video-safety-evidence-v1", requestId, inputDigest, policy, inputs]),
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
                  policy.policy_revision,
                  policy.policy_hash,
                  policy.platform_policy_revision,
                  policy.platform_policy_hash,
                  policy.community_policy_revision,
                  policy.community_policy_hash,
                ]),
              ),
            )}`,
      adapterRevision: unavailable ? "safety-unavailable" : "video-openai-safety-v1",
    };
    // Database failures propagate as infrastructure failures; they never fabricate accepted evidence.
    return options.evidence.save(input, {
      requestId,
      inputDigest,
      fact,
      platformHeld,
      policy,
      inputs,
    });
  };
}
