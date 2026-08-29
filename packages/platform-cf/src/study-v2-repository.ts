import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  StudyV2CommandRejected,
  type StudyV2Store,
  StudyV2StoreFailed,
} from "@pirate/application";
import {
  type StudyAnswerResultV2,
  StudyAvailabilityV2,
  StudySessionItemV2,
  StudySessionV2,
} from "@pirate/contracts";
import { gradeAcceptedTextV2, gradeEnglishTranscriptV2, gradeExactChoiceV2 } from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";
import { recordQualificationProjections } from "./activity-qualification-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const failed = (reason: StudyV2StoreFailed["reason"]) => new StudyV2StoreFailed({ reason });
const rejected = (reason: StudyV2CommandRejected["reason"]) =>
  new StudyV2CommandRejected({ reason });

const mapControlPlaneError = (error: ControlPlaneError): StudyV2StoreFailed => {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return failed("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return failed("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return failed("constraint");
  }
  return failed("unavailable");
};

const mapErrors = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapControlPlaneError(error as ControlPlaneError)
          : (error as E)
        : (error as E),
    ),
  );

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);
const integer = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${key}`);
  return value;
};
const iso = (value: unknown): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid instant");
  return parsed.toISOString();
};
const json = (value: unknown): unknown =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const readSession = Effect.fn("readStudyV2Session")(function* (
  db: ControlPlaneTransaction,
  input: { accountId: string; communityId: string; sessionId: string },
) {
  const sessions = yield* db.execute<Row>({
    label: "study-v2.session.read",
    text: `SELECT session_id, persona_id, community_id, post_id, audio_revision,
                  lyrics_revision, learning_language, helper_language, learner_band,
                  study_profile_revision, source_set_revision, selection_policy_revision,
                  qualification_policy_revision, timezone, status, created_at, completed_at
             FROM study_sessions_v2
            WHERE session_id=$1 AND account_id=$2 AND community_id=$3`,
    values: [input.sessionId, input.accountId, input.communityId],
    readonly: true,
  });
  if (sessions.rows.length === 0) return null;
  if (sessions.rows.length !== 1) return yield* Effect.fail(failed("invalid-row"));
  const row = sessions.rows[0] as Row;
  const itemRows = yield* db.execute<Row>({
    label: "study-v2.session-items.read",
    text: `SELECT item_snapshot FROM study_session_items_v2
            WHERE session_id=$1 ORDER BY ordinal`,
    values: [input.sessionId],
    readonly: true,
  });
  const items = itemRows.rows.map((item) => json(item.item_snapshot) as StudySessionItemV2);
  const progressRows = yield* db.execute<Row>({
    label: "study-v2.progress.read",
    text: `SELECT
      count(*)::bigint AS exercise_count,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM study_attempts_v2 a
         WHERE a.session_item_id=i.session_item_id AND a.attempt_state='spent'
      ))::bigint AS answered_count,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM study_attempts_v2 a
         WHERE a.session_item_id=i.session_item_id AND a.attempt_number=1 AND a.outcome='correct'
      ))::bigint AS first_pass_correct
      FROM study_session_items_v2 i WHERE i.session_id=$1`,
    values: [input.sessionId],
    readonly: true,
  });
  const progress = progressRows.rows[0] as Row;
  const count = integer(progress, "exercise_count");
  const answered = integer(progress, "answered_count");
  const correct = integer(progress, "first_pass_correct");
  return yield* Effect.try({
    try: () =>
      decode(StudySessionV2, {
        object: "study_session_v2",
        session_id: text(row, "session_id"),
        persona_id: text(row, "persona_id"),
        community_id: text(row, "community_id"),
        post_id: text(row, "post_id"),
        audio_revision: integer(row, "audio_revision"),
        lyrics_revision: integer(row, "lyrics_revision"),
        languages: {
          learning_language: text(row, "learning_language"),
          helper_language: nullableText(row, "helper_language"),
        },
        learner_band: text(row, "learner_band"),
        study_profile_revision: integer(row, "study_profile_revision"),
        source_set_revision: integer(row, "source_set_revision"),
        selection_policy_revision: text(row, "selection_policy_revision"),
        qualification_policy_revision: text(row, "qualification_policy_revision"),
        timezone: text(row, "timezone"),
        status: text(row, "status"),
        items,
        progress: {
          qualifying_exercise_count: count,
          answered_exercise_count: answered,
          first_pass_correct: correct,
          required_correct: Math.max(1, Math.ceil((7 * count) / 10)),
          score_bps: answered === count ? Math.floor((10_000 * correct) / count) : null,
        },
        created_at: iso(row.created_at),
        completed_at: row.completed_at === null ? null : iso(row.completed_at),
      }),
    catch: () => failed("invalid-row"),
  });
});

const exerciseRows = (
  db: ControlPlaneTransaction,
  input: {
    communityId: string;
    postId: string;
    helperLanguage: string | null;
    learnerBand: string;
  },
) =>
  db.execute<Row>({
    label: "study-v2.exercises.select",
    text: `SELECT DISTINCT ON (exercise_review_key)
             exercise_version_id, exercise_review_key, exercise_type, exercise_variant,
             post_id, audio_revision, lyrics_revision, lyric_line_id, line_version,
             line_source_hash, learning_language, helper_language, learner_band,
             presentation, answer_visibility, feedback_release, grader_policy_revision,
             feedback_policy_revision, quality_policy_revision
           FROM study_exercise_versions exercise
           JOIN media_publication_projections publication
             ON publication.community_id=exercise.community_id
            AND publication.post_id=exercise.post_id
           JOIN media_post_submissions submission
             ON submission.submission_id=publication.submission_id
            AND submission.audio_revision=exercise.audio_revision
            AND submission.current_lyrics_revision=exercise.lyrics_revision
          WHERE exercise.community_id=$1 AND exercise.post_id=$2
            AND exercise.learner_band=$3 AND exercise.retired_at IS NULL
            AND ((exercise.exercise_type='translation_choice' AND exercise.helper_language=$4)
              OR (exercise.exercise_type<>'translation_choice' AND exercise.helper_language IS NULL))
          ORDER BY exercise_review_key, content_revision DESC
          LIMIT 64`,
    values: [input.communityId, input.postId, input.learnerBand, input.helperLanguage],
    readonly: false,
  });

const itemFromExercise = (row: Row, sessionId: string, ordinal: number): StudySessionItemV2 =>
  decode(StudySessionItemV2, {
    object: "study_session_item_v2",
    session_item_id: `${sessionId}_item_${ordinal + 1}`,
    ordinal,
    exercise_review_key: text(row, "exercise_review_key"),
    exercise_version_id: text(row, "exercise_version_id"),
    exercise_type: text(row, "exercise_type"),
    exercise_variant: text(row, "exercise_variant"),
    line: {
      post_id: text(row, "post_id"),
      audio_revision: integer(row, "audio_revision"),
      lyrics_revision: integer(row, "lyrics_revision"),
      lyric_line_id: text(row, "lyric_line_id"),
      line_version: integer(row, "line_version"),
      line_source_hash: text(row, "line_source_hash"),
    },
    languages: {
      learning_language: text(row, "learning_language"),
      helper_language: nullableText(row, "helper_language"),
    },
    learner_band: text(row, "learner_band"),
    presentation: json(row.presentation),
    answer_visibility: text(row, "answer_visibility"),
    feedback_release: text(row, "feedback_release"),
    grader_policy_revision: text(row, "grader_policy_revision"),
    feedback_policy_revision: text(row, "feedback_policy_revision"),
    quality_policy_revision: text(row, "quality_policy_revision"),
    maximum_attempts: 2,
  });

export const makeControlPlaneStudyV2Repository = () => ({
  getAvailability: (input: Parameters<StudyV2Store["getAvailability"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.execute<Row>({
          label: "study-v2.availability",
          text: `SELECT exercise.exercise_type, exercise.helper_language,
                        exercise.learner_band, count(DISTINCT exercise.exercise_review_key)::bigint AS count
                   FROM study_exercise_versions exercise
                   JOIN media_publication_projections publication
                     ON publication.community_id=exercise.community_id
                    AND publication.post_id=exercise.post_id
                   JOIN media_post_submissions submission
                     ON submission.submission_id=publication.submission_id
                    AND submission.audio_revision=exercise.audio_revision
                    AND submission.current_lyrics_revision=exercise.lyrics_revision
                  WHERE exercise.community_id=$1 AND exercise.post_id=$2
                    AND exercise.retired_at IS NULL
                  GROUP BY exercise.exercise_type, exercise.helper_language, exercise.learner_band`,
          values: [input.communityId, input.postId],
          readonly: true,
        });
        const sourceByBand = new Map<string, number>();
        const translatedByBandAndHelper = new Map<string, number>();
        for (const row of rows.rows) {
          const band = text(row, "learner_band");
          const count = integer(row, "count");
          const helper = nullableText(row, "helper_language");
          if (helper === null) sourceByBand.set(band, (sourceByBand.get(band) ?? 0) + count);
          else {
            const key = `${band}\u0000${helper}`;
            translatedByBandAndHelper.set(key, (translatedByBandAndHelper.get(key) ?? 0) + count);
          }
        }
        const candidateCounts = [...sourceByBand.entries()].flatMap(([band, sourceCount]) => [
          sourceCount,
          ...[...translatedByBandAndHelper.entries()]
            .filter(([key]) => key.startsWith(`${band}\u0000`))
            .map(([, translatedCount]) => sourceCount + translatedCount),
        ]);
        const ready = candidateCounts.some((count) => count >= 4);
        if (!ready) {
          const total = rows.rows.reduce((sum, row) => sum + integer(row, "count"), 0);
          return decode(StudyAvailabilityV2, {
            state: total === 0 ? "unavailable" : "processing",
            ...(total === 0
              ? { reason: "insufficient_exercises" }
              : {
                  available_exercise_types: [
                    ...new Set(rows.rows.map((row) => text(row, "exercise_type"))),
                  ],
                  pending_exercise_types: [],
                }),
          });
        }
        return decode(StudyAvailabilityV2, {
          state: "ready",
          available_exercise_types: [
            ...new Set(rows.rows.map((row) => text(row, "exercise_type"))),
          ],
          learning_language: "en",
          helper_languages: [
            ...new Set(
              rows.rows.flatMap((row) => {
                const value = nullableText(row, "helper_language");
                return value === null ? [] : [value];
              }),
            ),
          ],
          learner_bands: [...new Set(rows.rows.map((row) => text(row, "learner_band")))],
        });
      }),
    ),
  startSession: (input: Parameters<StudyV2Store["startSession"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replay = yield* transaction.execute<Row>({
              label: "study-v2.start.replay",
              text: `SELECT session_id, request_hash FROM study_sessions_v2
                      WHERE account_id=$1 AND post_id=$2 AND idempotency_key=$3 FOR UPDATE`,
              values: [input.accountId, input.postId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (text(row, "request_hash") !== input.requestHash) {
                return yield* rejected("idempotency-conflict");
              }
              const session = yield* readSession(transaction, {
                accountId: input.accountId,
                communityId: input.communityId,
                sessionId: text(row, "session_id"),
              });
              return session ?? (yield* Effect.fail(failed("invalid-row")));
            }
            const exercises = yield* exerciseRows(transaction, {
              communityId: input.communityId,
              postId: input.postId,
              helperLanguage: input.helperLanguage,
              learnerBand: input.learnerBand,
            });
            if (exercises.rows.length < 4) return yield* rejected("insufficient-exercises");
            const items = exercises.rows.map((row, ordinal) =>
              itemFromExercise(row, input.sessionId, ordinal),
            );
            const first = exercises.rows[0] as Row;
            yield* transaction.execute({
              label: "study-v2.start.insert",
              text: `INSERT INTO study_sessions_v2 (
                session_id, account_id, persona_id, community_id, post_id, audio_revision,
                lyrics_revision, learning_language, helper_language, learner_band,
                study_profile_revision, source_set_revision, selection_policy_revision,
                qualification_policy_revision, timezone, idempotency_key, request_hash, created_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,'en',$8,$9,1,1,
                'study_selection_v1','study_session_first_pass_v2@1',$10,$11,$12,$13::timestamptz)`,
              values: [
                input.sessionId,
                input.accountId,
                input.personaId,
                input.communityId,
                input.postId,
                integer(first, "audio_revision"),
                integer(first, "lyrics_revision"),
                input.helperLanguage,
                input.learnerBand,
                input.timezone,
                input.idempotencyKey,
                input.requestHash,
                input.createdAt,
              ],
              readonly: false,
            });
            for (const ordinal of exercises.rows.keys()) {
              const item = items[ordinal];
              if (item === undefined) return yield* Effect.fail(failed("invalid-row"));
              const reviewId = `${input.sessionId}_review_${ordinal + 1}`;
              yield* transaction.execute({
                label: "study-v2.review.upsert",
                text: `INSERT INTO study_review_items (
                  review_item_id, account_id, exercise_review_key, current_exercise_version_id,
                  scheduler_policy_revision, scheduler_state
                ) VALUES ($1,$2,$3,$4,'study_scheduler_v1','{}'::jsonb)
                ON CONFLICT (account_id, exercise_review_key) DO UPDATE SET
                  current_exercise_version_id=excluded.current_exercise_version_id,
                  updated_at=clock_timestamp()`,
                values: [
                  reviewId,
                  input.accountId,
                  item.exercise_review_key,
                  item.exercise_version_id,
                ],
                readonly: false,
              });
              const review = yield* transaction.execute<Row>({
                label: "study-v2.review.read",
                text: `SELECT review_item_id FROM study_review_items
                        WHERE account_id=$1 AND exercise_review_key=$2`,
                values: [input.accountId, item.exercise_review_key],
                readonly: false,
              });
              yield* transaction.execute({
                label: "study-v2.item.insert",
                text: `INSERT INTO study_session_items_v2 (
                  session_item_id, session_id, ordinal, exercise_review_key,
                  exercise_version_id, review_item_id, item_snapshot, maximum_attempts, account_id
                ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,2,$8)`,
                values: [
                  item.session_item_id,
                  input.sessionId,
                  ordinal,
                  item.exercise_review_key,
                  item.exercise_version_id,
                  text(review.rows[0] as Row, "review_item_id"),
                  JSON.stringify(item),
                  input.accountId,
                ],
                readonly: false,
              });
            }
            const session = yield* readSession(transaction, {
              accountId: input.accountId,
              communityId: input.communityId,
              sessionId: input.sessionId,
            });
            return session ?? (yield* Effect.fail(failed("invalid-row")));
          }),
        );
      }),
    ),
  getSession: (input: Parameters<StudyV2Store["getSession"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        return yield* readSession(yield* ControlPlaneDb, input);
      }),
    ),
  submitAnswer: (input: Parameters<StudyV2Store["submitAnswer"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const replay = yield* transaction.execute<Row>({
              label: "study-v2.answer.replay",
              text: `SELECT request_hash, outcome, first_pass, attempt_state, feedback_kind,
                            feedback_evidence, attempt_number, session_item_id
                       FROM study_attempts_v2 WHERE session_item_id=$1 AND idempotency_key=$2`,
              values: [input.sessionItemId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (text(row, "request_hash") !== input.requestHash)
                return yield* rejected("idempotency-conflict");
              const session = yield* readSession(transaction, input);
              if (session === null) return yield* rejected("not-found");
              const item = session.items.find(
                ({ session_item_id }) => session_item_id === input.sessionItemId,
              );
              if (item === undefined) return yield* rejected("not-found");
              return {
                object: "study_answer_result_v2",
                session_item_id: input.sessionItemId,
                attempt_number: integer(row, "attempt_number"),
                exercise_type: item.exercise_type,
                outcome: text(row, "outcome"),
                first_pass: row.first_pass === true,
                attempt_state: text(row, "attempt_state"),
                feedback: json(row.feedback_evidence),
                session,
              } as StudyAnswerResultV2;
            }
            const selected = yield* transaction.execute<Row>({
              label: "study-v2.answer.item",
              text: `SELECT i.item_snapshot, i.maximum_attempts, e.private_grader
                       FROM study_session_items_v2 i
                       JOIN study_sessions_v2 s ON s.session_id=i.session_id AND s.account_id=i.account_id
                       JOIN study_exercise_versions e ON e.exercise_version_id=i.exercise_version_id
                      WHERE i.session_item_id=$1 AND i.session_id=$2 AND i.account_id=$3
                        AND s.community_id=$4 AND s.status='active' FOR UPDATE OF i, s`,
              values: [input.sessionItemId, input.sessionId, input.accountId, input.communityId],
              readonly: false,
            });
            if (selected.rows.length !== 1) return yield* rejected("not-found");
            const row = selected.rows[0] as Row;
            const item = json(row.item_snapshot) as StudySessionItemV2;
            const grader = json(row.private_grader) as Record<string, unknown>;
            const expected =
              item.exercise_type === "say_it_back"
                ? "transcript_response"
                : item.exercise_type === "translation_choice"
                  ? "single_select"
                  : "text_response";
            if (input.answer.kind !== expected) return yield* rejected("submission-kind-mismatch");
            const attempts = yield* transaction.execute<Row>({
              label: "study-v2.answer.count",
              text: "SELECT count(*)::bigint AS count FROM study_attempts_v2 WHERE session_item_id=$1",
              values: [input.sessionItemId],
              readonly: false,
            });
            if (input.attemptNumber !== integer(attempts.rows[0] as Row, "count") + 1) {
              return yield* rejected("attempt-conflict");
            }
            let correct = false;
            let transcriptGrade: ReturnType<typeof gradeEnglishTranscriptV2> | null = null;
            if (input.answer.kind === "single_select") {
              correct = gradeExactChoiceV2(
                input.answer.choice_key,
                String(grader.correct_choice_key),
              );
            } else if (input.answer.kind === "text_response") {
              const accepted = Array.isArray(grader.accepted_answers)
                ? grader.accepted_answers.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              correct = gradeAcceptedTextV2(input.answer.text, accepted);
            } else {
              const evidence = yield* transaction.execute<Row>({
                label: "study-v2.transcript.read",
                text: `SELECT transcript, expires_at FROM study_transcript_evidence_v2
                        WHERE transcript_evidence_id=$1 AND account_id=$2 AND session_item_id=$3`,
                values: [input.answer.transcript_evidence_id, input.accountId, input.sessionItemId],
                readonly: false,
              });
              if (evidence.rows.length === 0)
                return yield* rejected("transcript-evidence-mismatch");
              const evidenceRow = evidence.rows[0] as Row;
              if (Date.parse(iso(evidenceRow.expires_at)) <= Date.parse(input.acceptedAt)) {
                return yield* rejected("transcript-evidence-expired");
              }
              transcriptGrade = gradeEnglishTranscriptV2(
                String(grader.reference_text),
                text(evidenceRow, "transcript"),
              );
              correct = transcriptGrade.correct;
            }
            const spent = correct || input.attemptNumber >= integer(row, "maximum_attempts");
            const feedback =
              item.exercise_type === "say_it_back" && transcriptGrade !== null
                ? {
                    kind: "transcript_diff" as const,
                    transcript: transcriptGrade.transcript,
                    matched: transcriptGrade.matched,
                    missing: transcriptGrade.missing,
                    extra: transcriptGrade.extra,
                    policy_revision: transcriptGrade.policyRevision,
                  }
                : !spent
                  ? { kind: "none" as const }
                  : item.exercise_type === "translation_choice"
                    ? {
                        kind: "choice_reveal" as const,
                        correct_choice_key: String(grader.correct_choice_key),
                        correct_text: String(grader.correct_text),
                        ...(typeof grader.explanation === "string"
                          ? { explanation: grader.explanation }
                          : {}),
                      }
                    : {
                        kind: "text_reveal" as const,
                        accepted_answer: String(grader.canonical_answer),
                        ...(typeof grader.explanation === "string"
                          ? { explanation: grader.explanation }
                          : {}),
                      };
            yield* transaction.execute({
              label: "study-v2.answer.insert",
              text: `INSERT INTO study_attempts_v2 (
                attempt_id, session_item_id, attempt_number, submission_kind, submission_evidence,
                outcome, first_pass, attempt_state, feedback_kind, feedback_evidence,
                grader_policy_revision, feedback_policy_revision, accepted_at,
                idempotency_key, request_hash
              ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::timestamptz,$14,$15)`,
              values: [
                input.attemptId,
                input.sessionItemId,
                input.attemptNumber,
                input.answer.kind,
                JSON.stringify(input.answer),
                correct ? "correct" : "incorrect",
                input.attemptNumber === 1,
                spent ? "spent" : "retryable",
                feedback.kind,
                JSON.stringify(feedback),
                item.grader_policy_revision,
                item.feedback_policy_revision,
                input.acceptedAt,
                input.idempotencyKey,
                input.requestHash,
              ],
              readonly: false,
            });
            const remaining = yield* transaction.execute<Row>({
              label: "study-v2.completion.check",
              text: `SELECT count(*)::bigint AS count FROM study_session_items_v2 i
                      WHERE i.session_id=$1 AND NOT EXISTS (
                        SELECT 1 FROM study_attempts_v2 a
                         WHERE a.session_item_id=i.session_item_id AND a.attempt_state='spent')`,
              values: [input.sessionId],
              readonly: false,
            });
            if (integer(remaining.rows[0] as Row, "count") === 0) {
              const completed = yield* transaction.execute<Row>({
                label: "study-v2.session.complete",
                text: `UPDATE study_sessions_v2 SET status='completed', completed_at=$2::timestamptz
                        WHERE session_id=$1 AND status='active'
                    RETURNING persona_id, community_id, post_id, audio_revision,
                              qualification_policy_revision, timezone,
                              ($2::timestamptz AT TIME ZONE timezone)::date AS streak_day`,
                values: [input.sessionId, input.acceptedAt],
                readonly: false,
              });
              if (completed.rows.length === 1) {
                const progress = yield* transaction.execute<Row>({
                  label: "study-v2.qualification.progress",
                  text: `SELECT count(*)::bigint AS exercise_count,
                                count(*) FILTER (WHERE EXISTS (
                                  SELECT 1 FROM study_attempts_v2 attempt
                                   WHERE attempt.session_item_id=item.session_item_id
                                     AND attempt.attempt_number=1 AND attempt.outcome='correct'
                                ))::bigint AS first_pass_correct
                           FROM study_session_items_v2 item WHERE item.session_id=$1`,
                  values: [input.sessionId],
                  readonly: false,
                });
                const progressRow = progress.rows[0] as Row;
                const exerciseCount = integer(progressRow, "exercise_count");
                const firstPassCorrect = integer(progressRow, "first_pass_correct");
                const requiredCorrect = Math.max(1, Math.ceil((7 * exerciseCount) / 10));
                if (firstPassCorrect >= requiredCorrect) {
                  const terminal = completed.rows[0] as Row;
                  yield* transaction.execute({
                    label: "study-v2.qualification.insert",
                    text: `INSERT INTO activity_qualifications (
                             qualification_id, account_id, persona_id, community_id, post_id,
                             audio_revision, activity_key, study_session_id, score_bps,
                             qualification_policy_version_id, qualified_at, streak_day,
                             evidence_summary, created_at
                           ) VALUES ($1,$2,$3,$4,$5,$6,'study',$7,$8,$9,$10::timestamptz,
                             $11::date,$12::jsonb,$10::timestamptz)`,
                    values: [
                      input.qualificationId,
                      input.accountId,
                      text(terminal, "persona_id"),
                      text(terminal, "community_id"),
                      text(terminal, "post_id"),
                      integer(terminal, "audio_revision"),
                      input.sessionId,
                      Math.floor((10_000 * firstPassCorrect) / exerciseCount),
                      text(terminal, "qualification_policy_revision"),
                      input.acceptedAt,
                      text(terminal, "streak_day"),
                      JSON.stringify({
                        kind: "study_session_first_pass_v2",
                        qualifying_exercise_count: exerciseCount,
                        first_pass_correct: firstPassCorrect,
                        required_correct: requiredCorrect,
                      }),
                    ],
                    readonly: false,
                  });
                  yield* recordQualificationProjections(transaction, {
                    accountId: input.accountId,
                    communityId: text(terminal, "community_id"),
                    personaId: text(terminal, "persona_id"),
                    postId: text(terminal, "post_id"),
                    activity: "study",
                    qualificationId: input.qualificationId,
                    qualifiedAt: input.acceptedAt,
                    streakDay: text(terminal, "streak_day"),
                    timezone: text(terminal, "timezone"),
                  }).pipe(Effect.mapError(() => failed("constraint")));
                }
              }
            }
            const session = yield* readSession(transaction, input);
            if (session === null) return yield* rejected("not-found");
            return {
              object: "study_answer_result_v2",
              session_item_id: input.sessionItemId,
              attempt_number: input.attemptNumber,
              exercise_type: item.exercise_type,
              outcome: correct ? "correct" : "incorrect",
              first_pass: input.attemptNumber === 1,
              attempt_state: spent ? "spent" : "retryable",
              feedback,
              session,
            } as StudyAnswerResultV2;
          }),
        );
      }),
    ),
});

export const makeControlPlaneStudyV2Store = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): StudyV2Store => {
  const repository = makeControlPlaneStudyV2Repository();
  const provide = <A, E>(effect: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    mapErrors(Effect.provide(runtime)(effect));
  return {
    getAvailability: (input) => provide(repository.getAvailability(input)),
    startSession: (input) => provide(repository.startSession(input)),
    getSession: (input) => provide(repository.getSession(input)),
    submitAnswer: (input) => provide(repository.submitAnswer(input)),
  };
};
