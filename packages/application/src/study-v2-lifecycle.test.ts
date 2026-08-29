import { describe, expect, test } from "bun:test";
import type { StudySessionItemV2 } from "@pirate/contracts";
import { Effect } from "effect";
import {
  deriveStudyProgressV2,
  selectProductionStudyItemsV2,
  validateStudySubmissionKindV2,
} from "./study-v2-lifecycle.ts";

const item = (ordinal: number): StudySessionItemV2 => ({
  object: "study_session_item_v2",
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "say_it_back",
  exercise_variant: "spoken-recall-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line-${ordinal}`,
    study_unit_id: `unit-${ordinal}`,
    line_version: 1,
    line_source_hash: `hash-${ordinal}`,
  },
  languages: { learning_language: "en", target_language: null },
  learner_band: null,
  language_profile_revision: null,
  presentation: {
    kind: "say_it_back",
    reference_text: "Hold on",
    capture: "microphone_audio",
  },
  answer_visibility: "always_visible",
  feedback_release: "every_graded_attempt",
  grader_policy_revision: "grader-v1",
  feedback_policy_revision: "feedback-v1",
  quality_policy_revision: "quality-v1",
  maximum_attempts: 3,
});

describe("Study v2 presentation lifecycle", () => {
  test("keeps say-it-back outside the client-authored JSON answer union", async () => {
    await expect(
      Effect.runPromise(
        validateStudySubmissionKindV2("say_it_back", {
          kind: "single_select",
          choice_key: "forged-transcript",
        }),
      ),
    ).rejects.toMatchObject({ reason: "submission-kind-mismatch" });
  });

  test("requires four through ten unique review items", async () => {
    await expect(
      Effect.runPromise(selectProductionStudyItemsV2([item(0), item(1), item(2)])),
    ).rejects.toMatchObject({ reason: "insufficient-exercises" });
    await expect(
      Effect.runPromise(selectProductionStudyItemsV2([item(0), item(1), item(2), item(3)])),
    ).resolves.toHaveLength(4);
    await expect(
      Effect.runPromise(
        selectProductionStudyItemsV2(Array.from({ length: 11 }, (_, i) => item(i))),
      ),
    ).rejects.toMatchObject({ reason: "insufficient-exercises" });
  });

  test("preserves spec 015 exact first-pass arithmetic", () => {
    expect(deriveStudyProgressV2(["correct", "correct", "incorrect", "correct"], 4)).toEqual({
      answeredExerciseCount: 4,
      firstPassCorrect: 3,
      qualifyingExerciseCount: 4,
      qualified: true,
      requiredCorrect: 3,
      scoreBps: 7_500,
    });
  });
});
