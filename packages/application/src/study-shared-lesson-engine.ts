// Shared pure lesson facts consumed by ordinary and guest source adapters.
// Inputs are captured validated lesson facts, never account/guest authority.
import type { StudySpokenLanguageProvenanceV2 } from "@pirate/contracts";
import {
  assessStudySpokenRerecord,
  gradeExactChoiceV2,
  gradeTranscriptV2,
  type StudyReviewScheduleInputV1,
  type StudySpokenRerecordAssessment,
  type StudyTranscriptGraderPolicyRevision,
  type StudyTranscriptGradeV2,
  scheduleStudyReviewV1,
  studyTranscriptReviewGrade,
} from "@pirate/domain";

export const studyPresentationCap = (totalCards: number) => Math.min(20, 3 * totalCards);

/** Matches actual readSession: answered is spent items, not graded first attempts. */
export const projectStudyProgressFacts = (
  input: Readonly<{
    totalCards: number;
    answeredSpentCards: number;
    firstPassCorrectCards: number;
  }>,
) => ({
  qualifying_exercise_count: input.totalCards,
  answered_exercise_count: input.answeredSpentCards,
  first_pass_correct: input.firstPassCorrectCards,
  required_correct: Math.max(1, Math.ceil((7 * input.totalCards) / 10)),
  score_bps:
    input.answeredSpentCards === input.totalCards
      ? Math.floor((10_000 * input.firstPassCorrectCards) / input.totalCards)
      : null,
});

export const evaluateStudyChoice = (
  input: Readonly<{
    submittedChoiceKey: string;
    correctChoiceKey: string;
    correctText: string;
    explanation: string | undefined;
    attemptNumber: number;
    maximumAttempts: number;
    review: StudyReviewScheduleInputV1;
  }>,
) => {
  const correct = gradeExactChoiceV2(input.submittedChoiceKey, input.correctChoiceKey);
  const spent = correct || input.attemptNumber >= input.maximumAttempts;
  const feedback = !spent
    ? { kind: "none" as const }
    : {
        kind: "choice_reveal" as const,
        correct_choice_key: input.correctChoiceKey,
        correct_text: input.correctText,
        ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
      };
  return {
    correct,
    spent,
    resolved: spent,
    firstPass: input.attemptNumber === 1,
    outcome: correct ? ("correct" as const) : ("incorrect" as const),
    attemptState: spent ? ("spent" as const) : ("retryable" as const),
    feedback,
    review: scheduleStudyReviewV1(
      input.review,
      correct ? (input.attemptNumber === 1 ? "good" : "hard") : "again",
    ),
  };
};

/** Original service's pure computation only; never invokes/archive/finalize. */
export const gradeStudySpokenTranscript = (
  input: Readonly<{
    referenceText: string;
    transcript: string;
    dominantLanguage: string | null;
    policy: StudyTranscriptGraderPolicyRevision;
    languageProvenance: StudySpokenLanguageProvenanceV2;
    detectedLanguage: string | null;
    detectedLanguageConfidence: number | null;
  }>,
) => {
  const grade = gradeTranscriptV2(
    input.referenceText,
    input.transcript,
    input.dominantLanguage,
    input.policy,
  );
  return {
    grade,
    rerecordAssessment: assessStudySpokenRerecord({
      grade,
      expectedLanguage:
        input.languageProvenance.kind === "unit_profile"
          ? input.languageProvenance.dominant_language
          : null,
      detectedLanguage: input.detectedLanguage,
      detectedLanguageConfidence: input.detectedLanguageConfidence,
    }),
  };
};

export const projectStudySpokenFeedback = (grade: StudyTranscriptGradeV2) => ({
  feedback: {
    kind: "transcript_diff" as const,
    match_kind: grade.matchKind,
    heard_transcript: grade.heardTranscript,
    matched: grade.matched,
    missing: grade.missing,
    extra: grade.extra,
    substituted: grade.substituted.map(({ expected, heard }) => ({ expected, heard })),
    policy_revision: grade.policyRevision,
  },
  tokenDiff: {
    match_kind: grade.matchKind,
    matched: grade.matched.map(({ position }) => position),
    missing: grade.missing.map(({ position }) => position),
    extra: grade.extra,
    substituted: grade.substituted.map(({ expected, heard }) => ({
      expected_position: expected.position,
      heard,
    })),
  },
});

/** priorRerecordRecorded comes from the existing locked SQL receipt query. */
export const evaluateStudySpokenAttempt = (
  input: Readonly<{
    grade: StudyTranscriptGradeV2;
    attemptNumber: number;
    rerecordEnabled: boolean;
    rerecordAssessment: StudySpokenRerecordAssessment;
    priorRerecordRecorded: boolean;
    review: StudyReviewScheduleInputV1;
  }>,
) => {
  const rerecord =
    input.rerecordEnabled &&
    !input.grade.correct &&
    input.rerecordAssessment.candidateReason !== null &&
    !input.priorRerecordRecorded;
  if (rerecord)
    return {
      kind: "ungraded_rerecord" as const,
      outcome: "ungraded_rerecord" as const,
      attemptState: "retryable" as const,
      firstPass: input.attemptNumber === 1,
      resolved: false,
      review: null,
    };
  return {
    kind: "graded" as const,
    outcome: input.grade.correct ? ("correct" as const) : ("incorrect" as const),
    attemptState: "spent" as const,
    firstPass: input.attemptNumber === 1,
    resolved: input.grade.correct || input.attemptNumber >= 3,
    review: scheduleStudyReviewV1(
      input.review,
      studyTranscriptReviewGrade(input.grade.matchKind, input.attemptNumber),
    ),
  };
};

/** Called after item-state mutation, using locked actual aggregate results. */
export const deriveStudyPresentationTransition = (
  input: Readonly<{
    kind: "ungraded_rerecord" | "choice_retryable" | "advance";
    priorPresentationCount: number;
    totalCards: number;
    remainingUnresolvedCards: number;
  }>,
) => {
  if (input.kind === "ungraded_rerecord")
    return {
      kind: "unchanged" as const,
      nextPresentationCount: input.priorPresentationCount,
    };
  const nextPresentationCount = input.priorPresentationCount + 1;
  const complete =
    input.remainingUnresolvedCards === 0 ||
    nextPresentationCount >= studyPresentationCap(input.totalCards);
  if (complete)
    return {
      kind: "complete" as const,
      nextPresentationCount,
      completionReason:
        input.remainingUnresolvedCards === 0
          ? ("all_resolved" as const)
          : ("presentation_budget" as const),
    };
  return {
    kind: input.kind === "choice_retryable" ? ("keep_current" as const) : ("advance" as const),
    nextPresentationCount,
  };
};

// No qualification, source mutation, Palm, persona, membership, provider call,
// checkpoint persistence, session expiry or guest-lease authorization lives here.
