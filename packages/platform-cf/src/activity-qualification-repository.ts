import {
  ActivityQualificationRejected,
  ActivityQualificationStorageFailed,
  type ActivityQualificationStore,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type StudySessionSnapshotInput,
  type SubmitStudyAnswerInput,
} from "@pirate/application";
import {
  ActivityQualificationV1,
  type ActivityStreakLeaderboardV1 as ActivityStreakLeaderboardDocument,
  ActivityStreakLeaderboardEntryV1,
  ActivityStreakLeaderboardV1,
  type StudySessionV1 as StudySessionDocument,
  StudySessionV1,
} from "@pirate/contracts";
import {
  evaluateStudyQualification,
  gradeStudyAnswer,
  recomputeActivityStreak,
} from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (
  reason: ConstructorParameters<typeof ActivityQualificationStorageFailed>[0]["reason"],
): ActivityQualificationStorageFailed => new ActivityQualificationStorageFailed({ reason });

const rejected = (
  reason: ConstructorParameters<typeof ActivityQualificationRejected>[0]["reason"],
): ActivityQualificationRejected => new ActivityQualificationRejected({ reason });

const mapControlPlaneError = (error: ControlPlaneError): ActivityQualificationStorageFailed => {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return storage("constraint");
  }
  return storage("unavailable");
};

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
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

const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
};

