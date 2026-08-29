import type {
  StudyLanguageProfileOutcome,
  StudyTranslationGenerationOutcome,
} from "@pirate/application/use-cases/rewards/study-generation";
import type { StudyLearnerBandV2 } from "@pirate/contracts";

export type StudyGenerationWorkflowPayload = Readonly<{
  communityId: string;
  postId: string;
  lyricsRevision: number;
  sourceHash: string;
  targetLanguage: string;
  learnerBand: StudyLearnerBandV2;
}>;

export type StudyGenerationWorkflowResult = Readonly<{
  profile: StudyLanguageProfileOutcome;
  translation: StudyTranslationGenerationOutcome;
}>;

export interface StudyGenerationWorkflowStep {
  readonly do: <T>(
    name: string,
    options: Readonly<{
      retries: Readonly<{ limit: number; delay: string; backoff: "exponential" }>;
      timeout: string;
    }>,
    callback: () => Promise<T>,
  ) => Promise<T>;
}

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
  }) => Promise<StudyTranslationGenerationOutcome>;
}>;

const options = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
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
    const profile = await step.do("study-language-profile-v1", options, () =>
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
    const translation = await step.do("study-translation-choice-v1", options, () =>
      composition.generateTranslation({
        communityId: identity.communityId,
        postId: identity.postId,
        targetLanguage: identity.targetLanguage,
        learnerBand: identity.learnerBand,
      }),
    );
    return { profile, translation };
  };
