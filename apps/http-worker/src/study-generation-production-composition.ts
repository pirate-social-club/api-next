import {
  acceptedQualityPolicyStudyTranslationReviewer,
  Clock,
  IdGen,
  makeStudyLanguageProfileAnalyzer,
  makeStudyLanguageProfileService,
  makeStudyTranslationGenerationService,
  makeStudyTranslationGenerator,
} from "@pirate/application/use-cases/rewards/study-generation";
import {
  type HyperdriveConnection,
  makeHyperdriveControlPlaneLayer,
} from "@pirate/platform-cf/postgres";
import { makeControlPlaneStudyLanguageProfileStore } from "@pirate/platform-cf/study-language-profile-repository";
import {
  makeOpenRouterStudyLanguageProfileTransport,
  makeOpenRouterStudyTranslationTransport,
} from "@pirate/platform-cf/study-openrouter-generation";
import { makeControlPlaneStudyTranslationStore } from "@pirate/platform-cf/study-translation-repository";
import { Effect } from "effect";

export type StudyGenerationRuntimeEnv = Readonly<{
  CONTROL_PLANE?: HyperdriveConnection;
  STUDY_GENERATION_ENABLED?: string;
  STUDY_GENERATION_OPENROUTER_MODEL?: string;
  OPENROUTER_API_KEY?: string;
}>;

const exactText = (value: string | undefined): string | null =>
  value !== undefined && value.length > 0 && value === value.trim() ? value : null;

export const makeStudyGenerationWorkflowComposition = (env: StudyGenerationRuntimeEnv) => {
  if (env.STUDY_GENERATION_ENABLED !== "true") {
    throw new Error("Study generation is disabled");
  }
  if (env.CONTROL_PLANE === undefined) {
    throw new Error("Study generation control plane is unavailable");
  }
  const apiKey = exactText(env.OPENROUTER_API_KEY);
  const model = exactText(env.STUDY_GENERATION_OPENROUTER_MODEL);
  if (apiKey === null || model === null) {
    throw new Error("Study generation provider authority is unavailable");
  }
  const provider = {
    enabled: true,
    apiKey,
    model,
    providerPolicy: {
      requireParameters: true,
      dataCollection: "deny",
      zdr: true,
      allowFallbacks: false,
      order: ["google-vertex"],
      only: ["google-vertex"],
    },
    accountPluginsDisabled: true,
  } as const;
  const runtime = makeHyperdriveControlPlaneLayer(env.CONTROL_PLANE);
  const clock = { now: Effect.sync(() => Date.now()) };
  const ids = { next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")) };
  const profile = makeStudyLanguageProfileService(
    makeControlPlaneStudyLanguageProfileStore(runtime),
    makeStudyLanguageProfileAnalyzer(makeOpenRouterStudyLanguageProfileTransport(provider)),
  );
  const translation = makeStudyTranslationGenerationService(
    makeControlPlaneStudyTranslationStore(runtime),
    makeStudyTranslationGenerator(
      makeOpenRouterStudyTranslationTransport(provider),
      acceptedQualityPolicyStudyTranslationReviewer,
    ),
  );
  return {
    generateProfile: (input: { readonly communityId: string; readonly postId: string }) =>
      Effect.runPromise(profile.generate(input).pipe(Effect.provideService(Clock, clock))),
    generateTranslation: (input: {
      readonly communityId: string;
      readonly postId: string;
      readonly targetLanguage: string;
      readonly learnerBand: "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
    }) =>
      Effect.runPromise(
        translation
          .generate(input)
          .pipe(Effect.provideService(Clock, clock), Effect.provideService(IdGen, ids)),
      ),
  };
};
