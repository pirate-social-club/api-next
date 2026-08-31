import { createHash } from "node:crypto";
import type {
  StudyLanguageProfileResolution,
  StudyLanguageProfileStoreFailed,
} from "@pirate/application/use-cases/rewards/study-generation";
import { AuthError, InternalError, NotFound, ProviderUnavailable } from "@pirate/contracts";
import type { StudyGenerationWorkflowPayload } from "./study-generation-workflow.ts";
import { type EndpointHandler, type Principal, withEndpointResult } from "./transport.ts";

type StudyGenerationPolicyRevisions = Pick<
  StudyGenerationWorkflowPayload,
  "generatorPolicyRevision" | "promptRevision" | "qualityPolicyRevision"
>;

const accountId = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const instanceId = (payload: StudyGenerationWorkflowPayload): string =>
  `study-generation-${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;

const wireStoreFailure = (failure: StudyLanguageProfileStoreFailed): Error =>
  failure.reason === "unavailable" || failure.reason === "stale"
    ? new NotFound({ message: "Study source is unavailable" })
    : new InternalError({ message: "Study generation planning failed" });

export const makeStudyGenerationHandlers = (services: {
  readonly resolveProfile: (input: {
    readonly communityId: string;
    readonly postId: string;
  }) => Promise<StudyLanguageProfileResolution>;
  readonly launch: (
    instanceId: string,
    payload: StudyGenerationWorkflowPayload,
  ) => Promise<"created" | "already_exists" | "restarted" | "resumed">;
  readonly resolveTranslationPolicy: (input: {
    readonly targetLanguage: string;
  }) => Promise<StudyGenerationPolicyRevisions>;
}): Readonly<{ RequestStudyGenerationV2: EndpointHandler }> => ({
  RequestStudyGenerationV2: async (request) => {
    accountId(request.principal);
    const path = request.params as { communityId: string; postId: string };
    const body = request.body as {
      target_language: string;
      learner_band: "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
    };
    let resolution: StudyLanguageProfileResolution;
    try {
      resolution = await services.resolveProfile({
        communityId: path.communityId,
        postId: path.postId,
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "_tag" in error) {
        throw wireStoreFailure(error as StudyLanguageProfileStoreFailed);
      }
      throw new InternalError({ message: "Study generation planning failed" });
    }
    const authority = resolution.state === "ready" ? resolution.outcome : resolution.request;
    let generationPolicy: StudyGenerationPolicyRevisions;
    try {
      generationPolicy = await services.resolveTranslationPolicy({
        targetLanguage: body.target_language,
      });
    } catch {
      throw new ProviderUnavailable({ message: "Study generation policy is unavailable" });
    }
    const payload: StudyGenerationWorkflowPayload = {
      communityId: path.communityId,
      postId: path.postId,
      lyricsRevision: authority.lyricsRevision,
      sourceHash: authority.sourceHash,
      targetLanguage: body.target_language,
      learnerBand: body.learner_band,
      ...generationPolicy,
    };
    try {
      await services.launch(instanceId(payload), payload);
    } catch {
      throw new ProviderUnavailable({ message: "Study generation is unavailable" });
    }
    return withEndpointResult(
      {
        state: "processing",
        target_language: body.target_language,
        learner_band: body.learner_band,
        available_exercise_types: ["say_it_back"],
        pending_exercise_types: ["translation_choice"],
      },
      202,
    );
  },
});
