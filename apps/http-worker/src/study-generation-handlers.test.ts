import { describe, expect, test } from "bun:test";
import { ProviderUnavailable } from "@pirate/contracts";
import { makeStudyGenerationHandlers } from "./study-generation-handlers.ts";
import type { StudyGenerationWorkflowPayload } from "./study-generation-workflow.ts";

type PolicyRevisions = Pick<
  StudyGenerationWorkflowPayload,
  "generatorPolicyRevision" | "promptRevision" | "qualityPolicyRevision"
>;

const policy = (
  generatorPolicyRevision = "study_translation_generation_v1",
  promptRevision = "song_study_translation_prompt_v2",
  qualityPolicyRevision = "study-translation-quality-es-v1",
): PolicyRevisions =>
  ({ generatorPolicyRevision, promptRevision, qualityPolicyRevision }) as PolicyRevisions;

const request = {
  body: { target_language: "es", learner_band: "B1" },
  headers: {},
  params: { communityId: "community-1", postId: "post-1" },
  query: {},
  principal: { kind: "user", subject: "account-1" },
} as const;

describe("Study generation handlers", () => {
  test("launches one source-bound Workflow and returns truthful processing", async () => {
    let launched:
      | Readonly<{ instanceId: string; payload: Readonly<Record<string, unknown>> }>
      | undefined;
    const handlers = makeStudyGenerationHandlers({
      resolveProfile: async () => ({
        state: "generate",
        request: {
          communityId: "community-1",
          postId: "post-1",
          lyricsRevision: 3,
          sourceHash: "a".repeat(64),
          primaryLanguageHint: "en",
          secondaryLanguageHint: null,
          contextLines: [
            {
              ordinal: 0,
              lyricLineId: "line-1",
              lineVersion: 1,
              studyUnitId: "unit-1",
              sourceText: "We go",
            },
          ],
          units: [{ studyUnitId: "unit-1", sourceText: "We go" }],
        },
      }),
      launch: async (workflowId, payload) => {
        launched = { instanceId: workflowId, payload };
        return "created";
      },
      resolveTranslationPolicy: async () => policy(),
    });
    const result = await handlers.RequestStudyGenerationV2(request);
    expect(result).toMatchObject({
      status: 202,
      body: {
        state: "processing",
        target_language: "es",
        learner_band: "B1",
        available_exercise_types: ["say_it_back"],
        pending_exercise_types: ["translation_choice"],
      },
    });
    expect(launched?.instanceId).toMatch(/^study-generation-[0-9a-f]{64}$/u);
    expect(launched?.payload).toMatchObject({
      lyricsRevision: 3,
      sourceHash: "a".repeat(64),
      targetLanguage: "es",
      learnerBand: "B1",
      generatorPolicyRevision: "study_translation_generation_v1",
      promptRevision: "song_study_translation_prompt_v2",
      qualityPolicyRevision: "study-translation-quality-es-v1",
    });
  });

  test("maps Workflow launch failures without leaking provider details", async () => {
    const handlers = makeStudyGenerationHandlers({
      resolveProfile: async () => ({
        state: "ready",
        outcome: {
          communityId: "community-1",
          postId: "post-1",
          lyricsRevision: 3,
          sourceHash: "a".repeat(64),
          languageProfileRevision: 1,
          state: "ready",
        },
      }),
      launch: async () => {
        throw new Error("secret provider detail");
      },
      resolveTranslationPolicy: async () => policy(),
    });
    await expect(handlers.RequestStudyGenerationV2(request)).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
  });

  test("changes Workflow identity when any generation policy revision changes", async () => {
    const ids: string[] = [];
    const make = (revisions: PolicyRevisions) =>
      makeStudyGenerationHandlers({
        resolveProfile: async () => ({
          state: "ready",
          outcome: {
            communityId: "community-1",
            postId: "post-1",
            lyricsRevision: 3,
            sourceHash: "a".repeat(64),
            languageProfileRevision: 1,
            state: "ready",
          },
        }),
        resolveTranslationPolicy: async () => revisions,
        launch: async (workflowId) => {
          ids.push(workflowId);
          return "created";
        },
      });
    await make(policy()).RequestStudyGenerationV2(request);
    await make(policy("study_translation_generation_v2")).RequestStudyGenerationV2(request);
    await make(
      policy("study_translation_generation_v1", "song_study_translation_prompt_v3"),
    ).RequestStudyGenerationV2(request);
    await make(
      policy(
        "study_translation_generation_v1",
        "song_study_translation_prompt_v2",
        "study-translation-quality-es-v2",
      ),
    ).RequestStudyGenerationV2(request);
    expect(new Set(ids).size).toBe(4);
  });
});
