import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  StudyV2CommandRejected,
  type StudyV2Store,
  StudyV2StoreFailed,
} from "@pirate/application";
import {
  StudyAnswerResultV2,
  StudyAvailabilityV2,
  StudySessionItemV2,
  StudySessionV2,
} from "@pirate/contracts";
import { gradeExactChoiceV2, scheduleStudyReviewV1 } from "@pirate/domain";
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
const number = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`invalid ${key}`);
  return value;
};
const iso = (value: unknown): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid instant");
  return parsed.toISOString();
};
const date = (value: unknown): string => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error("invalid date");
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
                  lyrics_revision, learning_language, target_language, learner_band,
                  language_profile_revision,
                  study_profile_revision, source_set_revision, selection_policy_revision,
                  qualification_policy_revision, timezone, status, created_at, completed_at
                  , current_session_item_id, current_presented_at, presentation_count,
                  completion_reason
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
  const lessonRows = yield* db.execute<Row>({
    label: "study-v2.lesson.read",
    text: `SELECT count(*) FILTER (WHERE lesson_resolved)::bigint AS resolved_count,
                  coalesce(max(presentation_count) FILTER (
                    WHERE session_item_id=$2
                  ), 0)::bigint AS current_presentation_count
             FROM study_lesson_item_state_v2 WHERE session_id=$1`,
    values: [input.sessionId, row.current_session_item_id],
    readonly: true,
  });
  const lesson = lessonRows.rows[0] as Row;
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
          target_language: nullableText(row, "target_language"),
        },
        learner_band: nullableText(row, "learner_band"),
        study_profile_revision: integer(row, "study_profile_revision"),
        language_profile_revision:
          row.language_profile_revision === null ? null : integer(row, "language_profile_revision"),
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
        lesson: {
          current:
            row.current_session_item_id === null
              ? null
              : {
                  session_item_id: text(row, "current_session_item_id"),
                  presentation_number: integer(lesson, "current_presentation_count") + 1,
                  is_reappearance: integer(lesson, "current_presentation_count") > 0,
                  presented_at: iso(row.current_presented_at),
                },
          resolved_card_count: integer(lesson, "resolved_count"),
          total_card_count: count,
          presentation_count: integer(row, "presentation_count"),
          presentation_cap: Math.min(20, 3 * count),
          completion_reason: nullableText(row, "completion_reason"),
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
    accountId: string;
    communityId: string;
    postId: string;
    targetLanguage: string | null;
    learnerBand: string | null;
  },
) =>
  db.execute<Row>({
    label: "study-v2.exercises.select",
    text: `WITH latest AS (
            SELECT DISTINCT ON (exercise.exercise_review_key)
              exercise.exercise_version_id, exercise.exercise_review_key,
              exercise.exercise_type, exercise.exercise_variant, exercise.community_id,
              exercise.post_id, exercise.audio_revision, exercise.lyrics_revision,
              exercise.lyric_line_id, exercise.line_version, exercise.line_source_hash,
              exercise.study_unit_id, exercise.learning_language, exercise.target_language,
              exercise.learner_band, coalesce(exercise.language_profile_revision, (
                SELECT max(profile.language_profile_revision)
                  FROM study_language_profiles profile
                 WHERE profile.community_id=exercise.community_id
                   AND profile.post_id=exercise.post_id
                   AND profile.lyrics_revision=exercise.lyrics_revision
              )) AS language_profile_revision,
              exercise.presentation, exercise.answer_visibility, exercise.feedback_release,
              exercise.grader_policy_revision, exercise.feedback_policy_revision,
              exercise.quality_policy_revision, membership.ordinal
            FROM study_exercise_versions exercise
            JOIN media_publication_projections publication
              ON publication.community_id=exercise.community_id
             AND publication.post_id=exercise.post_id
            JOIN media_post_submissions submission
              ON submission.submission_id=publication.submission_id
             AND submission.audio_revision=exercise.audio_revision
             AND submission.current_lyrics_revision=exercise.lyrics_revision
            JOIN localization_lyrics_revision_lines membership
              ON membership.community_id=exercise.community_id
             AND membership.post_id=exercise.post_id
             AND membership.lyrics_revision=exercise.lyrics_revision
             AND membership.lyric_line_id=exercise.lyric_line_id
           WHERE exercise.community_id=$1 AND exercise.post_id=$2
             AND exercise.learner_band IS NOT DISTINCT FROM $3
             AND exercise.retired_at IS NULL
             AND ((exercise.exercise_type='translation_choice' AND exercise.target_language=$4)
               OR (exercise.exercise_type='say_it_back' AND exercise.target_language IS NULL))
           ORDER BY exercise.exercise_review_key, exercise.content_revision DESC
          )
          SELECT latest.*
            FROM latest
       LEFT JOIN study_review_items review
              ON review.account_id=$5 AND review.post_id=latest.post_id
             AND review.study_unit_id=latest.study_unit_id
             AND review.exercise_kind=latest.exercise_type
             AND review.learning_language=latest.learning_language
             AND review.target_language IS NOT DISTINCT FROM latest.target_language
             AND review.learner_band IS NOT DISTINCT FROM latest.learner_band
             AND review.lifecycle_status='active'
           WHERE review.review_item_id IS NULL OR review.due_at <= clock_timestamp()
        ORDER BY CASE WHEN review.review_item_id IS NOT NULL THEN 0 ELSE 1 END,
                 review.due_at NULLS LAST, latest.ordinal, latest.exercise_review_key
           LIMIT 10`,
    values: [
      input.communityId,
      input.postId,
      input.learnerBand,
      input.targetLanguage,
      input.accountId,
    ],
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
      study_unit_id: text(row, "study_unit_id"),
      line_version: integer(row, "line_version"),
      line_source_hash: text(row, "line_source_hash"),
    },
    languages: {
      learning_language: text(row, "learning_language"),
      target_language: nullableText(row, "target_language"),
    },
    learner_band: nullableText(row, "learner_band"),
    language_profile_revision:
      row.language_profile_revision === null ? null : integer(row, "language_profile_revision"),
    presentation: json(row.presentation),
    answer_visibility: text(row, "answer_visibility"),
    feedback_release: text(row, "feedback_release"),
    grader_policy_revision: text(row, "grader_policy_revision"),
    feedback_policy_revision: text(row, "feedback_policy_revision"),
    quality_policy_revision: text(row, "quality_policy_revision"),
    maximum_attempts: 3,
  });

