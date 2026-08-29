import { describe, expect, test } from "bun:test";
import { makeStudyGenerationWorkflowComposition } from "./study-generation-production-composition.ts";

describe("production Study generation composition", () => {
  test("is disabled without exact feature and provider authority", () => {
    for (const env of [
      {},
      { STUDY_GENERATION_ENABLED: "false" },
      {
        STUDY_GENERATION_ENABLED: "true",
        CONTROL_PLANE: { connectionString: "postgres://unused" },
      },
      {
        STUDY_GENERATION_ENABLED: "true",
        CONTROL_PLANE: { connectionString: "postgres://unused" },
        OPENROUTER_API_KEY: " padded ",
        STUDY_GENERATION_OPENROUTER_MODEL: "google/gemini-test",
      },
    ]) {
      expect(() => makeStudyGenerationWorkflowComposition(env)).toThrow();
    }
  });

  test("constructs services without calling the provider or database", () => {
    const composition = makeStudyGenerationWorkflowComposition({
      STUDY_GENERATION_ENABLED: "true",
      CONTROL_PLANE: { connectionString: "postgres://unused" },
      OPENROUTER_API_KEY: "secret",
      STUDY_GENERATION_OPENROUTER_MODEL: "google/gemini-test",
    });
    expect(composition.generateProfile).toBeFunction();
    expect(composition.generateTranslation).toBeFunction();
  });
});