const integer = (row: Row, key: string): number => {
  const value = row[key];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${key}`);
  return parsed;
};

const nullableInteger = (row: Row, key: string): number | null =>
  row[key] === null ? null : integer(row, key);

const iso = (value: unknown): string => {
  const instant = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid instant");
  return instant.toISOString();
};

const date = (value: unknown): string => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error("invalid date");
};

const nullableDate = (value: unknown): string | null => (value === null ? null : date(value));

const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
};

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const qualificationFromRow = (row: Row) =>
  decode(ActivityQualificationV1, {
    object: "activity_qualification",
    qualification_id: text(row, "qualification_id"),
    persona_id: text(row, "persona_id"),
    community_id: text(row, "community_id"),
    post_id: text(row, "post_id"),
    audio_revision: integer(row, "audio_revision"),
    activity: text(row, "activity_key"),
    attempt_ref:
      text(row, "activity_key") === "study"
        ? { kind: "study", session_id: text(row, "study_session_id") }
        : {
            kind: "karaoke",
            session_id: text(row, "karaoke_session_id"),
            attempt_id: text(row, "karaoke_attempt_id"),
          },
    score_bps: integer(row, "score_bps"),
    qualification_policy_version_id: text(row, "qualification_policy_version_id"),
    qualified_at: iso(row.qualified_at),
    reward_period_key: date(row.reward_period_key),
    streak_day: date(row.streak_day),
    evidence_summary: json(row.evidence_summary),
  });

const STUDY_SESSION_SELECT = `
  SELECT session_id, account_id, persona_id, community_id, post_id,
         audio_revision, lyrics_revision, source_revision,
         qualification_policy_version_id, idempotency_key, request_hash,
         timezone, status, qualifying_exercise_count, answered_exercise_count,
         first_pass_correct, required_correct, score_bps, streak_day,
         created_at, completed_at
    FROM study_sessions`;

const QUALIFICATION_SELECT = `
  SELECT qualification_id, persona_id, community_id, post_id, audio_revision,
         activity_key, study_session_id, karaoke_session_id, karaoke_attempt_id,
         score_bps, qualification_policy_version_id, qualified_at,
         reward_period_key, streak_day, evidence_summary
    FROM activity_qualifications`;

const readStudySessionIn = (
  transaction: ControlPlaneTransaction,
  input: { readonly accountId: string; readonly communityId: string; readonly sessionId: string },
  lock = false,
): Effect.Effect<
  StudySessionDocument | null,
  ActivityQualificationStorageFailed | ControlPlaneError
> =>
  Effect.gen(function* () {
    const sessionResult = yield* transaction.execute<Row>({
      label: "activity-qualification.study-session.read",
      text: `${STUDY_SESSION_SELECT}
              WHERE account_id=$1 AND community_id=$2 AND session_id=$3${lock ? " FOR UPDATE" : ""}`,
      values: [input.accountId, input.communityId, input.sessionId],
      readonly: !lock,
    });
    if (sessionResult.rows.length === 0) return null;
    if (sessionResult.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));
    const sessionRow = sessionResult.rows[0] as Row;
    const itemResult = yield* transaction.execute<Row>({
      label: "activity-qualification.study-session-items.read",
      text: `SELECT session_item_id, ordinal, source_item_key, prompt,
                    presentation_count, answer_count, first_pass_outcome
               FROM study_session_items
              WHERE session_id=$1 ORDER BY ordinal`,
      values: [input.sessionId],
      readonly: !lock,
    });
    const qualificationResult = yield* transaction.execute<Row>({
      label: "activity-qualification.study-qualification.read",
      text: `${QUALIFICATION_SELECT}
              WHERE activity_key='study' AND study_session_id=$1`,
      values: [input.sessionId],
      readonly: !lock,
    });
    if (qualificationResult.rows.length > 1) {
      return yield* Effect.fail(storage("invalid-row"));
    }
    return yield* Effect.try({
      try: () => {
        const session: unknown = {
          object: "study_session",
          session_id: text(sessionRow, "session_id"),
          persona_id: text(sessionRow, "persona_id"),
          community_id: text(sessionRow, "community_id"),
          post_id: text(sessionRow, "post_id"),
          audio_revision: integer(sessionRow, "audio_revision"),
          lyrics_revision: integer(sessionRow, "lyrics_revision"),
          source_revision: integer(sessionRow, "source_revision"),
          qualification_policy_version_id: text(sessionRow, "qualification_policy_version_id"),
          status: text(sessionRow, "status"),
          timezone: text(sessionRow, "timezone"),
          streak_day: nullableDate(sessionRow.streak_day),
          items: itemResult.rows.map((itemRow) => ({
            session_item_id: text(itemRow, "session_item_id"),
            ordinal: integer(itemRow, "ordinal"),
            source_identity: {
              community_id: text(sessionRow, "community_id"),
              post_id: text(sessionRow, "post_id"),
              audio_revision: integer(sessionRow, "audio_revision"),
              lyrics_revision: integer(sessionRow, "lyrics_revision"),
              source_revision: integer(sessionRow, "source_revision"),
              source_item_key: text(itemRow, "source_item_key"),
            },
            prompt: json(itemRow.prompt),
            presentation_count: integer(itemRow, "presentation_count"),
            answer_count: integer(itemRow, "answer_count"),
            first_pass_outcome: nullableText(itemRow, "first_pass_outcome"),
          })),
          progress: {
            qualifying_exercise_count: integer(sessionRow, "qualifying_exercise_count"),
            answered_exercise_count: integer(sessionRow, "answered_exercise_count"),
            first_pass_correct: integer(sessionRow, "first_pass_correct"),
            required_correct: integer(sessionRow, "required_correct"),
            score_bps: nullableInteger(sessionRow, "score_bps"),
          },
          qualification:
            qualificationResult.rows.length === 0
              ? null
              : qualificationFromRow(qualificationResult.rows[0] as Row),
          created_at: iso(sessionRow.created_at),
          completed_at: sessionRow.completed_at === null ? null : iso(sessionRow.completed_at),
        };
        return decode(StudySessionV1, session);
      },
      catch: () => storage("invalid-row"),
    });
  });

const advisoryLock = (
  transaction: ControlPlaneTransaction,
  namespace: number,
  parts: readonly string[],
  label: string,
) =>
  transaction.execute({
    label,
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
    values: [JSON.stringify(parts), namespace],
    readonly: false,
  });

const recomputeProjection = (
  transaction: ControlPlaneTransaction,
  input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly postId: string | null;
    readonly recomputedAt: string;
    readonly timezone: string;
  },
) =>
  Effect.gen(function* () {
    const song = input.postId !== null;
    const daysResult = yield* transaction.execute<Row>({
      label: song
        ? "activity-qualification.song-streak-days.read"
        : "activity-qualification.community-streak-days.read",
      text: song
        ? `SELECT streak_day FROM song_streak_days
            WHERE account_id=$1 AND community_id=$2 AND post_id=$3 ORDER BY streak_day`
        : `SELECT streak_day FROM community_streak_days
            WHERE account_id=$1 AND community_id=$2 ORDER BY streak_day`,
      values: song
        ? [input.accountId, input.communityId, input.postId]
        : [input.accountId, input.communityId],
      readonly: false,
    });
    const projection = yield* Effect.try({
      try: () =>
        recomputeActivityStreak(
          daysResult.rows.map((row) => date(row.streak_day)),
          input.timezone,
        ),
      catch: () => storage("invalid-row"),
    });
    if (projection === null) return;
    yield* transaction.execute({
      label: song
        ? "activity-qualification.song-streak.upsert"
        : "activity-qualification.community-streak.upsert",
      text: song
        ? `INSERT INTO song_streaks (
             account_id, community_id, post_id, current_count, best_count,
             started_day, last_day, total_days, active_until_at, recomputed_at
           ) VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9::timestamptz,$10::timestamptz)
           ON CONFLICT (account_id, post_id) DO UPDATE SET
             community_id=EXCLUDED.community_id,
             current_count=EXCLUDED.current_count,
             best_count=EXCLUDED.best_count,
             started_day=EXCLUDED.started_day,
             last_day=EXCLUDED.last_day,
             total_days=EXCLUDED.total_days,
             active_until_at=EXCLUDED.active_until_at,
             recomputed_at=EXCLUDED.recomputed_at`
        : `INSERT INTO community_streaks (
             account_id, community_id, current_count, best_count,
             started_day, last_day, total_days, active_until_at, recomputed_at
           ) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8::timestamptz,$9::timestamptz)
           ON CONFLICT (account_id, community_id) DO UPDATE SET
             current_count=EXCLUDED.current_count,
             best_count=EXCLUDED.best_count,
             started_day=EXCLUDED.started_day,
             last_day=EXCLUDED.last_day,
             total_days=EXCLUDED.total_days,
             active_until_at=EXCLUDED.active_until_at,
             recomputed_at=EXCLUDED.recomputed_at`,
      values: song
        ? [
            input.accountId,
            input.communityId,
            input.postId,
            projection.current,
            projection.best,
            projection.startedDay,
            projection.lastDay,
            projection.totalDays,
            projection.activeUntilAt,
            input.recomputedAt,
          ]
        : [
            input.accountId,
            input.communityId,
            projection.current,
            projection.best,
            projection.startedDay,
            projection.lastDay,
            projection.totalDays,
            projection.activeUntilAt,
            input.recomputedAt,
          ],
      readonly: false,
    });
  });

export const recordQualificationProjections = (
  transaction: ControlPlaneTransaction,
  input: {
    readonly accountId: string;
    readonly communityId: string;
    readonly personaId: string;
    readonly postId: string;
    readonly activity: "study" | "karaoke";
    readonly qualificationId: string;
    readonly qualifiedAt: string;
    readonly streakDay: string;
    readonly timezone: string;
  },
) =>
  Effect.gen(function* () {
    yield* transaction.execute({
      label: "activity-qualification.song-day.insert",
      text: `INSERT INTO song_streak_days (
               account_id, community_id, post_id, streak_day,
               first_qualification_id, earned_at
             ) VALUES ($1,$2,$3,$4::date,$5,$6::timestamptz)
             ON CONFLICT (account_id, post_id, streak_day) DO NOTHING`,
      values: [
        input.accountId,
        input.communityId,
        input.postId,
        input.streakDay,
        input.qualificationId,
        input.qualifiedAt,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "activity-qualification.song-day-activity.upsert",
      text: `INSERT INTO song_streak_day_activities (
               account_id, community_id, post_id, streak_day, activity_key,
               qualification_count, first_qualified_at, last_qualified_at,
               last_qualification_id
             ) VALUES ($1,$2,$3,$4::date,$5,1,$6::timestamptz,$6::timestamptz,$7)
             ON CONFLICT (account_id, post_id, streak_day, activity_key) DO UPDATE SET
               qualification_count=song_streak_day_activities.qualification_count + 1,
               last_qualified_at=greatest(
                 song_streak_day_activities.last_qualified_at,
                 EXCLUDED.last_qualified_at
               ),
               last_qualification_id=EXCLUDED.last_qualification_id`,
      values: [
        input.accountId,
        input.communityId,
        input.postId,
        input.streakDay,
        input.activity,
        input.qualifiedAt,
        input.qualificationId,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "activity-qualification.community-day.insert",
      text: `INSERT INTO community_streak_days (
               account_id, community_id, streak_day, first_qualification_id, earned_at
             ) VALUES ($1,$2,$3::date,$4,$5::timestamptz)
             ON CONFLICT (account_id, community_id, streak_day) DO NOTHING`,
      values: [
        input.accountId,
        input.communityId,
        input.streakDay,
        input.qualificationId,
        input.qualifiedAt,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "activity-qualification.presentation.default",
      text: `INSERT INTO persona_activity_presentations (
               community_id, account_id, persona_id, created_at, updated_at
             ) VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz)
             ON CONFLICT (community_id, account_id) DO NOTHING`,
      values: [input.communityId, input.accountId, input.personaId, input.qualifiedAt],
      readonly: false,
    });
    yield* recomputeProjection(transaction, {
      accountId: input.accountId,
      communityId: input.communityId,
      postId: input.postId,
      recomputedAt: input.qualifiedAt,
      timezone: input.timezone,
    });
    yield* recomputeProjection(transaction, {
      accountId: input.accountId,
      communityId: input.communityId,
      postId: null,
      recomputedAt: input.qualifiedAt,
      timezone: input.timezone,
    });
  });

const publicationRevision = (
  transaction: ControlPlaneTransaction,
  communityId: string,
  postId: string,
) =>
  transaction.execute<Row>({
    label: "activity-qualification.study-source-revision.read",
    text: `SELECT publication.audio_revision, publication.lyrics_revision
             FROM posts AS post
             JOIN media_publication_projections AS publication
               ON publication.community_id=post.community_id
              AND publication.post_id=post.post_id
            WHERE post.community_id=$1 AND post.post_id=$2
              AND post.post_type='song' AND post.status='published'
              AND post.visibility='public' AND publication.lyrics_status='ready'`,
    values: [communityId, postId],
    readonly: true,
  });

export function makeControlPlaneActivityQualificationRepository() {
  return {
    prepareStudySessionStart: (
      input: Parameters<ActivityQualificationStore["prepareStudySessionStart"]>[0],
    ) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const replay = yield* db.execute<Row>({
            label: "activity-qualification.study-start.replay",
            text: `${STUDY_SESSION_SELECT}
                    WHERE account_id=$1 AND persona_id=$2
                      AND endpoint_template='/communities/:communityId/posts/:postId/study/sessions'
                      AND idempotency_key=$3`,
            values: [input.accountId, input.personaId, input.idempotencyKey],
            readonly: true,
          });
          if (replay.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
          if (replay.rows.length === 1) {
            const replayRow = replay.rows[0] as Row;
            if (replayRow.request_hash !== input.requestHash) {
              return yield* Effect.fail(rejected("idempotency-conflict"));
            }
            const session = yield* readStudySessionIn(db, {
              accountId: input.accountId,
              communityId: input.communityId,
              sessionId: text(replayRow, "session_id"),
            });
            if (session === null) return yield* Effect.fail(storage("invalid-row"));
            return { kind: "replayed", session } as const;
          }

          const authority = yield* db.execute<Row>({
            label: "activity-qualification.study-start.authority",
            text: `SELECT active_owned_persona($1,$2) AS persona_eligible,
                          active_community_effect($3,$1) AS community_eligible,
                          clock.timezone
                     FROM users AS account
                     LEFT JOIN account_streak_clocks AS clock ON clock.account_id=account.user_id
                    WHERE account.user_id=$1 AND account.status='active'`,
            values: [input.accountId, input.personaId, input.communityId],
            readonly: true,
          });
          const authorityRow = authority.rows[0];
          if (authority.rows.length !== 1 || authorityRow === undefined) {
            return yield* Effect.fail(rejected("persona-ineligible"));
          }
          if (authorityRow.persona_eligible !== true || authorityRow.community_eligible !== true) {
            return yield* Effect.fail(rejected("persona-ineligible"));
          }
          const pinnedTimezone = nullableText(authorityRow, "timezone");
          if (
            pinnedTimezone !== null &&
            input.requestedTimezone !== null &&
            input.requestedTimezone !== pinnedTimezone
          ) {
            return yield* Effect.fail(rejected("invalid-input"));
          }
          const revision = yield* publicationRevision(db, input.communityId, input.postId);
          if (revision.rows.length === 0) {
            return yield* Effect.fail(rejected("song-unavailable"));
          }
          if (revision.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));
          const row = revision.rows[0] as Row;
          return {
            kind: "ready",
            audioRevision: integer(row, "audio_revision"),
            lyricsRevision: integer(row, "lyrics_revision"),
            timezone: pinnedTimezone ?? input.requestedTimezone ?? "UTC",
          } as const;
        }),
      ),

    createStudySession: (input: StudySessionSnapshotInput) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* advisoryLock(
                transaction,
                15100001,
                [input.accountId, input.personaId, input.idempotencyKey],
                "activity-qualification.study-start.lock",
              );
              const replay = yield* transaction.execute<Row>({
                label: "activity-qualification.study-start.replay-locked",
                text: `${STUDY_SESSION_SELECT}
                        WHERE account_id=$1 AND persona_id=$2
                          AND endpoint_template='/communities/:communityId/posts/:postId/study/sessions'
                          AND idempotency_key=$3`,
                values: [input.accountId, input.personaId, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
              if (replay.rows.length === 1) {
                const row = replay.rows[0] as Row;
                if (row.request_hash !== input.requestHash) {
                  return yield* Effect.fail(rejected("idempotency-conflict"));
                }
                const session = yield* readStudySessionIn(transaction, {
                  accountId: input.accountId,
                  communityId: input.communityId,
                  sessionId: text(row, "session_id"),
                });
                if (session === null) return yield* Effect.fail(storage("invalid-row"));
                return session;
              }

              const clock = yield* transaction.execute<Row>({
                label: "activity-qualification.study-start.clock",
                text: `SELECT timezone FROM account_streak_clocks
                        WHERE account_id=$1 FOR UPDATE`,
                values: [input.accountId],
                readonly: false,
              });
              if (clock.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
              if (clock.rows.length === 0) {
                yield* transaction.execute({
                  label: "activity-qualification.study-start.clock-pin",
                  text: `INSERT INTO account_streak_clocks (
                           account_id, timezone, timezone_updated_at, next_change_allowed_at
                         ) VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '7 days')`,
                  values: [input.accountId, input.timezone, input.createdAt],
                  readonly: false,
                });
              } else if (text(clock.rows[0] as Row, "timezone") !== input.timezone) {
                return yield* Effect.fail(rejected("invalid-input"));
              }

              const revision = yield* publicationRevision(
                transaction,
                input.communityId,
                input.postId,
              );
              const revisionRow = revision.rows[0];
              if (
                revision.rows.length !== 1 ||
                revisionRow === undefined ||
                integer(revisionRow, "audio_revision") !== input.audioRevision ||
                integer(revisionRow, "lyrics_revision") !== input.lyricsRevision
              ) {
                return yield* Effect.fail(rejected("source-unavailable"));
              }

              yield* transaction.execute({
                label: "activity-qualification.study-session.insert",
                text: `INSERT INTO study_sessions (
                         session_id, account_id, persona_id, community_id, post_id,
                         audio_revision, lyrics_revision, source_revision,
                         source_producer_id, source_producer_revision, source_snapshot_hash,
                         qualification_policy_version_id, idempotency_key, request_hash,
                         timezone, qualifying_exercise_count, required_correct, created_at
                       ) VALUES (
                         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::timestamptz
                       )`,
                values: [
                  input.sessionId,
                  input.accountId,
                  input.personaId,
                  input.communityId,
                  input.postId,
                  input.audioRevision,
                  input.lyricsRevision,
                  input.source.source_revision,
                  input.source.provenance.producer_id,
                  input.source.provenance.producer_revision,
                  input.sourceSnapshotHash,
                  input.qualificationPolicyVersionId,
                  input.idempotencyKey,
                  input.requestHash,
                  input.timezone,
                  input.source.items.length,
                  Math.max(1, Math.ceil((7 * input.source.items.length) / 10)),
                  input.createdAt,
                ],
                readonly: false,
              });
              for (const [ordinal, sourceItem] of input.source.items.entries()) {
                const itemId = input.itemIds[ordinal];
                if (itemId === undefined) return yield* Effect.fail(storage("invalid-row"));
                yield* transaction.execute({
                  label: "activity-qualification.study-session-item.insert",
                  text: `INSERT INTO study_session_items (
                           session_id, session_item_id, ordinal, source_item_key,
                           prompt, answer_key
                         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
                  values: [
                    input.sessionId,
                    itemId,
                    ordinal,
                    sourceItem.source_item_key,
                    JSON.stringify(sourceItem.prompt),
                    JSON.stringify(sourceItem.answer_key),
                  ],
                  readonly: false,
                });
              }
              if (input.itemIds.length !== input.source.items.length) {
                return yield* Effect.fail(storage("invalid-row"));
              }
              const session = yield* readStudySessionIn(transaction, {
                accountId: input.accountId,
                communityId: input.communityId,
                sessionId: input.sessionId,
              });
              if (session === null) return yield* Effect.fail(storage("invalid-row"));
              return session;
            }),
          );
        }),
      ),

    getStudySession: (input: Parameters<ActivityQualificationStore["getStudySession"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* readStudySessionIn(db, input);
        }),
      ),

    submitStudyAnswer: (input: SubmitStudyAnswerInput) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* advisoryLock(
                transaction,
                15100002,
                [input.accountId, input.sessionId],
                "activity-qualification.study-answer.lock",
              );
              const replay = yield* transaction.execute<Row>({
                label: "activity-qualification.study-answer.replay",
                text: `SELECT answer_id, session_item_id, attempt_number, request_hash,
                              outcome, first_pass
                         FROM study_session_answers
                        WHERE session_id=$1 AND idempotency_key=$2`,
                values: [input.sessionId, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
              if (replay.rows.length === 1) {
                const row = replay.rows[0] as Row;
                if (row.request_hash !== input.requestHash) {
                  return yield* Effect.fail(rejected("idempotency-conflict"));
                }
                const session = yield* readStudySessionIn(transaction, {
                  accountId: input.accountId,
                  communityId: input.communityId,
                  sessionId: input.sessionId,
                });
                if (session === null) return yield* Effect.fail(storage("invalid-row"));
                return {
                  object: "study_answer_result",
                  session_item_id: text(row, "session_item_id"),
                  attempt_number: integer(row, "attempt_number"),
                  outcome: text(row, "outcome") as "correct" | "incorrect",
                  first_pass: row.first_pass === true,
                  session,
                } as const;
              }

              const session = yield* readStudySessionIn(
                transaction,
                {
                  accountId: input.accountId,
                  communityId: input.communityId,
                  sessionId: input.sessionId,
                },
                true,
              );
              if (session === null) return yield* Effect.fail(rejected("not-found"));
              if (session.status !== "active") {
                return yield* Effect.fail(rejected("attempt-conflict"));
              }
              const itemResult = yield* transaction.execute<Row>({
                label: "activity-qualification.study-answer.item",
                text: `SELECT prompt, answer_key, answer_count, first_pass_outcome
                         FROM study_session_items
                        WHERE session_id=$1 AND session_item_id=$2 FOR UPDATE`,
                values: [input.sessionId, input.sessionItemId],
                readonly: false,
              });
              if (itemResult.rows.length === 0) return yield* Effect.fail(rejected("not-found"));
              if (itemResult.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));
              const itemRow = itemResult.rows[0] as Row;
              const answerCount = integer(itemRow, "answer_count");
              if (input.attemptNumber !== answerCount + 1) {
                return yield* Effect.fail(rejected("attempt-conflict"));
              }
              const answer =
                input.answer.kind === "single_select"
                  ? { kind: "single_select" as const, choiceKey: input.answer.choice_key }
                  : input.answer;
              const answerKeyValue = json(itemRow.answer_key) as {
                readonly kind?: unknown;
                readonly accepted_answers?: unknown;
                readonly correct_choice_key?: unknown;
              };
              const answerKey =
                answerKeyValue.kind === "single_select" &&
                typeof answerKeyValue.correct_choice_key === "string"
                  ? {
                      kind: "single_select" as const,
                      correctChoiceKey: answerKeyValue.correct_choice_key,
                    }
                  : answerKeyValue.kind === "text_response" &&
                      Array.isArray(answerKeyValue.accepted_answers) &&
                      answerKeyValue.accepted_answers.every(
                        (candidate) => typeof candidate === "string",
                      ) &&
                      answerKeyValue.accepted_answers.length > 0
                    ? {
                        kind: "text_response" as const,
                        comparison: "unicode_casefold_whitespace_v1" as const,
                        acceptedAnswers: answerKeyValue.accepted_answers as [string, ...string[]],
                      }
                    : null;
              if (answerKey === null) return yield* Effect.fail(storage("invalid-row"));
              const correct = yield* Effect.try({
                try: () => gradeStudyAnswer(answer, answerKey),
                catch: () => storage("invalid-row"),
              });
              const outcome = correct ? "correct" : "incorrect";
              const firstPass = input.attemptNumber === 1;
              yield* transaction.execute({
                label: "activity-qualification.study-answer.insert",
                text: `INSERT INTO study_session_answers (
                         answer_id, session_id, session_item_id, attempt_number,
                         idempotency_key, request_hash, answer, outcome, first_pass, answered_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::timestamptz)`,
                values: [
                  input.answerId,
                  input.sessionId,
                  input.sessionItemId,
                  input.attemptNumber,
                  input.idempotencyKey,
                  input.requestHash,
                  JSON.stringify(input.answer),
                  outcome,
                  firstPass,
                  input.answeredAt,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "activity-qualification.study-item.advance",
                text: `UPDATE study_session_items
                          SET answer_count=answer_count + 1,
                              first_pass_outcome=coalesce(first_pass_outcome,$3)
                        WHERE session_id=$1 AND session_item_id=$2`,
                values: [input.sessionId, input.sessionItemId, outcome],
                readonly: false,
              });

              const completionRows = yield* transaction.execute<Row>({
                label: "activity-qualification.study-completion-evidence.read",
                text: `SELECT presentation_count, first_pass_outcome
                         FROM study_session_items WHERE session_id=$1 ORDER BY ordinal`,
                values: [input.sessionId],
                readonly: false,
              });
              const complete = completionRows.rows.every(
                (row) => nullableText(row, "first_pass_outcome") !== null,
              );
              if (complete) {
                const evaluation = yield* Effect.try({
                  try: () =>
                    evaluateStudyQualification(
                      completionRows.rows.map((row) => ({
                        presentationCount: integer(row, "presentation_count"),
                        firstPassOutcome: nullableText(row, "first_pass_outcome") as
                          | "correct"
                          | "incorrect",
                      })),
                    ),
                  catch: () => storage("invalid-row"),
                });
                const terminal = yield* transaction.execute<Row>({
                  label: "activity-qualification.study-session.complete",
                  text: `UPDATE study_sessions
                            SET status='completed', answered_exercise_count=$2,
                                first_pass_correct=$3, score_bps=$4,
                                streak_day=($5::timestamptz AT TIME ZONE timezone)::date,
                                completed_at=$5::timestamptz
                          WHERE session_id=$1
                      RETURNING persona_id, community_id, post_id, audio_revision,
                                qualification_policy_version_id, timezone, streak_day`,
                  values: [
                    input.sessionId,
                    evaluation.qualifyingExerciseCount,
                    evaluation.firstPassCorrect,
                    evaluation.scoreBps,
                    input.answeredAt,
                  ],
                  readonly: false,
                });
                if (terminal.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));
                if (evaluation.qualifies) {
                  const terminalRow = terminal.rows[0] as Row;
                  const streakDay = date(terminalRow.streak_day);
                  yield* transaction.execute({
                    label: "activity-qualification.study-qualification.insert",
                    text: `INSERT INTO activity_qualifications (
                             qualification_id, account_id, persona_id, community_id, post_id,
                             audio_revision, activity_key, study_session_id, score_bps,
                             qualification_policy_version_id, qualified_at, streak_day,
                             evidence_summary, created_at
                           ) VALUES (
                             $1,$2,$3,$4,$5,$6,'study',$7,$8,$9,$10::timestamptz,$11::date,
                             $12::jsonb,$10::timestamptz
                           )`,
                    values: [
                      input.qualificationId,
                      input.accountId,
                      text(terminalRow, "persona_id"),
                      text(terminalRow, "community_id"),
                      text(terminalRow, "post_id"),
                      integer(terminalRow, "audio_revision"),
                      input.sessionId,
                      evaluation.scoreBps,
                      text(terminalRow, "qualification_policy_version_id"),
                      input.answeredAt,
                      streakDay,
                      JSON.stringify({
                        kind: "study_session_first_pass_v2",
                        qualifying_exercise_count: evaluation.qualifyingExerciseCount,
                        first_pass_correct: evaluation.firstPassCorrect,
                        required_correct: evaluation.requiredCorrect,
                      }),
                    ],
                    readonly: false,
                  });
                  yield* recordQualificationProjections(transaction, {
                    accountId: input.accountId,
                    communityId: text(terminalRow, "community_id"),
                    personaId: text(terminalRow, "persona_id"),
                    postId: text(terminalRow, "post_id"),
                    activity: "study",
                    qualificationId: input.qualificationId,
                    qualifiedAt: input.answeredAt,
                    streakDay,
                    timezone: text(terminalRow, "timezone"),
                  });
                }
              }
              const updated = yield* readStudySessionIn(transaction, {
                accountId: input.accountId,
                communityId: input.communityId,
                sessionId: input.sessionId,
              });
              if (updated === null) return yield* Effect.fail(storage("invalid-row"));
              return {
                object: "study_answer_result",
                session_item_id: input.sessionItemId,
                attempt_number: input.attemptNumber,
                outcome,
                first_pass: firstPass,
                session: updated,
              } as const;
            }),
          );
        }),
      ),

    setStreakTimezone: (input: Parameters<ActivityQualificationStore["setStreakTimezone"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* advisoryLock(
                transaction,
                15100003,
                [input.accountId, "/rewards/streak-timezone", input.idempotencyKey],
                "activity-qualification.streak-timezone.lock",
              );
              const replay = yield* transaction.execute<Row>({
                label: "activity-qualification.streak-timezone.replay",
                text: `SELECT request_hash, result_timezone,
                              result_timezone_updated_at, result_next_change_allowed_at
                         FROM account_streak_timezone_actions
                        WHERE account_id=$1 AND endpoint_template='/rewards/streak-timezone'
                          AND idempotency_key=$2`,
                values: [input.accountId, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
              if (replay.rows.length === 1) {
                const row = replay.rows[0] as Row;
                if (row.request_hash !== input.requestHash) {
                  return yield* Effect.fail(rejected("idempotency-conflict"));
                }
                return {
                  object: "account_streak_clock",
                  timezone: text(row, "result_timezone"),
                  timezone_updated_at: iso(row.result_timezone_updated_at),
                  next_change_allowed_at: iso(row.result_next_change_allowed_at),
                } as const;
              }
              const current = yield* transaction.execute<Row>({
                label: "activity-qualification.streak-timezone.current",
                text: `SELECT timezone, timezone_updated_at, next_change_allowed_at
                         FROM account_streak_clocks WHERE account_id=$1 FOR UPDATE`,
                values: [input.accountId],
                readonly: false,
              });
              if (current.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
              let timezoneUpdatedAt = input.updatedAt;
              let nextChangeAllowedAt = new Date(
                Date.parse(input.updatedAt) + 7 * 86_400_000,
              ).toISOString();
              if (current.rows.length === 0) {
                yield* transaction.execute({
                  label: "activity-qualification.streak-timezone.insert",
                  text: `INSERT INTO account_streak_clocks (
                           account_id, timezone, timezone_updated_at, next_change_allowed_at
                         ) VALUES ($1,$2,$3::timestamptz,$4::timestamptz)`,
                  values: [input.accountId, input.timezone, timezoneUpdatedAt, nextChangeAllowedAt],
                  readonly: false,
                });
              } else {
                const row = current.rows[0] as Row;
                if (text(row, "timezone") === input.timezone) {
                  timezoneUpdatedAt = iso(row.timezone_updated_at);
                  nextChangeAllowedAt = iso(row.next_change_allowed_at);
                } else {
                  if (Date.parse(input.updatedAt) < Date.parse(iso(row.next_change_allowed_at))) {
                    return yield* Effect.fail(rejected("timezone-change-too-soon"));
                  }
                  yield* transaction.execute({
                    label: "activity-qualification.streak-timezone.update",
                    text: `UPDATE account_streak_clocks
                              SET timezone=$2, timezone_updated_at=$3::timestamptz,
                                  next_change_allowed_at=$4::timestamptz
                            WHERE account_id=$1`,
                    values: [
                      input.accountId,
                      input.timezone,
                      timezoneUpdatedAt,
                      nextChangeAllowedAt,
                    ],
                    readonly: false,
                  });
                  const songs = yield* transaction.execute<Row>({
                    label: "activity-qualification.streak-timezone.songs",
                    text: `SELECT DISTINCT community_id, post_id FROM song_streak_days
                            WHERE account_id=$1`,
                    values: [input.accountId],
                    readonly: false,
                  });
                  for (const song of songs.rows) {
                    yield* recomputeProjection(transaction, {
                      accountId: input.accountId,
                      communityId: text(song, "community_id"),
                      postId: text(song, "post_id"),
                      recomputedAt: input.updatedAt,
                      timezone: input.timezone,
                    });
                  }
                  const communities = yield* transaction.execute<Row>({
                    label: "activity-qualification.streak-timezone.communities",
                    text: `SELECT DISTINCT community_id FROM community_streak_days
                            WHERE account_id=$1`,
                    values: [input.accountId],
                    readonly: false,
                  });
                  for (const community of communities.rows) {
                    yield* recomputeProjection(transaction, {
                      accountId: input.accountId,
                      communityId: text(community, "community_id"),
                      postId: null,
                      recomputedAt: input.updatedAt,
                      timezone: input.timezone,
                    });
                  }
                }
              }
              yield* transaction.execute({
                label: "activity-qualification.streak-timezone.action",
                text: `INSERT INTO account_streak_timezone_actions (
                         account_id, idempotency_key, request_hash, result_timezone,
                         result_timezone_updated_at, result_next_change_allowed_at
                       ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)`,
                values: [
                  input.accountId,
                  input.idempotencyKey,
                  input.requestHash,
                  input.timezone,
                  timezoneUpdatedAt,
                  nextChangeAllowedAt,
                ],
                readonly: false,
              });
              return {
                object: "account_streak_clock",
                timezone: input.timezone,
                timezone_updated_at: timezoneUpdatedAt,
                next_change_allowed_at: nextChangeAllowedAt,
              } as const;
            }),
          );
        }),
      ),

    setPresentationPersona: (
      input: Parameters<ActivityQualificationStore["setPresentationPersona"]>[0],
    ) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              yield* advisoryLock(
                transaction,
                15100004,
                [input.accountId, input.communityId, input.idempotencyKey],
                "activity-qualification.presentation.lock",
              );
              const replay = yield* transaction.execute<Row>({
                label: "activity-qualification.presentation.replay",
                text: `SELECT request_hash, result_persona_id, result_updated_at
                         FROM persona_activity_presentation_actions
                        WHERE account_id=$1 AND community_id=$2
                          AND endpoint_template='/communities/:communityId/rewards/presentation-persona'
                          AND idempotency_key=$3`,
                values: [input.accountId, input.communityId, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows.length > 1) return yield* Effect.fail(storage("invalid-row"));
              if (replay.rows.length === 1) {
                const row = replay.rows[0] as Row;
                if (row.request_hash !== input.requestHash) {
                  return yield* Effect.fail(rejected("idempotency-conflict"));
                }
                return {
                  object: "activity_presentation",
                  community_id: input.communityId,
                  persona_id: text(row, "result_persona_id"),
                  updated_at: iso(row.result_updated_at),
                } as const;
              }
              const eligible = yield* transaction.execute<Row>({
                label: "activity-qualification.presentation.authority",
                text: `SELECT active_owned_persona($1,$2) AS persona_eligible,
                              active_community_effect($3,$1) AS community_eligible`,
                values: [input.accountId, input.personaId, input.communityId],
                readonly: false,
              });
              const row = eligible.rows[0];
              if (
                eligible.rows.length !== 1 ||
                row === undefined ||
                row.persona_eligible !== true ||
                row.community_eligible !== true
              ) {
                return yield* Effect.fail(rejected("persona-ineligible"));
              }
              yield* transaction.execute({
                label: "activity-qualification.presentation.upsert",
                text: `INSERT INTO persona_activity_presentations (
                         community_id, account_id, persona_id, created_at, updated_at
                       ) VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz)
                       ON CONFLICT (community_id, account_id) DO UPDATE SET
                         persona_id=EXCLUDED.persona_id,
                         updated_at=EXCLUDED.updated_at`,
                values: [input.communityId, input.accountId, input.personaId, input.updatedAt],
                readonly: false,
              });
              yield* transaction.execute({
                label: "activity-qualification.presentation.action",
                text: `INSERT INTO persona_activity_presentation_actions (
                         account_id, community_id, idempotency_key, request_hash,
                         result_persona_id, result_updated_at
                       ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz)`,
                values: [
                  input.accountId,
                  input.communityId,
                  input.idempotencyKey,
                  input.requestHash,
                  input.personaId,
                  input.updatedAt,
                ],
                readonly: false,
              });
              return {
                object: "activity_presentation",
                community_id: input.communityId,
                persona_id: input.personaId,
                updated_at: input.updatedAt,
              } as const;
            }),
          );
        }),
      ),

    getSongLeaderboard: (input: Parameters<ActivityQualificationStore["getSongLeaderboard"]>[0]) =>
      leaderboard(input, input.postId),
    getCommunityLeaderboard: (
      input: Parameters<ActivityQualificationStore["getCommunityLeaderboard"]>[0],
    ) => leaderboard(input, null),
  };
}

