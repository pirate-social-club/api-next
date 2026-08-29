import { describe, expect, test } from "bun:test";
import type { StudySessionItemV2 } from "@pirate/contracts";
import { Effect } from "effect";
import {
  deriveStudyProgressV2,
  resolveTranscriptEvidenceV2,
  StudyV2InfrastructureFailed,
  selectProductionStudyItemsV2,
  validateStudySubmissionKindV2,
} from "./study-v2-lifecycle.ts";

const item = (ordinal: number): StudySessionItemV2 => ({
  object: "study_session_item_v2",
  session_item_id: `item-${ordinal}`,
  ordinal,
  exercise_review_key: `review-${ordinal}`,
  exercise_version_id: `version-${ordinal}`,
  exercise_type: "typed_cloze",
  exercise_variant: "vocabulary-v1",
  line: {
    post_id: "post-1",
    audio_revision: 1,
    lyrics_revision: 1,
    lyric_line_id: `line-${ordinal}`,
    line_version: 1,
    line_source_hash: `hash-${ordinal}`,
  },
  languages: { learning_language: "en", helper_language: null },
  learner_band: "A2",
  presentation: {
    kind: "typed_cloze",
    segments: [
      { kind: "text", text: "Hold " },
      { kind: "blank", blank_id: "blank-1" },
    ],
    accessible_text: "Hold blank",
    capture: "keyboard_text",
  },
  answer_visibility: "secret_until_spent",
  feedback_release: "spent_only",
  grader_policy_revision: "grader-v1",
  feedback_policy_revision: "feedback-v1",
  quality_policy_revision: "quality-v1",
  maximum_attempts: 2,
});

describe("Study v2 presentation lifecycle", () => {
  test("rejects the wrong submission kind before an attempt can be accepted", async () => {
    await expect(
      Effect.runPromise(
        validateStudySubmissionKindV2("say_it_back", {
          kind: "text_response",
          text: "client transcript",
        }),
      ),
    ).rejects.toMatchObject({ reason: "submission-kind-mismatch" });
  });

  test("requires transcript evidence owned by the account and session item", async () => {
    const store = {
      load: () =>
        Effect.succeed({
          accountId: "other-account",
          evidenceId: "evidence-1",
          expiresAt: 2_000,
          sessionItemId: "item-1",
          transcript: "Hold on",
        }),
    };
    await expect(
      Effect.runPromise(
        resolveTranscriptEvidenceV2(
          { accountId: "account-1", evidenceId: "evidence-1", now: 1_000, sessionItemId: "item-1" },
          store,
        ),
      ),
    ).rejects.toMatchObject({ reason: "transcript-evidence-mismatch" });
  });

  test("keeps evidence transport failures out of learning outcomes", async () => {
    const failure = new StudyV2InfrastructureFailed({ operation: "transcript-evidence-load" });
    await expect(
      Effect.runPromise(
        resolveTranscriptEvidenceV2(
          { accountId: "account-1", evidenceId: "evidence-1", now: 1_000, sessionItemId: "item-1" },
          { load: () => Effect.fail(failure) },
        ),
      ),
    ).rejects.toBe(failure);
  });

  test("requires four unique review items for a production session", async () => {
    await expect(
      Effect.runPromise(selectProductionStudyItemsV2([item(0), item(1), item(2)])),
    ).rejects.toMatchObject({ reason: "insufficient-exercises" });
    await expect(
      Effect.runPromise(selectProductionStudyItemsV2([item(0), item(1), item(2), item(3)])),
    ).resolves.toHaveLength(4);
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
    expect(
      deriveStudyProgressV2(["correct", "correct", "incorrect", "incorrect"], 4).qualified,
    ).toBe(false);
  });
});
