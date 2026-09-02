import type {
  StudyLanguageProfileOutcome,
  StudyTranslationGenerationOutcome,
} from "@pirate/application/use-cases/rewards/study-generation";
import type { StudyLearnerBandV2 } from "@pirate/contracts";
import type { CloudflareWorkflowStepDo } from "@pirate/platform-cf/cloudflare-orchestration-primitives";

export type StudyGenerationWorkflowPayload = Readonly<{
  communityId: string;
  postId: string;
  lyricsRevision: number;
  sourceHash: string;
  targetLanguage: string;
  learnerBand: StudyLearnerBandV2;
  generatorPolicyRevision: "study_translation_generation_v1";
  promptRevision: "song_study_translation_prompt_v2" | "song_study_translation_prompt_v3";
  qualityPolicyRevision: string;
}>;

export type StudyGenerationWorkflowResult = Readonly<{
  profile: StudyLanguageProfileOutcome;
  translation: StudyTranslationGenerationOutcome;
}>;

type StudyGenerationWorkflowStepOptions = Readonly<{
  retries: Readonly<{ limit: number; delay: string; backoff: "exponential" }>;
  timeout: string;
}>;

export interface StudyGenerationWorkflowStep
  extends CloudflareWorkflowStepDo<StudyGenerationWorkflowStepOptions> {}

export type StudyGenerationWorkflowComposition = Readonly<{
  generateProfile: (input: {
    readonly communityId: string;
    readonly postId: string;
  }) => Promise<StudyLanguageProfileOutcome>;
  generateTranslation: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly targetLanguage: string;
    readonly learnerBand: StudyLearnerBandV2;
    readonly generatorPolicyRevision: StudyGenerationWorkflowPayload["generatorPolicyRevision"];
    readonly promptRevision: StudyGenerationWorkflowPayload["promptRevision"];
    readonly qualityPolicyRevision: string;
  }) => Promise<StudyTranslationGenerationOutcome>;
}>;

const profileOptions = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

const translationOptions = {
  retries: { limit: 2, delay: "7 minutes", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

export const makeStudyGenerationWorkflowRunner =
  <Env>(resolve: (env: Env) => StudyGenerationWorkflowComposition) =>
  async (
    env: Env,
    event: Readonly<{ payload: StudyGenerationWorkflowPayload; instanceId: string }>,
    step: StudyGenerationWorkflowStep,
  ): Promise<StudyGenerationWorkflowResult> => {
    const composition = resolve(env);
    const identity = event.payload;
    const profile = await step.do("study-language-profile-v1", profileOptions, () =>
      composition.generateProfile({
        communityId: identity.communityId,
        postId: identity.postId,
      }),
    );
    if (
      profile.lyricsRevision !== identity.lyricsRevision ||
      profile.sourceHash !== identity.sourceHash
    ) {
      throw new Error("Study generation authority became stale");
    }
    const translation = await step.do("study-translation-choice-v3", translationOptions, () =>
      composition.generateTranslation({
        communityId: identity.communityId,
        postId: identity.postId,
        targetLanguage: identity.targetLanguage,
        learnerBand: identity.learnerBand,
        generatorPolicyRevision: identity.generatorPolicyRevision,
        promptRevision: identity.promptRevision,
        qualityPolicyRevision: identity.qualityPolicyRevision,
      }),
    );
    return { profile, translation };
  };
