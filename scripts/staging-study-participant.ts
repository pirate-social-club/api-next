import type {
  StudyAnswerResultV1,
  StudyAnswerSubmissionV1,
  StudySessionV1,
} from "@pirate/contracts";
import { buildAcceptedLyricsStudyItemSource } from "@pirate/platform-cf/accepted-lyrics-study-item-source";

export type StagingStudyParticipantInput = Readonly<{
  runId: string;
  communityId: string;
  postId: string;
  personaId: string;
  timezone: string;
  acceptedLyrics: string;
}>;

export type StagingStudyParticipantDependencies = Readonly<{
  startSession: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly idempotencyKey: string;
    readonly personaId: string;
    readonly timezone: string;
  }) => Promise<StudySessionV1>;
  submitAnswer: (input: {
    readonly communityId: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
    readonly idempotencyKey: string;
    readonly attemptNumber: number;
    readonly answer: StudyAnswerSubmissionV1;
  }) => Promise<StudyAnswerResultV1>;
  getSession: (input: {
    readonly communityId: string;
    readonly sessionId: string;
  }) => Promise<StudySessionV1>;
}>;

export class StagingStudyParticipantFailed extends Error {
  readonly code: "source-mismatch" | "answer-rejected" | "qualification-missing";

  constructor(code: StagingStudyParticipantFailed["code"], message: string) {
    super(message);
    this.name = "StagingStudyParticipantFailed";
    this.code = code;
  }
}

const promptMatches = (
  actual: StudySessionV1["items"][number]["prompt"],
  expected: StudySessionV1["items"][number]["prompt"],
): boolean => {
  if (actual.kind !== expected.kind || actual.text !== expected.text) return false;
  if (actual.kind === "text_response" || expected.kind === "text_response") {
    return actual.kind === expected.kind;
  }
  return (
    actual.choices.length === expected.choices.length &&
    actual.choices.every(
      (choice, index) =>
        choice.choice_key === expected.choices[index]?.choice_key &&
        choice.text === expected.choices[index]?.text,
    )
  );
};

const idempotencyKey = (runId: string, step: "start" | number): string =>
  step === "start"
    ? `megapot-golden-${runId}-study-start`
    : `megapot-golden-${runId}-study-answer-${step + 1}`;

export async function runStagingStudyParticipant(
  input: StagingStudyParticipantInput,
  dependencies: StagingStudyParticipantDependencies,
) {
  const started = await dependencies.startSession({
    communityId: input.communityId,
    postId: input.postId,
    idempotencyKey: idempotencyKey(input.runId, "start"),
    personaId: input.personaId,
    timezone: input.timezone,
  });
  if (
    started.community_id !== input.communityId ||
    started.post_id !== input.postId ||
    started.persona_id !== input.personaId
  ) {
    throw new StagingStudyParticipantFailed(
      "source-mismatch",
      "The Study session identity does not match the golden-flow participant.",
    );
  }

  const expected = buildAcceptedLyricsStudyItemSource({
    request: {
      communityId: input.communityId,
      postId: input.postId,
      audioRevision: started.audio_revision,
      lyricsRevision: started.lyrics_revision,
    },
    lyricsText: input.acceptedLyrics,
  });
  if (expected === null || expected.items.length !== started.items.length) {
    throw new StagingStudyParticipantFailed(
      "source-mismatch",
      "The accepted lyrics fixture does not reproduce the frozen Study session.",
    );
  }

  for (const [index, item] of started.items.entries()) {
    const expectedItem = expected.items[index];
    if (
      expectedItem === undefined ||
      item.ordinal !== index ||
      item.source_identity.source_item_key !== expectedItem.source_item_key ||
      item.source_identity.source_revision !== expected.source_revision ||
      !promptMatches(item.prompt, expectedItem.prompt)
    ) {
      throw new StagingStudyParticipantFailed(
        "source-mismatch",
        "The accepted lyrics fixture does not match the server-generated Study items.",
      );
    }
    if (item.first_pass_outcome === "incorrect") {
      throw new StagingStudyParticipantFailed(
        "answer-rejected",
        "The replayed Study session already contains an incorrect first-pass answer.",
      );
    }
    if (item.first_pass_outcome === "correct") continue;
    if (expectedItem.answer_key.kind !== "text_response") {
      throw new StagingStudyParticipantFailed(
        "source-mismatch",
        "The accepted lyrics producer returned an unsupported Study answer kind.",
      );
    }
    const answer = expectedItem.answer_key.accepted_answers[0];
    const result = await dependencies.submitAnswer({
      communityId: input.communityId,
      sessionId: started.session_id,
      sessionItemId: item.session_item_id,
      idempotencyKey: idempotencyKey(input.runId, index),
      attemptNumber: 1,
      answer: { kind: "text_response", text: answer },
    });
    if (
      result.session_item_id !== item.session_item_id ||
      result.attempt_number !== 1 ||
      result.outcome !== "correct" ||
      !result.first_pass
    ) {
      throw new StagingStudyParticipantFailed(
        "answer-rejected",
        "The staging API did not accept the expected Study answer on first pass.",
      );
    }
  }

  const completed = await dependencies.getSession({
    communityId: input.communityId,
    sessionId: started.session_id,
  });
  const qualification = completed.qualification;
  if (
    completed.status !== "completed" ||
    completed.session_id !== started.session_id ||
    completed.persona_id !== input.personaId ||
    completed.items.some((item) => item.first_pass_outcome !== "correct") ||
    qualification === null ||
    qualification.activity !== "study" ||
    qualification.persona_id !== input.personaId ||
    qualification.community_id !== input.communityId ||
    qualification.post_id !== input.postId ||
    qualification.score_bps < 7_000
  ) {
    throw new StagingStudyParticipantFailed(
      "qualification-missing",
      "The Study session did not persist an eligible qualification.",
    );
  }

  return {
    object: "staging_study_participant_result" as const,
    session_id: completed.session_id,
    audio_revision: completed.audio_revision,
    lyrics_revision: completed.lyrics_revision,
    source_revision: completed.source_revision,
    qualifying_exercise_count: completed.progress.qualifying_exercise_count,
    first_pass_correct: completed.progress.first_pass_correct,
    score_bps: qualification.score_bps,
    qualification_id: qualification.qualification_id,
  };
}
