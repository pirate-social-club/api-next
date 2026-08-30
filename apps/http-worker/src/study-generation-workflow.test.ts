import { describe, expect, test } from "bun:test";
import {
  makeStudyGenerationWorkflowRunner,
  type StudyGenerationWorkflowStep,
} from "./study-generation-workflow.ts";

describe("Study generation Workflow", () => {
  test("persists the profile before generating the exact translation pack", async () => {
    const calls: string[] = [];
    const runner = makeStudyGenerationWorkflowRunner(() => ({
      generateProfile: async () => {
        calls.push("profile");
        return {
          communityId: "community-1",
          postId: "post-1",
          lyricsRevision: 2,
          sourceHash: "a".repeat(64),
          languageProfileRevision: 1,
          state: "ready",
        };
      },
      generateTranslation: async () => {
        calls.push("translation");
        return {
          generationRunId: "run-1",
          status: "succeeded",
          readyCount: 4,
          notApplicableCount: 0,
          skippedCount: 0,
        };
      },
    }));
    const step: StudyGenerationWorkflowStep = {
      do: async (_name, _options, callback) => callback(),
    };
    const result = await runner(
      {},
      {
        instanceId: "workflow-1",
        payload: {
          communityId: "community-1",
          postId: "post-1",
          lyricsRevision: 2,
          sourceHash: "a".repeat(64),
          targetLanguage: "es",
          learnerBand: "B1",
          generatorPolicyRevision: "study_translation_generation_v1",
          promptRevision: "song_study_translation_prompt_v2",
          qualityPolicyRevision: "study-translation-quality-es-v1",
        },
      },
      step,
    );
    expect(calls).toEqual(["profile", "translation"]);
    expect(result.translation.status).toBe("succeeded");
  });

  test("does not generate translations after lyrics authority changes", async () => {
    let translated = false;
    const runner = makeStudyGenerationWorkflowRunner(() => ({
      generateProfile: async () => ({
        communityId: "community-1",
        postId: "post-1",
        lyricsRevision: 3,
        sourceHash: "b".repeat(64),
        languageProfileRevision: 1,
        state: "ready",
      }),
      generateTranslation: async () => {
        translated = true;
        throw new Error("must not run");
      },
    }));
    await expect(
      runner(
        {},
        {
          instanceId: "workflow-1",
          payload: {
            communityId: "community-1",
            postId: "post-1",
            lyricsRevision: 2,
            sourceHash: "a".repeat(64),
            targetLanguage: "es",
            learnerBand: "B1",
            generatorPolicyRevision: "study_translation_generation_v1",
            promptRevision: "song_study_translation_prompt_v2",
            qualityPolicyRevision: "study-translation-quality-es-v1",
          },
        },
        { do: async (_name, _options, callback) => callback() },
      ),
    ).rejects.toThrow("authority became stale");
    expect(translated).toBe(false);
  });

  test("schedules translation retries after the six-minute database lease", async () => {
    const options: Array<Readonly<{ retries: { delay: string }; timeout: string }>> = [];
    const runner = makeStudyGenerationWorkflowRunner(() => ({
      generateProfile: async () => ({
        communityId: "community-1",
        postId: "post-1",
        lyricsRevision: 2,
        sourceHash: "a".repeat(64),
        languageProfileRevision: 1,
        state: "ready",
      }),
      generateTranslation: async () => ({
        generationRunId: "run-1",
        status: "succeeded",
        readyCount: 1,
        notApplicableCount: 0,
        skippedCount: 0,
      }),
    }));
    await runner(
      {},
      {
        instanceId: "workflow-1",
        payload: {
          communityId: "community-1",
          postId: "post-1",
          lyricsRevision: 2,
          sourceHash: "a".repeat(64),
          targetLanguage: "es",
          learnerBand: "B1",
          generatorPolicyRevision: "study_translation_generation_v1",
          promptRevision: "song_study_translation_prompt_v2",
          qualityPolicyRevision: "study-translation-quality-es-v1",
        },
      },
      {
        do: async (_name, selected, callback) => {
          options.push(selected);
          return callback();
        },
      },
    );
    expect(options[1]).toMatchObject({ retries: { delay: "7 minutes" }, timeout: "5 minutes" });
  });
});
