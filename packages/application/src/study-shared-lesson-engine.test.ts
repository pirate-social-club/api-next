import { expect, test } from "bun:test";
import {
  deriveStudyPresentationTransition,
  evaluateStudyChoice,
  evaluateStudySpokenAttempt,
  gradeStudySpokenTranscript,
  projectStudyProgressFacts,
  projectStudySpokenFeedback,
} from "./study-shared-lesson-engine.ts";

const review = { difficulty: 5, lapses: 0, repetitions: 0, stability: 1, reviewedAt: 0 };
const choice = (attemptNumber: number, submittedChoiceKey: string) =>
  evaluateStudyChoice({
    attemptNumber,
    submittedChoiceKey,
    correctChoiceKey: "answer-a",
    correctText: "Private answer",
    explanation: "Private explanation",
    maximumAttempts: 3,
    review,
  });

test("choice feedback stays private during an immediate wrong retry and releases only when spent", () => {
  const first = choice(1, "Answer-A");
  expect(first).toMatchObject({
    correct: false,
    spent: false,
    resolved: false,
    firstPass: true,
    attemptState: "retryable",
    feedback: { kind: "none" },
  });
  expect(first.feedback).not.toHaveProperty("correct_choice_key");
  expect(first.feedback).not.toHaveProperty("explanation");
  expect(choice(2, "answer-a")).toMatchObject({
    correct: true,
    spent: true,
    firstPass: false,
    attemptState: "spent",
    feedback: { kind: "choice_reveal", correct_choice_key: "answer-a" },
  });
  expect(choice(3, "wrong")).toMatchObject({
    correct: false,
    spent: true,
    resolved: true,
    attemptState: "spent",
    feedback: { kind: "choice_reveal", correct_text: "Private answer" },
  });
});

test("retryable choice remains uncounted in answered progress despite a graded first attempt", () => {
  expect(
    projectStudyProgressFacts({ totalCards: 4, answeredSpentCards: 0, firstPassCorrectCards: 0 }),
  ).toEqual({
    qualifying_exercise_count: 4,
    answered_exercise_count: 0,
    first_pass_correct: 0,
    required_correct: 3,
    score_bps: null,
  });
  expect(
    projectStudyProgressFacts({ totalCards: 4, answeredSpentCards: 3, firstPassCorrectCards: 2 })
      .score_bps,
  ).toBeNull();
  expect(
    projectStudyProgressFacts({ totalCards: 4, answeredSpentCards: 4, firstPassCorrectCards: 2 })
      .score_bps,
  ).toBe(5000);
});

test("presentation cap completes even a retryable choice; all resolved takes reason precedence", () => {
  expect(
    deriveStudyPresentationTransition({
      kind: "choice_retryable",
      priorPresentationCount: 1,
      totalCards: 4,
      remainingUnresolvedCards: 4,
    }),
  ).toEqual({ kind: "keep_current", nextPresentationCount: 2 });
  expect(
    deriveStudyPresentationTransition({
      kind: "choice_retryable",
      priorPresentationCount: 19,
      totalCards: 10,
      remainingUnresolvedCards: 5,
    }),
  ).toEqual({
    kind: "complete",
    nextPresentationCount: 20,
    completionReason: "presentation_budget",
  });
  expect(
    deriveStudyPresentationTransition({
      kind: "advance",
      priorPresentationCount: 19,
      totalCards: 10,
      remainingUnresolvedCards: 0,
    }),
  ).toEqual({ kind: "complete", nextPresentationCount: 20, completionReason: "all_resolved" });
});

test("accepted ungraded rerecord spends no review/presentation; a previous receipt forces a normal spent grade", () => {
  const transcript = gradeStudySpokenTranscript({
    referenceText: "I can love you",
    transcript: "I can let love you",
    dominantLanguage: null,
    policy: "script_aware_token_phonetic_v2",
    languageProvenance: { kind: "no_authoritative_evidence" },
    detectedLanguage: "en",
    detectedLanguageConfidence: 0.99,
  });
  expect(transcript.rerecordAssessment.candidateReason).toBe("single_insertion");
  const input = { ...transcript, attemptNumber: 1, rerecordEnabled: true, review };
  expect(evaluateStudySpokenAttempt({ ...input, priorRerecordRecorded: false })).toMatchObject({
    kind: "ungraded_rerecord",
    outcome: "ungraded_rerecord",
    attemptState: "retryable",
    firstPass: true,
    review: null,
  });
  expect(
    deriveStudyPresentationTransition({
      kind: "ungraded_rerecord",
      priorPresentationCount: 19,
      totalCards: 10,
      remainingUnresolvedCards: 5,
    }),
  ).toEqual({ kind: "unchanged", nextPresentationCount: 19 });
  const second = evaluateStudySpokenAttempt({ ...input, priorRerecordRecorded: true });
  expect(second).toMatchObject({
    kind: "graded",
    outcome: "incorrect",
    attemptState: "spent",
    firstPass: true,
    resolved: false,
  });
  expect(second.review).not.toBeNull();
  expect(
    deriveStudyPresentationTransition({
      kind: "advance",
      priorPresentationCount: 0,
      totalCards: 4,
      remainingUnresolvedCards: 4,
    }),
  ).toEqual({ kind: "advance", nextPresentationCount: 1 });
});

test("spoken transcript feedback keeps public token objects and private positional diff distinct", () => {
  const { grade } = gradeStudySpokenTranscript({
    referenceText: "I can love you",
    transcript: "I can let love you",
    dominantLanguage: null,
    policy: "script_aware_token_phonetic_v2",
    languageProvenance: { kind: "no_authoritative_evidence" },
    detectedLanguage: null,
    detectedLanguageConfidence: null,
  });
  const { feedback, tokenDiff } = projectStudySpokenFeedback(grade);
  expect(feedback).toMatchObject({
    kind: "transcript_diff",
    heard_transcript: "I can let love you",
    policy_revision: "script_aware_token_phonetic_v2",
    extra: ["let"],
  });
  expect(feedback.matched[0]).toHaveProperty("token");
  expect(tokenDiff.matched.every((position) => Number.isInteger(position))).toBe(true);
  expect(tokenDiff).not.toHaveProperty("heard_transcript");
});