const leaderboard = (
  input: {
    readonly accountId: string | null;
    readonly communityId: string;
    readonly limit: number;
    readonly readAt: string;
  },
  postId: string | null,
): Effect.Effect<
  ActivityStreakLeaderboardDocument,
  ActivityQualificationRejected | ActivityQualificationStorageFailed,
  ControlPlaneDb
> =>
  mapped(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const exists = yield* db.execute<Row>({
        label: "activity-qualification.leaderboard.scope",
        text:
          postId === null
            ? "SELECT 1 AS found FROM communities WHERE community_id=$1 AND status='active'"
            : `SELECT 1 AS found FROM posts
                WHERE community_id=$1 AND post_id=$2 AND post_type='song'
                  AND status='published' AND visibility='public'`,
        values: postId === null ? [input.communityId] : [input.communityId, postId],
        readonly: true,
      });
      if (exists.rows.length === 0) return yield* Effect.fail(rejected("not-found"));
      if (exists.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));

      const rows = yield* db.execute<Row>({
        label: "activity-qualification.leaderboard.read",
        text: `WITH ranked AS (
                 SELECT streak.account_id, streak.current_count, streak.best_count,
                        streak.started_day, streak.last_day, streak.total_days,
                        presentation.persona_id,
                        row_number() OVER (
                          ORDER BY streak.current_count DESC, streak.best_count DESC,
                                   streak.started_day, presentation.persona_id
                        ) AS rank
                   FROM ${postId === null ? "community_streaks" : "song_streaks"} AS streak
                   JOIN persona_activity_presentations AS presentation
                     ON presentation.community_id=streak.community_id
                    AND presentation.account_id=streak.account_id
                  WHERE streak.community_id=$1
                    ${postId === null ? "" : "AND streak.post_id=$2"}
                    AND streak.active_until_at > $${postId === null ? "2" : "3"}::timestamptz
               )
               SELECT ranked.*, profile.display_name, profile.avatar_ref,
                      handle.label_display AS primary_public_handle
                 FROM ranked
                 JOIN personas AS persona ON persona.persona_id=ranked.persona_id
                                      AND persona.account_id=ranked.account_id
                                      AND persona.status='active'
                 JOIN persona_profiles AS profile ON profile.persona_id=ranked.persona_id
                 LEFT JOIN LATERAL (
                   SELECT candidate.label_display
                     FROM public_handle_index AS candidate
                    WHERE candidate.owner_persona_id=ranked.persona_id
                      AND candidate.status='active'
                    ORDER BY candidate.updated_at DESC, candidate.handle_id
                    LIMIT 1
                 ) AS handle ON true
                WHERE ranked.rank <= $${postId === null ? "3" : "4"}
                   OR ranked.account_id=$${postId === null ? "4" : "5"}
                ORDER BY ranked.rank`,
        values:
          postId === null
            ? [input.communityId, input.readAt, input.limit, input.accountId]
            : [input.communityId, postId, input.readAt, input.limit, input.accountId],
        readonly: true,
      });
      const entriesByRank = yield* Effect.try({
        try: () =>
          rows.rows.map((row) =>
            decode(ActivityStreakLeaderboardEntryV1, {
              rank: integer(row, "rank"),
              current: integer(row, "current_count"),
              best: integer(row, "best_count"),
              started_day: date(row.started_day),
              last_day: date(row.last_day),
              total_days: integer(row, "total_days"),
              persona: {
                persona_id: text(row, "persona_id"),
                object: "persona",
                display_name: nullableText(row, "display_name"),
                avatar_ref: nullableText(row, "avatar_ref"),
                primary_public_handle: nullableText(row, "primary_public_handle"),
              },
              is_viewer: input.accountId !== null && row.account_id === input.accountId,
            }),
          ) as readonly ActivityStreakLeaderboardEntryV1[],
        catch: () => storage("invalid-row"),
      });
      const document = {
        object: "activity_streak_leaderboard" as const,
        scope:
          postId === null
            ? { kind: "community" as const, community_id: input.communityId }
            : { kind: "song" as const, community_id: input.communityId, post_id: postId },
        day_semantics: "account_pinned_iana_timezone_v1" as const,
        entries: entriesByRank.filter(({ rank }) => rank <= input.limit),
        viewer_standing: entriesByRank.find(({ is_viewer }) => is_viewer) ?? null,
      };
      return yield* Effect.try({
        try: () => decode(ActivityStreakLeaderboardV1, document),
        catch: () => storage("invalid-row"),
      });
    }),
  );

export function makeControlPlaneActivityQualificationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): ActivityQualificationStore {
  const repository = makeControlPlaneActivityQualificationRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(runtime)(effect));
  return {
    prepareStudySessionStart: (input) => provide(repository.prepareStudySessionStart(input)),
    createStudySession: (input: StudySessionSnapshotInput) =>
      provide(repository.createStudySession(input)),
    getStudySession: (input) => provide(repository.getStudySession(input)),
    submitStudyAnswer: (input: SubmitStudyAnswerInput) =>
      provide(repository.submitStudyAnswer(input)),
    setStreakTimezone: (input) => provide(repository.setStreakTimezone(input)),
    setPresentationPersona: (input) => provide(repository.setPresentationPersona(input)),
    getSongLeaderboard: (input) => provide(repository.getSongLeaderboard(input)),
    getCommunityLeaderboard: (input) => provide(repository.getCommunityLeaderboard(input)),
  };
}