export const makeControlPlaneStudyV2Repository = () => ({
  getAvailability: (input: Parameters<StudyV2Store["getAvailability"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const rows = yield* db.execute<Row>({
          label: "study-v2.availability",
          text: `SELECT exercise.exercise_type, exercise.target_language,
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
                  GROUP BY exercise.exercise_type, exercise.target_language, exercise.learner_band`,
          values: [input.communityId, input.postId],
          readonly: true,
        });
        const sourceByBand = new Map<string, number>();
        const translatedByBandAndHelper = new Map<string, number>();
        for (const row of rows.rows) {
          const band = nullableText(row, "learner_band") ?? "source";
          const count = integer(row, "count");
          const helper = nullableText(row, "target_language");
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
          target_languages: [
            ...new Set(
              rows.rows.flatMap((row) => {
                const value = nullableText(row, "target_language");
                return value === null ? [] : [value];
              }),
            ),
          ],
          learner_bands: [
            ...new Set(
              rows.rows.flatMap((row) => {
                const value = nullableText(row, "learner_band");
                return value === null ? [] : [value];
              }),
            ),
          ],
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
              accountId: input.accountId,
              communityId: input.communityId,
              postId: input.postId,
              targetLanguage: input.targetLanguage,
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
                lyrics_revision, learning_language, target_language, learner_band,
                study_profile_revision, source_set_revision, selection_policy_revision,
                qualification_policy_revision, timezone, idempotency_key, request_hash, created_at,
                current_session_item_id, current_presented_at, language_profile_revision
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,'en',$8,$9,1,1,
                'study_selection_v1','study_session_first_pass_v2@1',$10,$11,$12,$13::timestamptz,
                $14,$13::timestamptz,$15)`,
              values: [
                input.sessionId,
                input.accountId,
                input.personaId,
                input.communityId,
                input.postId,
                integer(first, "audio_revision"),
                integer(first, "lyrics_revision"),
                input.targetLanguage,
                input.learnerBand,
                input.timezone,
                input.idempotencyKey,
                input.requestHash,
                input.createdAt,
                items[0]?.session_item_id,
                first.language_profile_revision === null
                  ? null
                  : integer(first, "language_profile_revision"),
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
                  scheduler_policy_revision, scheduler_state, community_id, post_id,
                  study_unit_id, exercise_kind, learning_language, target_language, learner_band
                ) VALUES ($1,$2,$3,$4,'study_review_schedule_v1','{}'::jsonb,
                  $5,$6,$7,$8,$9,$10,$11)
                ON CONFLICT (account_id, exercise_review_key) DO UPDATE SET
                  current_exercise_version_id=excluded.current_exercise_version_id,
                  updated_at=clock_timestamp()`,
                values: [
                  reviewId,
                  input.accountId,
                  item.exercise_review_key,
                  item.exercise_version_id,
                  input.communityId,
                  input.postId,
                  item.line.study_unit_id,
                  item.exercise_type,
                  item.languages.learning_language,
                  item.languages.target_language,
                  item.learner_band,
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
                ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,3,$8)`,
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
              yield* transaction.execute({
                label: "study-v2.lesson-item.insert",
                text: `INSERT INTO study_lesson_item_state_v2 (
                         session_item_id, session_id, original_ordinal
                       ) VALUES ($1,$2,$3)`,
                values: [item.session_item_id, input.sessionId, ordinal],
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
  loadSpokenAnswerContext: (input: Parameters<StudyV2Store["loadSpokenAnswerContext"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const selected = yield* db.execute<Row>({
          label: "study-v2.spoken.context",
          text: `SELECT i.item_snapshot, e.private_grader, profile.dominant_language,
                        profile.mixed, profile.confidence
                   FROM study_session_items_v2 i
                   JOIN study_sessions_v2 s ON s.session_id=i.session_id AND s.account_id=i.account_id
                   JOIN study_exercise_versions e ON e.exercise_version_id=i.exercise_version_id
              LEFT JOIN study_language_profile_units profile
                     ON profile.community_id=s.community_id AND profile.post_id=s.post_id
                    AND profile.lyrics_revision=s.lyrics_revision
                    AND profile.language_profile_revision=s.language_profile_revision
                    AND profile.study_unit_id=e.study_unit_id
                  WHERE i.session_item_id=$1 AND i.session_id=$2 AND i.account_id=$3
                    AND s.community_id=$4 AND (
                      (s.status='active' AND s.expires_at > clock_timestamp()
                        AND s.current_session_item_id=i.session_item_id)
                      OR EXISTS (
                        SELECT 1 FROM study_spoken_answer_commands replay
                         WHERE replay.session_id=s.session_id
                           AND replay.session_item_id=i.session_item_id
                           AND replay.account_id=s.account_id
                           AND replay.idempotency_key=$5 AND replay.state='completed'
                      )
                    )`,
          values: [
            input.sessionItemId,
            input.sessionId,
            input.accountId,
            input.communityId,
            input.idempotencyKey,
          ],
          readonly: true,
        });
        if (selected.rows.length !== 1) return yield* rejected("not-found");
        const row = selected.rows[0] as Row;
        const item = decode(StudySessionItemV2, json(row.item_snapshot));
        const grader = json(row.private_grader) as Record<string, unknown>;
        if (
          item.exercise_type !== "say_it_back" ||
          grader.kind !== "source_token_diff_v1" ||
          typeof grader.reference_text !== "string"
        ) {
          return yield* rejected("submission-kind-mismatch");
        }
        return {
          item,
          referenceText: grader.reference_text,
          dominantLanguage:
            row.mixed === false && row.confidence !== null && number(row, "confidence") >= 0.8
              ? nullableText(row, "dominant_language")
              : null,
        };
      }),
    ),
  reserveSpokenAnswer: (input: Parameters<StudyV2Store["reserveSpokenAnswer"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const selected = yield* transaction.execute<Row>({
              label: "study-v2.spoken.reserve-item",
              text: `SELECT i.item_snapshot, state.presentation_count
                       FROM study_session_items_v2 i
                       JOIN study_sessions_v2 s
                         ON s.session_id=i.session_id AND s.account_id=i.account_id
                       JOIN study_lesson_item_state_v2 state
                         ON state.session_item_id=i.session_item_id
                      WHERE i.session_item_id=$1 AND i.session_id=$2 AND i.account_id=$3
                        AND s.status='active' AND s.expires_at > clock_timestamp()
                        AND s.current_session_item_id=i.session_item_id FOR UPDATE OF i, s`,
              values: [input.sessionItemId, input.sessionId, input.accountId],
              readonly: false,
            });
            if (selected.rows.length !== 1) return yield* rejected("not-found");
            const item = decode(StudySessionItemV2, json((selected.rows[0] as Row).item_snapshot));
            if (item.exercise_type !== "say_it_back") {
              return yield* rejected("submission-kind-mismatch");
            }
            if (
              input.attemptNumber !==
              integer(selected.rows[0] as Row, "presentation_count") + 1
            ) {
              return yield* rejected("attempt-conflict");
            }
            const replay = yield* transaction.execute<Row>({
              label: "study-v2.spoken.reserve-existing",
              text: `SELECT command_id, request_hash, audio_digest, state, result_snapshot,
                            attempt_id, learner_audio_artifact_id,
                            lease_expires_at > clock_timestamp() AS lease_live
                       FROM study_spoken_answer_commands
                      WHERE session_id=$1 AND (
                        idempotency_key=$2 OR (session_item_id=$3 AND attempt_number=$4)
                      ) FOR UPDATE`,
              values: [
                input.sessionId,
                input.idempotencyKey,
                input.sessionItemId,
                input.attemptNumber,
              ],
              readonly: false,
            });
            if (replay.rows.length > 1) return yield* rejected("idempotency-conflict");
            const replayRow = replay.rows[0] as Row | undefined;
            if (replayRow !== undefined) {
              if (
                text(replayRow, "request_hash") !== input.requestHash ||
                text(replayRow, "audio_digest") !== input.audioDigest
              ) {
                return yield* rejected("idempotency-conflict");
              }
              if (text(replayRow, "state") === "completed") {
                return {
                  state: "completed" as const,
                  result: decode(StudyAnswerResultV2, json(replayRow.result_snapshot)),
                };
              }
              if (text(replayRow, "state") === "reserved" && replayRow.lease_live === true) {
                return yield* rejected("command-in-flight");
              }
            }
            const attempts = yield* transaction.execute<Row>({
              label: "study-v2.spoken.reserve-attempt",
              text: `SELECT count(*)::bigint AS count FROM study_attempts_v2
                      WHERE session_item_id=$1`,
              values: [input.sessionItemId],
              readonly: false,
            });
            if (input.attemptNumber !== integer(attempts.rows[0] as Row, "count") + 1) {
              return yield* rejected("attempt-conflict");
            }
            if (replayRow !== undefined) {
              const commandId = text(replayRow, "command_id");
              const reclaimed = yield* transaction.execute<Row>({
                label: "study-v2.spoken.reserve-retry",
                text: `UPDATE study_spoken_answer_commands
                          SET state='reserved', provider_failure_kind=NULL, completed_at=NULL,
                              lease_token=$3,
                              lease_expires_at=clock_timestamp() + interval '60 seconds',
                              reserved_at=clock_timestamp()
                        WHERE command_id=$1 AND account_id=$2
                          AND (state='retryable_failed' OR
                            (state='reserved' AND lease_expires_at <= clock_timestamp()))
                    RETURNING command_id`,
                values: [commandId, input.accountId, input.leaseToken],
                readonly: false,
              });
              if (reclaimed.rows.length !== 1) return yield* rejected("command-in-flight");
              yield* transaction.execute({
                label: "study-v2.spoken.reserve-artifact-retry",
                text: `UPDATE learner_audio_artifacts
                          SET recording_state='pending', object_ref=NULL, deleted_at=NULL
                        WHERE learner_audio_artifact_id=$1 AND account_id=$2
                          AND recording_state='failed'`,
                values: [text(replayRow, "learner_audio_artifact_id"), input.accountId],
                readonly: false,
              });
              return {
                state: "reserved" as const,
                commandId,
                leaseToken: input.leaseToken,
                attemptId: text(replayRow, "attempt_id"),
                artifactId: text(replayRow, "learner_audio_artifact_id"),
              };
            }
            const inserted = yield* transaction.execute<Row>({
              label: "study-v2.spoken.reserve-insert",
              text: `INSERT INTO study_spoken_answer_commands (
                       command_id, account_id, session_id, session_item_id, attempt_number,
                       idempotency_key, request_hash, audio_digest, audio_content_type,
                       audio_byte_size, audio_duration_ms, attempt_id,
                       learner_audio_artifact_id, lease_token, lease_expires_at, state
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                       clock_timestamp() + interval '60 seconds','reserved')
                     ON CONFLICT DO NOTHING RETURNING command_id`,
              values: [
                input.commandId,
                input.accountId,
                input.sessionId,
                input.sessionItemId,
                input.attemptNumber,
                input.idempotencyKey,
                input.requestHash,
                input.audioDigest,
                input.audioContentType,
                input.audioByteSize,
                input.audioDurationMs,
                input.attemptId,
                input.artifactId,
                input.leaseToken,
              ],
              readonly: false,
            });
            if (inserted.rows.length === 1) {
              const expectedObjectRef = `learner-audio/study/${input.attemptId}/${input.audioDigest}`;
              yield* transaction.execute({
                label: "study-v2.spoken.reserve-artifact",
                text: `INSERT INTO learner_audio_artifacts (
                         learner_audio_artifact_id, account_id, source_kind, attempt_ref,
                         expected_object_ref, object_ref, content_digest, content_type,
                         byte_size, duration_ms, platform_retention, provider_retention,
                         recording_state, expires_at
                       ) VALUES ($1,$2,'study',$3,$4,NULL,$5,$6,$7,$8,
                         'private_learning','not_stored','pending',
                         clock_timestamp() + interval '24 months')`,
                values: [
                  input.artifactId,
                  input.accountId,
                  input.attemptId,
                  expectedObjectRef,
                  input.audioDigest,
                  input.audioContentType,
                  input.audioByteSize,
                  input.audioDurationMs,
                ],
                readonly: false,
              });
              return {
                state: "reserved" as const,
                commandId: input.commandId,
                leaseToken: input.leaseToken,
                attemptId: input.attemptId,
                artifactId: input.artifactId,
              };
            }
            const existing = yield* transaction.execute<Row>({
              label: "study-v2.spoken.reserve-replay",
              text: `SELECT command_id, request_hash, audio_digest, state, result_snapshot,
                            attempt_id, learner_audio_artifact_id,
                            lease_expires_at > clock_timestamp() AS lease_live
                       FROM study_spoken_answer_commands
                      WHERE session_id=$1 AND (
                        idempotency_key=$2 OR (session_item_id=$3 AND attempt_number=$4)
                      ) FOR UPDATE`,
              values: [
                input.sessionId,
                input.idempotencyKey,
                input.sessionItemId,
                input.attemptNumber,
              ],
              readonly: false,
            });
            if (existing.rows.length !== 1) return yield* rejected("idempotency-conflict");
            const row = existing.rows[0] as Row;
            if (
              text(row, "request_hash") !== input.requestHash ||
              text(row, "audio_digest") !== input.audioDigest
            ) {
              return yield* rejected("idempotency-conflict");
            }
            const commandId = text(row, "command_id");
            const state = text(row, "state");
            if (state === "completed") {
              return {
                state: "completed" as const,
                result: decode(StudyAnswerResultV2, json(row.result_snapshot)),
              };
            }
            if (state === "reserved" && row.lease_live === true)
              return yield* rejected("command-in-flight");
            const reclaimed = yield* transaction.execute<Row>({
              label: "study-v2.spoken.reserve-retry",
              text: `UPDATE study_spoken_answer_commands
                        SET state='reserved', provider_failure_kind=NULL, completed_at=NULL,
                            lease_token=$3,
                            lease_expires_at=clock_timestamp() + interval '60 seconds',
                            reserved_at=clock_timestamp()
                      WHERE command_id=$1 AND account_id=$2
                        AND (state='retryable_failed' OR
                          (state='reserved' AND lease_expires_at <= clock_timestamp()))
                  RETURNING command_id`,
              values: [commandId, input.accountId, input.leaseToken],
              readonly: false,
            });
            if (reclaimed.rows.length !== 1) return yield* rejected("command-in-flight");
            yield* transaction.execute({
              label: "study-v2.spoken.reserve-artifact-retry",
              text: `UPDATE learner_audio_artifacts
                        SET recording_state='pending', object_ref=NULL, deleted_at=NULL
                      WHERE learner_audio_artifact_id=$1 AND account_id=$2
                        AND recording_state='failed'`,
              values: [text(row, "learner_audio_artifact_id"), input.accountId],
              readonly: false,
            });
            return {
              state: "reserved" as const,
              commandId,
              leaseToken: input.leaseToken,
              attemptId: text(row, "attempt_id"),
              artifactId: text(row, "learner_audio_artifact_id"),
            };
          }),
        );
      }),
    ),
  failSpokenAnswer: (input: Parameters<StudyV2Store["failSpokenAnswer"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const updated = yield* db.execute({
          label: "study-v2.spoken.fail",
          text: `UPDATE study_spoken_answer_commands
                    SET state='retryable_failed', provider_failure_kind=$3,
                        completed_at=$4::timestamptz
                  WHERE command_id=$1 AND account_id=$2 AND lease_token=$5
                    AND state='reserved' AND lease_expires_at > clock_timestamp()`,
          values: [
            input.commandId,
            input.accountId,
            input.providerFailureKind,
            input.failedAt,
            input.leaseToken,
          ],
          readonly: false,
        });
        if (updated.rowCount !== 1) return yield* rejected("command-in-flight");
        yield* db.execute({
          label: "study-v2.spoken.fail-artifact",
          text: `UPDATE learner_audio_artifacts artifact
                    SET recording_state='failed'
                   FROM study_spoken_answer_commands command
                  WHERE command.command_id=$1 AND command.account_id=$2
                    AND artifact.learner_audio_artifact_id=command.learner_audio_artifact_id
                    AND artifact.recording_state='pending'`,
          values: [input.commandId, input.accountId],
          readonly: false,
        });
      }),
    ),
  completeSpokenAnswer: (input: Parameters<StudyV2Store["completeSpokenAnswer"]>[0]) =>
    mapErrors(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const command = yield* transaction.execute<Row>({
              label: "study-v2.spoken.complete-command",
              text: `SELECT request_hash, state, result_snapshot, lease_token,
                            lease_expires_at > clock_timestamp() AS lease_live
                       FROM study_spoken_answer_commands
                      WHERE command_id=$1 AND account_id=$2 FOR UPDATE`,
              values: [input.commandId, input.accountId],
              readonly: false,
            });
            if (command.rows.length !== 1) return yield* rejected("not-found");
            const commandRow = command.rows[0] as Row;
            if (text(commandRow, "request_hash") !== input.requestHash) {
              return yield* rejected("idempotency-conflict");
            }
            if (text(commandRow, "state") === "completed") {
              return decode(StudyAnswerResultV2, json(commandRow.result_snapshot));
            }
            if (text(commandRow, "state") !== "reserved") {
              return yield* rejected("command-in-flight");
            }
            if (text(commandRow, "lease_token") !== input.leaseToken) {
              return yield* rejected("command-in-flight");
            }
            if (commandRow.lease_live !== true) {
              return yield* rejected("command-in-flight");
            }
            const selected = yield* transaction.execute<Row>({
              label: "study-v2.spoken.complete-item",
              text: `SELECT i.item_snapshot, i.review_item_id, s.post_id,
                            s.current_session_item_id, s.current_presented_at,
                            s.presentation_count AS session_presentation_count,
                            state.presentation_count AS item_presentation_count,
                            review.difficulty, review.lapses, review.repetitions, review.stability
                       FROM study_session_items_v2 i
                       JOIN study_sessions_v2 s
                         ON s.session_id=i.session_id AND s.account_id=i.account_id
                       JOIN study_lesson_item_state_v2 state
                         ON state.session_item_id=i.session_item_id
                       JOIN study_review_items review ON review.review_item_id=i.review_item_id
                      WHERE i.session_item_id=$1 AND i.session_id=$2 AND i.account_id=$3
                        AND s.community_id=$4 AND s.status='active' FOR UPDATE OF i, s`,
              values: [input.sessionItemId, input.sessionId, input.accountId, input.communityId],
              readonly: false,
            });
            if (selected.rows.length !== 1) return yield* rejected("not-found");
            const selectedRow = selected.rows[0] as Row;
            const item = decode(StudySessionItemV2, json(selectedRow.item_snapshot));
            if (item.exercise_type !== "say_it_back") {
              return yield* rejected("submission-kind-mismatch");
            }
            if (text(selectedRow, "current_session_item_id") !== input.sessionItemId) {
              return yield* rejected("attempt-conflict");
            }
            if (input.attemptNumber !== integer(selectedRow, "item_presentation_count") + 1) {
              return yield* rejected("attempt-conflict");
            }
            const artifact = yield* transaction.execute<Row>({
              label: "study-v2.spoken.artifact",
              text: `UPDATE learner_audio_artifacts
                        SET object_ref=$3, recording_state=$4
                      WHERE learner_audio_artifact_id=$1 AND account_id=$2
                        AND recording_state='pending'
                        AND (($4='stored' AND $3=expected_object_ref)
                          OR ($4='failed' AND $3 IS NULL))
                    RETURNING learner_audio_artifact_id`,
              values: [
                input.artifactId,
                input.accountId,
                input.archive.objectRef,
                input.archive.state,
              ],
              readonly: false,
            });
            if (artifact.rows.length !== 1) return yield* rejected("command-in-flight");
            const feedback = {
              kind: "transcript_diff" as const,
              heard_transcript: input.grade.heardTranscript,
              matched: input.grade.matched,
              missing: input.grade.missing,
              extra: input.grade.extra,
              substituted: input.grade.substituted.map(({ expected, heard }) => ({
                expected,
                heard,
              })),
              policy_revision: input.grade.policyRevision,
            };
            const tokenDiff = {
              matched: input.grade.matched.map(({ position }) => position),
              missing: input.grade.missing.map(({ position }) => position),
              extra: input.grade.extra,
              substituted: input.grade.substituted.map(({ expected, heard }) => ({
                expected_position: expected.position,
                heard,
              })),
            };
            yield* transaction.execute({
              label: "study-v2.spoken.attempt",
              text: `INSERT INTO study_attempts_v2 (
                       attempt_id, session_item_id, attempt_number, submission_kind,
                       submission_evidence, outcome, first_pass, attempt_state, feedback_kind,
                       feedback_evidence, grader_policy_revision, feedback_policy_revision,
                       accepted_at, idempotency_key, request_hash, study_unit_id, exercise_kind,
                       learning_language, target_language, learner_band, source_line_revision,
                       language_profile_revision, localization_revision, grading_revision,
                       review_schedule_version, presented_at, answered_at, audio_byte_size,
                       audio_duration_ms, provider_detected_language,
                       provider_detected_language_confidence, token_diff,
                       learner_audio_artifact_id
                     ) VALUES ($1,$2,$3,'raw_audio',$4::jsonb,$5,$6,'spent',
                       'transcript_diff',$7::jsonb,$8,$9,$10::timestamptz,$11,$12,$13,
                       'say_it_back',$14,NULL,NULL,$15,$16,NULL,$17,'study_review_schedule_v1',
                       $24::timestamptz,$10::timestamptz,$18,$19,$20,$21,$22::jsonb,$23)`,
              values: [
                input.attemptId,
                input.sessionItemId,
                input.attemptNumber,
                JSON.stringify({
                  audio_digest: input.audioDigest,
                  learner_audio_artifact_id: input.artifactId,
                }),
                input.grade.correct ? "correct" : "incorrect",
                input.attemptNumber === 1,
                JSON.stringify(feedback),
                item.grader_policy_revision,
                item.feedback_policy_revision,
                input.acceptedAt,
                input.commandId,
                input.requestHash,
                item.line.study_unit_id,
                item.languages.learning_language,
                item.line.line_version,
                item.language_profile_revision,
                item.grader_policy_revision,
                input.audioByteSize,
                input.audioDurationMs,
                input.providerDetectedLanguage,
                input.providerDetectedLanguageConfidence,
                JSON.stringify(tokenDiff),
                input.artifactId,
                iso(selectedRow.current_presented_at),
              ],
              readonly: false,
            });
            const queueOrdinal = integer(selectedRow, "session_presentation_count");
            yield* transaction.execute({
              label: "study-v2.spoken.presentation",
              text: `INSERT INTO study_presentations_v2 (
                       presentation_id, session_id, session_item_id, presentation_number,
                       queue_ordinal, presented_at, answered_at, outcome
                     ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8)`,
              values: [
                `study-presentation-${input.attemptId}`,
                input.sessionId,
                input.sessionItemId,
                input.attemptNumber,
                queueOrdinal,
                iso(selectedRow.current_presented_at),
                input.acceptedAt,
                input.grade.correct ? "correct" : "incorrect",
              ],
              readonly: false,
            });
            const reviewGrade = input.grade.correct
              ? input.attemptNumber === 1
                ? "good"
                : "hard"
              : "again";
            const review = scheduleStudyReviewV1(
              {
                difficulty: number(selectedRow, "difficulty"),
                lapses: integer(selectedRow, "lapses"),
                repetitions: integer(selectedRow, "repetitions"),
                reviewedAt: Date.parse(input.acceptedAt),
                stability: number(selectedRow, "stability"),
              },
              reviewGrade,
            );
            yield* transaction.execute({
              label: "study-v2.spoken.review",
              text: `UPDATE study_review_items
                        SET difficulty=$2, due_at=$3::timestamptz, lapses=$4,
                            repetitions=$5, stability=$6, review_state=$7,
                            last_reviewed_at=$8::timestamptz, updated_at=$8::timestamptz,
                            scheduler_state=$9::jsonb
                      WHERE review_item_id=$1`,
              values: [
                text(selectedRow, "review_item_id"),
                review.difficulty,
                new Date(review.dueAt).toISOString(),
                review.lapses,
                review.repetitions,
                review.stability,
                review.state,
                input.acceptedAt,
                JSON.stringify({
                  difficulty: review.difficulty,
                  due_at: new Date(review.dueAt).toISOString(),
                  lapses: review.lapses,
                  repetitions: review.repetitions,
                  stability: review.stability,
                  state: review.state,
                }),
              ],
              readonly: false,
            });
            const resolved = input.grade.correct || input.attemptNumber >= 3;
            yield* transaction.execute({
              label: "study-v2.spoken.lesson-item",
              text: `UPDATE study_lesson_item_state_v2
                        SET presentation_count=$2, last_queue_ordinal=$3, mastered=$4,
                            lesson_resolved=$5, updated_at=$6::timestamptz
                      WHERE session_item_id=$1 AND presentation_count=$2-1`,
              values: [
                input.sessionItemId,
                input.attemptNumber,
                queueOrdinal,
                input.grade.correct,
                resolved,
                input.acceptedAt,
              ],
              readonly: false,
            });
            const remaining = yield* transaction.execute<Row>({
              label: "study-v2.spoken.completion-check",
              text: `SELECT count(*) FILTER (WHERE NOT lesson_resolved)::bigint AS count,
                            count(*)::bigint AS total
                       FROM study_lesson_item_state_v2 WHERE session_id=$1`,
              values: [input.sessionId],
              readonly: false,
            });
            const remainingRow = remaining.rows[0] as Row;
            const nextPresentationCount = queueOrdinal + 1;
            const presentationCap = Math.min(20, 3 * integer(remainingRow, "total"));
            const complete =
              integer(remainingRow, "count") === 0 || nextPresentationCount >= presentationCap;
            if (complete) {
              const completed = yield* transaction.execute<Row>({
                label: "study-v2.spoken.session-complete",
                text: `UPDATE study_sessions_v2 SET status='completed',
                        completed_at=$2::timestamptz, presentation_count=$3,
                        completion_reason=$4, current_session_item_id=NULL,
                        current_presented_at=NULL
                        WHERE session_id=$1 AND status='active'
                    RETURNING persona_id, community_id, post_id, audio_revision,
                              qualification_policy_revision, timezone,
                              ($2::timestamptz AT TIME ZONE timezone)::date AS streak_day`,
                values: [
                  input.sessionId,
                  input.acceptedAt,
                  nextPresentationCount,
                  integer(remainingRow, "count") === 0 ? "all_resolved" : "presentation_budget",
                ],
                readonly: false,
              });
              if (completed.rows.length === 1) {
                const progress = yield* transaction.execute<Row>({
                  label: "study-v2.spoken.qualification-progress",
                  text: `SELECT count(*)::bigint AS exercise_count,
                                count(*) FILTER (WHERE EXISTS (
                                  SELECT 1 FROM study_attempts_v2 presented
                                   WHERE presented.session_item_id=item.session_item_id
                                ))::bigint AS presented_count,
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
                const presentedCount = integer(progressRow, "presented_count");
                const firstPassCorrect = integer(progressRow, "first_pass_correct");
                const requiredCorrect = Math.max(1, Math.ceil((7 * exerciseCount) / 10));
                if (presentedCount === exerciseCount && firstPassCorrect >= requiredCorrect) {
                  const terminal = completed.rows[0] as Row;
                  yield* transaction.execute({
                    label: "study-v2.spoken.qualification-insert",
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
                      date(terminal.streak_day),
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
                    streakDay: date(terminal.streak_day),
                    timezone: text(terminal, "timezone"),
                  }).pipe(Effect.mapError(() => failed("constraint")));
                }
              }
            } else {
              const next = yield* transaction.execute<Row>({
                label: "study-v2.spoken.next-item",
                text: `SELECT session_item_id
                         FROM study_lesson_item_state_v2
                        WHERE session_id=$1 AND NOT lesson_resolved
                     ORDER BY CASE WHEN presentation_count=0 THEN 0 ELSE 1 END,
                              last_queue_ordinal NULLS FIRST, original_ordinal
                        LIMIT 1`,
                values: [input.sessionId],
                readonly: false,
              });
              if (next.rows.length !== 1) return yield* Effect.fail(failed("invalid-row"));
              yield* transaction.execute({
                label: "study-v2.spoken.session-advance",
                text: `UPDATE study_sessions_v2
                          SET current_session_item_id=$2, current_presented_at=$3::timestamptz,
                              presentation_count=$4
                        WHERE session_id=$1 AND status='active'`,
                values: [
                  input.sessionId,
                  text(next.rows[0] as Row, "session_item_id"),
                  input.acceptedAt,
                  nextPresentationCount,
                ],
                readonly: false,
              });
            }
            const session = yield* readSession(transaction, input);
            if (session === null) return yield* rejected("not-found");
            const result = decode(StudyAnswerResultV2, {
              object: "study_answer_result_v2",
              session_item_id: input.sessionItemId,
              attempt_number: input.attemptNumber,
              exercise_type: "say_it_back",
              outcome: input.grade.correct ? "correct" : "incorrect",
              first_pass: input.attemptNumber === 1,
              attempt_state: "spent",
              feedback,
              session,
            });
            yield* transaction.execute({
              label: "study-v2.spoken.command-complete",
              text: `UPDATE study_spoken_answer_commands
                        SET state='completed', result_snapshot=$3::jsonb,
                            completed_at=$4::timestamptz
                      WHERE command_id=$1 AND account_id=$2 AND state='reserved'
                        AND lease_token=$5`,
              values: [
                input.commandId,
                input.accountId,
                JSON.stringify(result),
                input.acceptedAt,
                input.leaseToken,
              ],
              readonly: false,
            });
            return result;
          }),
        );
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
              text: `SELECT i.item_snapshot, i.maximum_attempts, i.review_item_id,
                            e.private_grader, e.content_revision,
                            s.current_session_item_id, s.current_presented_at,
                            s.presentation_count AS session_presentation_count,
                            state.presentation_count AS item_presentation_count,
                            review.difficulty, review.lapses, review.repetitions, review.stability
                       FROM study_session_items_v2 i
                       JOIN study_sessions_v2 s ON s.session_id=i.session_id AND s.account_id=i.account_id
                       JOIN study_exercise_versions e ON e.exercise_version_id=i.exercise_version_id
                       JOIN study_lesson_item_state_v2 state
                         ON state.session_item_id=i.session_item_id
                       JOIN study_review_items review ON review.review_item_id=i.review_item_id
                      WHERE i.session_item_id=$1 AND i.session_id=$2 AND i.account_id=$3
                        AND s.community_id=$4 AND s.status='active' FOR UPDATE OF i, s`,
              values: [input.sessionItemId, input.sessionId, input.accountId, input.communityId],
              readonly: false,
            });
            if (selected.rows.length !== 1) return yield* rejected("not-found");
            const row = selected.rows[0] as Row;
            const item = json(row.item_snapshot) as StudySessionItemV2;
            const grader = json(row.private_grader) as Record<string, unknown>;
            if (item.exercise_type !== "translation_choice") {
              return yield* rejected("submission-kind-mismatch");
            }
            if (text(row, "current_session_item_id") !== input.sessionItemId) {
              return yield* rejected("attempt-conflict");
            }
            if (input.attemptNumber !== integer(row, "item_presentation_count") + 1) {
              return yield* rejected("attempt-conflict");
            }
            const correct = gradeExactChoiceV2(
              input.answer.choice_key,
              String(grader.correct_choice_key),
            );
            const spent = correct || input.attemptNumber >= integer(row, "maximum_attempts");
            const feedback = !spent
              ? { kind: "none" as const }
              : {
                  kind: "choice_reveal" as const,
                  correct_choice_key: String(grader.correct_choice_key),
                  correct_text: String(grader.correct_text),
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
                idempotency_key, request_hash, study_unit_id, exercise_kind,
                learning_language, target_language, learner_band, source_line_revision,
                language_profile_revision, localization_revision, grading_revision,
                review_schedule_version, presented_at, answered_at
              ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,
                $13::timestamptz,$14,$15,$16,'translation_choice',$17,$18,$19,$20,$21,$22,
                $23,'study_review_schedule_v1',$24::timestamptz,$13::timestamptz)`,
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
                item.line.study_unit_id,
                item.languages.learning_language,
                item.languages.target_language,
                item.learner_band,
                item.line.line_version,
                item.language_profile_revision,
                integer(row, "content_revision"),
                item.grader_policy_revision,
                iso(row.current_presented_at),
              ],
              readonly: false,
            });
            const queueOrdinal = integer(row, "session_presentation_count");
            yield* transaction.execute({
              label: "study-v2.answer.presentation",
              text: `INSERT INTO study_presentations_v2 (
                       presentation_id, session_id, session_item_id, presentation_number,
                       queue_ordinal, presented_at, answered_at, outcome
                     ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8)`,
              values: [
                `study-presentation-${input.attemptId}`,
                input.sessionId,
                input.sessionItemId,
                input.attemptNumber,
                queueOrdinal,
                iso(row.current_presented_at),
                input.acceptedAt,
                correct ? "correct" : "incorrect",
              ],
              readonly: false,
            });
            const review = scheduleStudyReviewV1(
              {
                difficulty: number(row, "difficulty"),
                lapses: integer(row, "lapses"),
                repetitions: integer(row, "repetitions"),
                reviewedAt: Date.parse(input.acceptedAt),
                stability: number(row, "stability"),
              },
              correct ? (input.attemptNumber === 1 ? "good" : "hard") : "again",
            );
            yield* transaction.execute({
              label: "study-v2.answer.review",
              text: `UPDATE study_review_items
                        SET difficulty=$2, due_at=$3::timestamptz, lapses=$4,
                            repetitions=$5, stability=$6, review_state=$7,
                            last_reviewed_at=$8::timestamptz, updated_at=$8::timestamptz,
                            scheduler_state=$9::jsonb
                      WHERE review_item_id=$1`,
              values: [
                text(row, "review_item_id"),
                review.difficulty,
                new Date(review.dueAt).toISOString(),
                review.lapses,
                review.repetitions,
                review.stability,
                review.state,
                input.acceptedAt,
                JSON.stringify({
                  difficulty: review.difficulty,
                  due_at: new Date(review.dueAt).toISOString(),
                  lapses: review.lapses,
                  repetitions: review.repetitions,
                  stability: review.stability,
                  state: review.state,
                }),
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "study-v2.answer.lesson-item",
              text: `UPDATE study_lesson_item_state_v2
                        SET presentation_count=$2, last_queue_ordinal=$3, mastered=$4,
                            lesson_resolved=$5, updated_at=$6::timestamptz
                      WHERE session_item_id=$1 AND presentation_count=$2-1`,
              values: [
                input.sessionItemId,
                input.attemptNumber,
                queueOrdinal,
                correct,
                spent,
                input.acceptedAt,
              ],
              readonly: false,
            });
            const remaining = yield* transaction.execute<Row>({
              label: "study-v2.answer.completion-check",
              text: `SELECT count(*) FILTER (WHERE NOT lesson_resolved)::bigint AS count,
                            count(*)::bigint AS total
                       FROM study_lesson_item_state_v2 WHERE session_id=$1`,
              values: [input.sessionId],
              readonly: false,
            });
            const remainingRow = remaining.rows[0] as Row;
            const nextPresentationCount = queueOrdinal + 1;
            const presentationCap = Math.min(20, 3 * integer(remainingRow, "total"));
            const complete =
              integer(remainingRow, "count") === 0 || nextPresentationCount >= presentationCap;
            if (complete) {
              const completed = yield* transaction.execute<Row>({
                label: "study-v2.answer.session-complete",
                text: `UPDATE study_sessions_v2 SET status='completed',
                        completed_at=$2::timestamptz, presentation_count=$3,
                        completion_reason=$4, current_session_item_id=NULL,
                        current_presented_at=NULL
                        WHERE session_id=$1 AND status='active'
                    RETURNING persona_id, community_id, post_id, audio_revision,
                              qualification_policy_revision, timezone,
                              ($2::timestamptz AT TIME ZONE timezone)::date AS streak_day`,
                values: [
                  input.sessionId,
                  input.acceptedAt,
                  nextPresentationCount,
                  integer(remainingRow, "count") === 0 ? "all_resolved" : "presentation_budget",
                ],
                readonly: false,
              });
              if (completed.rows.length === 1) {
                const progress = yield* transaction.execute<Row>({
                  label: "study-v2.answer.qualification-progress",
                  text: `SELECT count(*)::bigint AS exercise_count,
                                count(*) FILTER (WHERE EXISTS (
                                  SELECT 1 FROM study_attempts_v2 presented
                                   WHERE presented.session_item_id=item.session_item_id
                                ))::bigint AS presented_count,
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
                const presentedCount = integer(progressRow, "presented_count");
                const firstPassCorrect = integer(progressRow, "first_pass_correct");
                const requiredCorrect = Math.max(1, Math.ceil((7 * exerciseCount) / 10));
                if (presentedCount === exerciseCount && firstPassCorrect >= requiredCorrect) {
                  const terminal = completed.rows[0] as Row;
                  yield* transaction.execute({
                    label: "study-v2.answer.qualification-insert",
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
                      date(terminal.streak_day),
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
                    streakDay: date(terminal.streak_day),
                    timezone: text(terminal, "timezone"),
                  }).pipe(Effect.mapError(() => failed("constraint")));
                }
              }
            } else {
              const next = yield* transaction.execute<Row>({
                label: "study-v2.answer.next-item",
                text: `SELECT session_item_id
                         FROM study_lesson_item_state_v2
                        WHERE session_id=$1 AND NOT lesson_resolved
                     ORDER BY CASE WHEN presentation_count=0 THEN 0 ELSE 1 END,
                              last_queue_ordinal NULLS FIRST, original_ordinal
                        LIMIT 1`,
                values: [input.sessionId],
                readonly: false,
              });
              if (next.rows.length !== 1) return yield* Effect.fail(failed("invalid-row"));
              yield* transaction.execute({
                label: "study-v2.answer.session-advance",
                text: `UPDATE study_sessions_v2
                          SET current_session_item_id=$2, current_presented_at=$3::timestamptz,
                              presentation_count=$4
                        WHERE session_id=$1 AND status='active'`,
                values: [
                  input.sessionId,
                  text(next.rows[0] as Row, "session_item_id"),
                  input.acceptedAt,
                  nextPresentationCount,
                ],
                readonly: false,
              });
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
    loadSpokenAnswerContext: (input) => provide(repository.loadSpokenAnswerContext(input)),
    reserveSpokenAnswer: (input) => provide(repository.reserveSpokenAnswer(input)),
    failSpokenAnswer: (input) => provide(repository.failSpokenAnswer(input)),
    completeSpokenAnswer: (input) => provide(repository.completeSpokenAnswer(input)),
  };
};
