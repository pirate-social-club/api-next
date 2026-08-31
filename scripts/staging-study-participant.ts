import type { StudyAnswerResultV2, StudySessionV2 } from "@pirate/contracts";

export type StudyFixtureAudio = Readonly<{
  bytes: Uint8Array;
  durationMs: number;
}>;

export type StagingStudyParticipantInput = Readonly<{
  runId: string;
  communityId: string;
  postId: string;
  personaId: string;
  acceptedLyrics: string;
  session: StudySessionV2;
}>;

export type StagingStudyParticipantDependencies = Readonly<{
  synthesizeAudio: (referenceText: string) => Promise<StudyFixtureAudio>;
  submitAnswer: (input: {
    readonly communityId: string;
    readonly sessionId: string;
    readonly sessionItemId: string;
    readonly idempotencyKey: string;
    readonly attemptNumber: number;
    readonly audio: StudyFixtureAudio;
  }) => Promise<StudyAnswerResultV2>;
  getSession: (input: {
    readonly communityId: string;
    readonly sessionId: string;
  }) => Promise<StudySessionV2>;
}>;

export class StagingStudyParticipantFailed extends Error {
  readonly code:
    | "source-mismatch"
    | "audio-unavailable"
    | "answer-rejected"
    | "qualification-missing";

  constructor(code: StagingStudyParticipantFailed["code"], message: string) {
    super(message);
    this.name = "StagingStudyParticipantFailed";
    this.code = code;
  }
}

const normalizeLine = (value: string): string => value.trim().replaceAll(/\s+/gu, " ");

const sessionMatchesInput = (
  session: StudySessionV2,
  input: StagingStudyParticipantInput,
): boolean =>
  session.session_id === input.session.session_id &&
  session.community_id === input.communityId &&
  session.post_id === input.postId &&
  session.persona_id === input.personaId &&
  session.audio_revision === input.session.audio_revision &&
  session.lyrics_revision === input.session.lyrics_revision &&
  session.items.every(
    (item, ordinal) =>
      item.ordinal === ordinal &&
      item.exercise_type === "say_it_back" &&
      item.presentation.kind === "say_it_back" &&
      item.line.post_id === input.postId &&
      item.line.audio_revision === session.audio_revision &&
      item.line.lyrics_revision === session.lyrics_revision,
  );

const assertSource = (session: StudySessionV2, input: StagingStudyParticipantInput): void => {
  const acceptedLines = new Set(
    input.acceptedLyrics.split(/\r?\n/gu).map(normalizeLine).filter(Boolean),
  );
  if (
    !sessionMatchesInput(session, input) ||
    session.items.some(
      (item) =>
        item.presentation.kind !== "say_it_back" ||
        !acceptedLines.has(normalizeLine(item.presentation.reference_text)),
    )
  ) {
    throw new StagingStudyParticipantFailed(
      "source-mismatch",
      "The typed Study v2 session does not match the accepted-lyrics fixture.",
    );
  }
};

const answerIdempotencyKey = (runId: string, ordinal: number, attemptNumber: number): string =>
  `megapot-golden-${runId}-study-v2-answer-${ordinal + 1}-${attemptNumber}`;

function wavDurationMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || view.getUint32(0, false) !== 0x5249_4646) {
    throw new StagingStudyParticipantFailed(
      "audio-unavailable",
      "Local Study fixture synthesis returned an invalid WAV file.",
    );
  }
  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x666d_7420 && size >= 16) byteRate = view.getUint32(offset + 16, true);
    if (id === 0x6461_7461) {
      dataSize = Math.min(size, bytes.byteLength - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (byteRate === undefined || byteRate === 0 || dataSize === undefined) {
    throw new StagingStudyParticipantFailed(
      "audio-unavailable",
      "Local Study fixture synthesis returned an invalid WAV file.",
    );
  }
  return Math.max(1, Math.min(60_000, Math.round((dataSize * 1_000) / byteRate)));
}

export async function synthesizeStudyFixtureAudio(
  referenceText: string,
): Promise<StudyFixtureAudio> {
  if (
    [...referenceText].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new StagingStudyParticipantFailed(
      "audio-unavailable",
      "The Study fixture line contains unsupported control characters.",
    );
  }
  try {
    const fliteText = referenceText
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replaceAll(":", "\\:");
    const child = Bun.spawn(
      [
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `flite=text='${fliteText}':voice=slt`,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    if ((await child.exited) !== 0 || bytes.byteLength === 0 || bytes.byteLength > 524_288) {
      throw new Error("local synthesis failed");
    }
    return { bytes, durationMs: wavDurationMs(bytes) };
  } catch (error) {
    if (error instanceof StagingStudyParticipantFailed) throw error;
    throw new StagingStudyParticipantFailed(
      "audio-unavailable",
      "Local FFmpeg flite synthesis is required for Study v2 qualification.",
    );
  }
}

export async function runStagingStudyParticipant(
  input: StagingStudyParticipantInput,
  dependencies: StagingStudyParticipantDependencies,
) {
  assertSource(input.session, input);
  let session = input.session;
  let submissions = 0;

  while (session.status === "active" && submissions < session.lesson.presentation_cap) {
    const current = session.lesson.current;
    const item = session.items.find(
      (candidate) => candidate.session_item_id === current?.session_item_id,
    );
    if (current === null || item?.presentation.kind !== "say_it_back") {
      throw new StagingStudyParticipantFailed(
        "source-mismatch",
        "The typed Study v2 lesson has no supported current card.",
      );
    }
    const audio = await dependencies.synthesizeAudio(item.presentation.reference_text);
    const result = await dependencies.submitAnswer({
      communityId: input.communityId,
      sessionId: session.session_id,
      sessionItemId: item.session_item_id,
      idempotencyKey: answerIdempotencyKey(input.runId, item.ordinal, current.presentation_number),
      attemptNumber: current.presentation_number,
      audio,
    });
    if (
      result.session_item_id !== item.session_item_id ||
      result.attempt_number !== current.presentation_number ||
      result.exercise_type !== "say_it_back" ||
      result.feedback.kind !== "transcript_diff" ||
      !sessionMatchesInput(result.session, input) ||
      (result.session.status === "active" &&
        result.session.lesson.presentation_count <= session.lesson.presentation_count)
    ) {
      throw new StagingStudyParticipantFailed(
        "answer-rejected",
        "The staging API returned an invalid Study v2 answer transition.",
      );
    }
    session = result.session;
    submissions += 1;
  }

  const completed = await dependencies.getSession({
    communityId: input.communityId,
    sessionId: session.session_id,
  });
  assertSource(completed, input);
  if (
    completed.status !== "completed" ||
    completed.session_id !== input.session.session_id ||
    completed.progress.score_bps === null ||
    completed.progress.score_bps < 7_000 ||
    completed.progress.first_pass_correct < completed.progress.required_correct
  ) {
    throw new StagingStudyParticipantFailed(
      "qualification-missing",
      "The Study v2 session did not persist an eligible terminal score.",
    );
  }

  return {
    object: "staging_study_participant_result_v2" as const,
    session_id: completed.session_id,
    audio_revision: completed.audio_revision,
    lyrics_revision: completed.lyrics_revision,
    source_set_revision: completed.source_set_revision,
    qualifying_exercise_count: completed.progress.qualifying_exercise_count,
    first_pass_correct: completed.progress.first_pass_correct,
    required_correct: completed.progress.required_correct,
    score_bps: completed.progress.score_bps,
  };
}
